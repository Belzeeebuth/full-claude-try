import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb, type Executor, type Transaction } from '../db/client';
import { ledgerCheckpoints } from '../db/schema';
import type { Currency } from './economy.repo';

/**
 * Soldes d'ouverture du journal comptable (`ledger_checkpoints`) et purge des
 * lignes `transactions` qu'ils couvrent.
 *
 * Aucune règle ici : QUAND figer un solde, QUEL checkpoint borne la purge et
 * COMBIEN de lignes supprimer par nuit se décident dans
 * `services/ledger.service.ts`. Ce fichier ne fait que lire et écrire.
 */

export type LedgerCheckpointRow = typeof ledgerCheckpoints.$inferSelect;
export type LedgerCheckpointInsert = typeof ledgerCheckpoints.$inferInsert;

/** Ce qu'un checkpoint apporte à la vérification : d'où repartir, et jusqu'où le journal est déjà compté. */
export interface CheckpointRef {
  openingBalance: number;
  transactionsThrough: number;
}

/** Ce qu'il faut savoir d'un checkpoint pour décider s'il peut borner une purge. */
export interface CheckpointSummary {
  periodStart: string;
  transactionsThrough: number;
  drift: number;
  computedAt: Date;
}

/**
 * Joueurs vivants sans checkpoint `coins` pour la période, par identifiant
 * croissant. Pagination par clé (`id > dernier vu`) plutôt que par décalage :
 * les joueurs traités disparaissent de la sélection au fur et à mesure, un
 * `OFFSET` sauterait donc des lignes — et un lot en échec doit pouvoir être
 * dépassé sans être rejoué en boucle.
 */
export async function listUsersWithoutCheckpoint(
  periodStart: string,
  afterUserId: string | undefined,
  limit: number,
  executor: Executor = getDb(),
): Promise<string[]> {
  const rows = await executor.execute<{ id: string }>(sql`
    SELECT u.id
    FROM users u
    WHERE u.deleted_at IS NULL
      ${afterUserId ? sql`AND u.id > ${afterUserId}` : sql.empty()}
      AND NOT EXISTS (
        SELECT 1
        FROM ledger_checkpoints c
        WHERE c.user_id = u.id
          AND c.currency = 'coins'
          AND c.period_start = ${periodStart}::date
      )
    ORDER BY u.id
    LIMIT ${limit}
  `);
  return rows.rows.map((row) => row.id);
}

export interface CheckpointAggregate {
  userId: string;
  currency: Currency;
  /** Dernier checkpoint antérieur à la période ; `undefined` = première fois. */
  previous: CheckpointRef | undefined;
  /** Somme des écritures postérieures au checkpoint précédent. */
  delta: number;
  /** Identifiant de la dernière écriture sommée ; `null` = aucune depuis le précédent. */
  lastId: number | null;
}

/**
 * Pour chaque joueur du lot et chacune des deux monnaies : le checkpoint
 * précédent et la somme des écritures qui le suivent.
 *
 * À appeler SOUS VERROU des lignes joueur : `credit`/`debit` mettent à jour
 * `users` avant d'insérer la ligne de journal, donc une écriture en cours pour
 * un joueur verrouillé attend notre commit — aucune ligne d'identifiant
 * inférieur à `MAX(id)` ne peut apparaître après coup pour ce joueur, et
 * `transactions_through` couvre bien tout ce qu'il a d'engagé.
 *
 * La borne `id > transactions_through` est ce qui rend le calcul mensuel
 * bounded : un joueur inactif ne coûte qu'une sonde d'index vide.
 */
export async function aggregateSinceCheckpoint(
  userIds: readonly string[],
  periodStart: string,
  executor: Executor,
): Promise<CheckpointAggregate[]> {
  if (userIds.length === 0) return [];
  const rows = await executor.execute<{
    user_id: string;
    currency: Currency;
    prev_opening: string | null;
    prev_through: string | null;
    delta: string;
    last_id: string | null;
  }>(sql`
    SELECT u.id AS user_id,
           c.currency::text AS currency,
           p.opening_balance::text AS prev_opening,
           p.transactions_through::text AS prev_through,
           COALESCE(SUM(t.amount), 0)::text AS delta,
           MAX(t.id)::text AS last_id
    FROM users u
    CROSS JOIN (VALUES ('coins'::currency), ('gems'::currency)) AS c(currency)
    LEFT JOIN LATERAL (
      SELECT p.opening_balance, p.transactions_through
      FROM ledger_checkpoints p
      WHERE p.user_id = u.id
        AND p.currency = c.currency
        AND p.period_start < ${periodStart}::date
      ORDER BY p.period_start DESC
      LIMIT 1
    ) p ON true
    LEFT JOIN transactions t
      ON t.user_id = u.id
     AND t.currency = c.currency
     AND t.id > COALESCE(p.transactions_through, 0)
    WHERE u.id IN ${[...userIds]}
    GROUP BY u.id, c.currency, p.opening_balance, p.transactions_through
    ORDER BY u.id, c.currency
  `);
  // `bigint` arrive en chaîne depuis pg : `Number()` avant tout calcul.
  return rows.rows.map((row) => ({
    userId: row.user_id,
    currency: row.currency,
    previous:
      row.prev_opening === null || row.prev_through === null
        ? undefined
        : {
            openingBalance: Number(row.prev_opening),
            transactionsThrough: Number(row.prev_through),
          },
    delta: Number(row.delta),
    lastId: row.last_id === null ? null : Number(row.last_id),
  }));
}

