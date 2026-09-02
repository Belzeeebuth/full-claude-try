import { DateTime } from 'luxon';
import { balance as getBalance } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import type { Currency } from '../repositories/economy.repo';
import * as ledgerRepo from '../repositories/ledger.repo';
import type {
  CheckpointRef,
  CheckpointSummary,
  LedgerCheckpointInsert,
} from '../repositories/ledger.repo';
import * as systemRepo from '../repositories/system.repo';
import { toError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('ledger');

/**
 * Rétention du journal comptable par soldes d'ouverture.
 *
 * L'invariant du projet — « solde = somme des écritures » — interdisait toute
 * suppression dans `transactions` : l'audit sommait depuis l'origine. Ce
 * service le reformule sans l'affaiblir :
 *
 *   solde = ouverture(dernier checkpoint) + Σ écritures d'id > borne du checkpoint
 *
 * Un checkpoint est une COMPRESSION du journal : son ouverture est calculée à
 * partir du checkpoint précédent et des écritures intermédiaires, jamais
 * recopiée depuis `users`. Il est ensuite confronté au solde réel, sous verrou
 * de la ligne joueur ; l'écart éventuel est mémorisé et bloque la purge de ce
 * joueur. La purge ne supprime que des écritures couvertes par un checkpoint
 * plus ancien que la rétention, et seulement si le dernier checkpoint du
 * joueur est sain : à tout instant, avant, pendant et après, l'audit horaire
 * (`findLedgerMismatches`) et la vue `ledger_integrity` restent exacts.
 *
 * Les fonctions pures de ce fichier (périodes, coupure, ouverture, écart,
 * borne de purge) sont la SPÉCIFICATION que le SQL de `ledger.repo.ts`
 * implémente ; elles sont testées sans base dans `tests/ledger-checkpoint.test.ts`.
 */

export type { CheckpointRef, CheckpointSummary } from '../repositories/ledger.repo';

// ---------------------------------------------------------------------------
// Périodes et coupure — pur
// ---------------------------------------------------------------------------

/** Date SQL `yyyy-MM-dd`, en UTC comme toutes les colonnes `date` du projet. */
function sqlDate(dt: DateTime): string {
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * Premier jour de la période comptable qui contient `now` : le jour
 * `checkpointDay` du mois courant, ou du mois précédent si ce jour n'est pas
 * encore arrivé. Le jour est borné à 28 par la configuration pour exister dans
 * tous les mois — février compris.
 */
export function periodStartFor(now: Date, checkpointDay: number): string {
  const dt = DateTime.fromJSDate(now, { zone: 'utc' });
  const anchored = dt.day >= checkpointDay ? dt : dt.minus({ months: 1 });
  return sqlDate(anchored.set({ day: checkpointDay }));
}

/** Ce qu'une purge doit respecter : une période ET un instant, tous deux dépassés. */
export interface LedgerCutoff {
  /** Période la plus récente dont le checkpoint peut borner une purge (`yyyy-MM-dd`). */
  period: string;
  /** Instant avant lequel ce checkpoint doit avoir été calculé. */
  instant: Date;
}

/**
 * Coupure de rétention : `retentionMonths` mois calendaires avant `now`.
 *
 * Deux conditions plutôt qu'une, à dessein. La période seule ne suffit pas :
 * un checkpoint est étiqueté du premier jour de sa période mais peut avoir été
 * calculé plus tard (rattrapage manuel, joueur créé en cours de mois), et sa
 * borne couvrirait alors des écritures plus jeunes que la rétention. L'instant
 * garantit que TOUTE écriture purgée a au moins l'âge promis.
 */
export function retentionCutoff(
  now: Date,
  retentionMonths: number,
  checkpointDay: number,
): LedgerCutoff {
  const instant = DateTime.fromJSDate(now, { zone: 'utc' })
    .minus({ months: retentionMonths })
    .toJSDate();
  return { period: periodStartFor(instant, checkpointDay), instant };
}

// ---------------------------------------------------------------------------
// Solde attendu, ouverture, écart — pur
// ---------------------------------------------------------------------------

/**
 * Solde que le journal prédit : l'ouverture du checkpoint plus les écritures
 * postérieures à sa borne. Sans checkpoint, l'ouverture vaut zéro et
 * `sumAfter` est la somme depuis l'origine — exactement l'audit historique,
 * qui reste donc le comportement d'un joueur jamais figé.
 */
export function expectedBalance(checkpoint: CheckpointRef | undefined, sumAfter: number): number {
  return (checkpoint?.openingBalance ?? 0) + sumAfter;
}

/**
 * Checkpoint suivant : l'ouverture est le solde attendu au vu du journal, et
 * la borne avance jusqu'à la dernière écriture sommée. Sans écriture nouvelle
 * (`lastId` nul), la borne ne recule jamais : un mois d'inactivité ne
 * « décompte » pas des écritures déjà comptées.
 */
export function nextCheckpoint(
  previous: CheckpointRef | undefined,
  delta: { sum: number; lastId: number | null },
): CheckpointRef {
  return {
    openingBalance: expectedBalance(previous, delta.sum),
    transactionsThrough: Math.max(previous?.transactionsThrough ?? 0, delta.lastId ?? 0),
  };
}

/** Écart solde réel − solde attendu : zéro dans tout état sain. */
export function driftOf(balance: number, expected: number): number {
  return balance - expected;
}

// ---------------------------------------------------------------------------
// Sélection de la borne de purge — pur
// ---------------------------------------------------------------------------

function newest<T extends { periodStart: string }>(entries: readonly T[]): T | undefined {
  // `yyyy-MM-dd` se compare lexicographiquement comme chronologiquement.
  return entries.reduce<T | undefined>(
    (best, entry) => (best === undefined || entry.periodStart > best.periodStart ? entry : best),
    undefined,
  );
}

/**
 * Checkpoint qui borne la purge d'un couple (joueur, monnaie), ou `null` si
 * rien ne doit être supprimé.
 *
 * Deux refus, et pas un de plus :
 *  - le DERNIER checkpoint porte une dérive : le journal et le solde ne se
 *    parlent plus, on ne détruit aucune pièce du puzzle tant que ce n'est pas
 *    élucidé — l'audit horaire continue de le signaler ;
 *  - aucun checkpoint n'est à la fois d'une période sous la coupure et calculé
 *    avant l'instant de coupure : rien n'a encore l'âge de la rétention.
 *
 * Sinon la borne est le PLUS RÉCENT des checkpoints éligibles : c'est lui qui
 * couvre le plus d'écritures purgeables tout en laissant, au-delà de sa borne,
 * la totalité de la fenêtre de rétention.
 */
export function purgeBoundary(
  checkpoints: readonly CheckpointSummary[],
  cutoff: LedgerCutoff,
): CheckpointSummary | null {
  const latest = newest(checkpoints);
  if (!latest || latest.drift !== 0) return null;
  const eligible = checkpoints.filter(
    (entry) =>
      entry.periodStart <= cutoff.period &&
      entry.computedAt.getTime() <= cutoff.instant.getTime(),
  );
  return newest(eligible) ?? null;
}

// ---------------------------------------------------------------------------
// Job mensuel : figer les soldes d'ouverture
// ---------------------------------------------------------------------------

/**
 * Joueurs par transaction. Chaque lot verrouille ses lignes `users` le temps
 * d'une agrégation bornée : assez grand pour ne pas multiplier les
 * transactions, assez petit pour qu'un joueur bloqué derrière le lot ne le
 * sente pas — et pour qu'un interblocage avec une action à deux joueurs
 * (enchère, don) ne coûte qu'un lot, rejoué au passage suivant.
 */
export const CHECKPOINT_BATCH_SIZE = 100;

/** Au-delà, l'échec est systémique (SQL, base) : on s'arrête et le job est marqué en échec. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface CheckpointRunResult {
  periodStart: string;
  /** Checkpoints réellement insérés (les deux monnaies comptent séparément). */
  written: number;
  /** Écarts constatés entre journal et solde, déjà journalisés dans l'audit. */
  drifts: number;
  failedBatches: number;
}

/**
 * Fige, pour chaque joueur vivant sans checkpoint sur la période, le solde
 * d'ouverture des deux monnaies. Idempotent : les joueurs déjà figés ne sont
 * pas resélectionnés, et l'insertion ignore les conflits.
 *
 * Le verrou de ligne est ce qui rend la vérification finale exacte : sous
 * `FOR UPDATE`, aucune écriture ne peut s'intercaler entre l'agrégation et la
 * lecture du solde, donc « joueur sans écriture postérieure » est vrai de tout
 * le lot et `opening_balance` DOIT égaler `users.<monnaie>`. Un écart est un
 * bug ou une manipulation directe de la base : il est mémorisé sur le
 * checkpoint, journalisé en `ledger_mismatch`, et interdit la purge du joueur.
 */
export async function checkpointLedger(now: Date = new Date()): Promise<CheckpointRunResult> {
  const { checkpointDay } = getBalance().economy.ledger;
  const periodStart = periodStartFor(now, checkpointDay);

  let written = 0;
  let drifts = 0;
  let failedBatches = 0;
  let consecutiveFailures = 0;
  let after: string | undefined;

  for (;;) {
    const userIds = await ledgerRepo.listUsersWithoutCheckpoint(
      periodStart,
      after,
      CHECKPOINT_BATCH_SIZE,
    );
    if (userIds.length === 0) break;
    // Identifiants déjà triés par la requête : verrouiller dans cet ordre est
    // ce qui évite l'interblocage avec `lockUserRows`, qui trie aussi.
    after = userIds.at(-1);

    try {
      const batch = await withTransaction(async (tx) => {
        const balances = new Map<string, { coins: number; gems: number }>();
        for (const userId of userIds) {
          const locked = await lockUserRow(tx, userId);
          if (locked) balances.set(userId, { coins: locked.coins, gems: locked.gems });
        }

        const aggregates = await ledgerRepo.aggregateSinceCheckpoint(
          [...balances.keys()],
          periodStart,
          tx,
        );

        const rows: LedgerCheckpointInsert[] = [];
        const mismatches: Array<{
          userId: string;
          currency: Currency;
          balance: number;
          expected: number;
          drift: number;
        }> = [];

        for (const aggregate of aggregates) {
          const locked = balances.get(aggregate.userId);
          if (!locked) continue;
          const next = nextCheckpoint(aggregate.previous, {
            sum: aggregate.delta,
            lastId: aggregate.lastId,
          });
          const balance = aggregate.currency === 'coins' ? locked.coins : locked.gems;
          const drift = driftOf(balance, next.openingBalance);
          rows.push({
            userId: aggregate.userId,
            currency: aggregate.currency,
            periodStart,
            openingBalance: next.openingBalance,
            transactionsThrough: next.transactionsThrough,
            drift,
          });
          if (drift !== 0) {
            mismatches.push({
              userId: aggregate.userId,
              currency: aggregate.currency,
              balance,
              expected: next.openingBalance,
              drift,
            });
          }
        }

        const inserted = await ledgerRepo.insertCheckpoints(rows, tx);
        for (const mismatch of mismatches) {
          await systemRepo.audit(
            {
              action: 'ledger_mismatch',
              targetType: 'user',
              targetId: mismatch.userId,
              payload: { ...mismatch, periodStart, source: 'ledger:checkpoint' },
              severity: 'error',
            },
            tx,
          );
        }
        return { inserted, mismatches: mismatches.length };
      });

      written += batch.inserted;
      drifts += batch.mismatches;
      consecutiveFailures = 0;
    } catch (error) {
      failedBatches += 1;
      consecutiveFailures += 1;
      log.error(
        { err: toError(error), periodStart, from: userIds[0], to: after },
        'lot de checkpoints en échec — les joueurs du lot seront repris au prochain passage',
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw toError(error);
    }

    if (userIds.length < CHECKPOINT_BATCH_SIZE) break;
  }

  if (drifts > 0) {
    log.error({ periodStart, drifts }, 'LEDGER DRIFT figée dans les checkpoints');
  }
  log.info({ periodStart, written, drifts, failedBatches }, 'checkpoints du journal calculés');
  return { periodStart, written, drifts, failedBatches };
}

// ---------------------------------------------------------------------------
// Purge nocturne : supprimer ce qu'un checkpoint assez ancien couvre
// ---------------------------------------------------------------------------

/** Lignes par DELETE : court sous `statement_timeout`, sans long verrou sur `transactions`. */
export const PURGE_CHUNK_SIZE = 5_000;

/**
 * Plafond par nuit. Le premier passage après douze mois d'exploitation trouve
 * un an de journal d'un coup ; plutôt qu'une nuit interminable, on étale — ce
 * qui reste est repris la nuit suivante, la sélection des candidats ne
 * retenant que les couples qui ont encore des lignes à purger.
 */
export const PURGE_MAX_ROWS_PER_RUN = 200_000;

/** Couples (joueur, monnaie) examinés par nuit ; borne la requête de sélection. */
const PURGE_MAX_PAIRS_PER_RUN = 2_000;

export interface PurgeRunResult {
  cutoffPeriod: string;
  deleted: number;
  /** Couples (joueur, monnaie) purgés, en tout ou partie. */
  pairs: number;
  /** Couples refusés parce que leur dernier checkpoint porte une dérive. */
  skipped: number;
}

/**
 * Supprime, couple par couple, les écritures couvertes par le dernier
 * checkpoint sous la coupure de rétention — jamais sans checkpoint, jamais
 * pour un joueur dont le dernier checkpoint est en dérive.
 *
 * Ordre des opérations, et pourquoi il est sûr vis-à-vis de l'audit : l'audit
 * horaire ne somme que les écritures d'id supérieur à la borne du DERNIER
 * checkpoint, et la purge n'efface que des écritures d'id inférieur ou égal à
 * la borne d'un checkpoint PLUS ANCIEN. Les deux ensembles sont disjoints ;
 * une vérification lancée au milieu d'une purge tombe juste.
 */
export async function purgeLedger(now: Date = new Date()): Promise<PurgeRunResult> {
  const { retentionMonths, checkpointDay } = getBalance().economy.ledger;
  const cutoff = retentionCutoff(now, retentionMonths, checkpointDay);
  const candidates = await ledgerRepo.listPurgeCandidates(cutoff, PURGE_MAX_PAIRS_PER_RUN);

  let deleted = 0;
  let pairs = 0;
  let skipped = 0;
  const skippedUsers: string[] = [];

  for (const candidate of candidates) {
    if (deleted >= PURGE_MAX_ROWS_PER_RUN) break;
    const boundary = purgeBoundary(candidate.checkpoints, cutoff);
    if (!boundary) {
      skipped += 1;
      skippedUsers.push(candidate.userId);
      continue;
    }

    let exhausted = false;
    while (deleted < PURGE_MAX_ROWS_PER_RUN) {
      const count = await withTransaction((tx) =>
        ledgerRepo.deleteTransactionsThrough(
          tx,
          {
            userId: candidate.userId,
            currency: candidate.currency,
            transactionsThrough: boundary.transactionsThrough,
          },
          PURGE_CHUNK_SIZE,
        ),
      );
      deleted += count;
      if (count < PURGE_CHUNK_SIZE) {
        exhausted = true;
        break;
      }
    }
    pairs += 1;

    // Seulement une fois le couple entièrement purgé : tant qu'il reste des
    // lignes sous la borne, les checkpoints antérieurs décrivent encore
    // quelque chose de vérifiable.
    if (exhausted) {
      await ledgerRepo.pruneCheckpointsBefore(
        candidate.userId,
        candidate.currency,
        boundary.periodStart,
      );
    }
  }

  if (skipped > 0) {
    log.warn(
      { skipped, sample: skippedUsers.slice(0, 5), cutoff: cutoff.period },
      'purge du journal refusée pour des joueurs en dérive comptable',
    );
  }
  if (deleted > 0) {
    log.info({ deleted, pairs, cutoff: cutoff.period }, 'écritures du journal purgées');
    await systemRepo.audit({
      action: 'ledger_purge',
      targetType: 'ledger',
      payload: { deleted, pairs, skipped, cutoffPeriod: cutoff.period, retentionMonths },
      severity: 'info',
    });
  }

  return { cutoffPeriod: cutoff.period, deleted, pairs, skipped };
}