/**
 * Insère les checkpoints d'un lot. `ON CONFLICT DO NOTHING` sur la clé
 * primaire : rejouer le job — après un échec partiel, ou à la main — ne
 * réécrit jamais un solde déjà figé.
 */
export async function insertCheckpoints(
  rows: LedgerCheckpointInsert[],
  executor: Executor,
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await executor.insert(ledgerCheckpoints).values(rows).onConflictDoNothing();
  return result.rowCount ?? 0;
}

export interface PurgeCandidate {
  userId: string;
  currency: Currency;
  /**
   * Les seuls checkpoints qui décident : le plus récent (sa dérive doit être
   * nulle) et le plus récent sous la coupure (il borne la purge). Ce sont les
   * deux extrémités que `purgeBoundary` irait chercher dans la liste
   * complète — la pré-sélection SQL évite de la rapatrier.
   */
  checkpoints: CheckpointSummary[];
}

/**
 * Couples (joueur, monnaie) ayant un checkpoint sous la coupure ET des lignes
 * encore présentes en deçà de sa borne. Le `EXISTS` est ce qui rend le passage
 * nocturne quasi gratuit hors du premier jour de chaque mois : une fois
 * purgé, un couple ne réapparaît plus avant que la coupure n'avance.
 */
export async function listPurgeCandidates(
  cutoff: { period: string; instant: Date },
  limit: number,
  executor: Executor = getDb(),
): Promise<PurgeCandidate[]> {
  const rows = await executor.execute<{
    user_id: string;
    currency: Currency;
    b_period: string;
    b_through: string;
    b_drift: string;
    b_computed: Date;
    l_period: string;
    l_through: string;
    l_drift: string;
    l_computed: Date;
  }>(sql`
    SELECT b.user_id,
           b.currency::text AS currency,
           b.period_start::text AS b_period,
           b.transactions_through::text AS b_through,
           b.drift::text AS b_drift,
           b.computed_at AS b_computed,
           l.period_start::text AS l_period,
           l.transactions_through::text AS l_through,
           l.drift::text AS l_drift,
           l.computed_at AS l_computed
    FROM (
      SELECT DISTINCT ON (user_id, currency)
             user_id, currency, period_start, transactions_through, drift, computed_at
      FROM ledger_checkpoints
      WHERE period_start <= ${cutoff.period}::date
        AND computed_at <= ${cutoff.instant}
      ORDER BY user_id, currency, period_start DESC
    ) b
    JOIN LATERAL (
      SELECT l.period_start, l.transactions_through, l.drift, l.computed_at
      FROM ledger_checkpoints l
      WHERE l.user_id = b.user_id AND l.currency = b.currency
      ORDER BY l.period_start DESC
      LIMIT 1
    ) l ON true
    WHERE EXISTS (
      SELECT 1
      FROM transactions t
      WHERE t.user_id = b.user_id
        AND t.currency = b.currency
        AND t.id <= b.transactions_through
    )
    ORDER BY b.user_id, b.currency
    LIMIT ${limit}
  `);

  return rows.rows.map((row) => {
    const boundary: CheckpointSummary = {
      periodStart: row.b_period,
      transactionsThrough: Number(row.b_through),
      drift: Number(row.b_drift),
      computedAt: new Date(row.b_computed),
    };
    const latest: CheckpointSummary = {
      periodStart: row.l_period,
      transactionsThrough: Number(row.l_through),
      drift: Number(row.l_drift),
      computedAt: new Date(row.l_computed),
    };
    return {
      userId: row.user_id,
      currency: row.currency,
      checkpoints:
        boundary.periodStart === latest.periodStart ? [boundary] : [boundary, latest],
    };
  });
}

/**
 * Supprime au plus `limit` lignes du journal d'un couple (joueur, monnaie),
 * jusqu'à la borne incluse, par identifiant croissant.
 *
 * Le trigger d'immuabilité ne laisse passer un DELETE que si la transaction
 * s'est annoncée par `SET LOCAL` : d'où l'exigence d'une `Transaction` et non
 * d'un simple `Executor` — hors transaction, `SET LOCAL` ne porte sur rien et
 * le trigger refuserait. Par petits lots pour rester sous `statement_timeout`
 * et ne pas tenir de verrou long sur une table que chaque action de jeu écrit.
 */
export async function deleteTransactionsThrough(
  tx: Transaction,
  target: { userId: string; currency: Currency; transactionsThrough: number },
  limit: number,
): Promise<number> {
  await tx.execute(sql`SET LOCAL harvester.ledger_purge = 'on'`);
  const result = await tx.execute(sql`
    DELETE FROM transactions
    WHERE id IN (
      SELECT id
      FROM transactions
      WHERE user_id = ${target.userId}
        AND currency = ${target.currency}::currency
        AND id <= ${target.transactionsThrough}
      ORDER BY id
      LIMIT ${limit}
    )
  `);
  return result.rowCount ?? 0;
}

/**
 * Retire les checkpoints antérieurs à celui qui borne désormais la purge :
 * leurs écritures ont disparu, ils ne sont plus vérifiables, et les garder
 * ferait grossir sans fin la sélection nocturne des candidats.
 */
export async function pruneCheckpointsBefore(
  userId: string,
  currency: Currency,
  periodStart: string,
  executor: Executor = getDb(),
): Promise<number> {
  const result = await executor
    .delete(ledgerCheckpoints)
    .where(
      and(
        eq(ledgerCheckpoints.userId, userId),
        eq(ledgerCheckpoints.currency, currency),
        lt(ledgerCheckpoints.periodStart, periodStart),
      ),
    );
  return result.rowCount ?? 0;
}
