import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { balance as getBalance } from '../../src/config';
import { getDb, withTransaction } from '../../src/db/client';
import * as economyRepo from '../../src/repositories/economy.repo';
import * as economyService from '../../src/services/economy.service';
import {
  checkpointLedger,
  periodStartFor,
  purgeLedger,
} from '../../src/services/ledger.service';
import {
  coinsOf,
  createTestPlayer,
  expectLedgerBalanced,
  grantCoins,
  ledgerOf,
  resetDatabase,
  resetRedis,
} from './helpers';

/**
 * Rétention du journal par soldes d'ouverture, sur base réelle.
 *
 * Les fonctions pures sont couvertes sans base (`tests/ledger-checkpoint`) ;
 * ici on vérifie ce qui n'existe que dans le moteur : la migration 0015
 * (table, trigger d'immuabilité assoupli pour la seule purge, vue), le calcul
 * sous verrou, l'audit horaire qui repart du checkpoint, et surtout que la
 * purge supprime VRAIMENT des lignes sans que l'invariant cesse d'être vrai.
 */

/** Un instant plus vieux que la rétention configurée, pour fabriquer un checkpoint purgeable. */
function beyondRetention(now: Date): Date {
  const { retentionMonths } = getBalance().economy.ledger;
  return DateTime.fromJSDate(now, { zone: 'utc' })
    .minus({ months: retentionMonths + 2 })
    .toJSDate();
}

async function checkpointRows(userId: string) {
  const result = await getDb().execute<{
    currency: string;
    period_start: string;
    opening_balance: string;
    transactions_through: string;
    drift: string;
  }>(sql`
    SELECT currency::text, period_start::text, opening_balance::text, transactions_through::text, drift::text
    FROM ledger_checkpoints
    WHERE user_id = ${userId}
    ORDER BY period_start, currency
  `);
  return result.rows.map((row) => ({
    currency: row.currency,
    periodStart: row.period_start,
    openingBalance: Number(row.opening_balance),
    transactionsThrough: Number(row.transactions_through),
    drift: Number(row.drift),
  }));
}

async function transactionIds(userId: string): Promise<number[]> {
  const result = await getDb().execute<{ id: string }>(
    sql`SELECT id::text FROM transactions WHERE user_id = ${userId} AND currency = 'coins' ORDER BY id`,
  );
  return result.rows.map((row) => Number(row.id));
}

/**
 * Attend le refus du trigger d'immuabilité. Drizzle enveloppe l'erreur du
 * moteur (« Failed query: … ») et range le message PostgreSQL dans `cause` :
 * c'est là qu'il faut lire la raison, sinon on ne prouve qu'un échec, pas le bon.
 */
async function expectImmutable(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const cause = (caught as Error & { cause?: unknown }).cause;
  const reason = cause instanceof Error ? cause.message : (caught as Error).message;
  expect(reason).toMatch(/immuable/);
}

/** Vieillit un checkpoint : `computed_at` vient de `now()`, la purge exige un âge réel. */
async function ageCheckpoints(userId: string, computedAt: Date): Promise<void> {
  await getDb().execute(
    sql`UPDATE ledger_checkpoints SET computed_at = ${computedAt} WHERE user_id = ${userId}`,
  );
}

describe('rétention du journal', () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it('fige un solde d\'ouverture égal au solde réel, et l\'audit repart de là', async () => {
    const player = await createTestPlayer();
    await grantCoins(player.id, 50_000);
    await withTransaction(async (tx) => {
      await economyService.charge({ userId: player.id, amount: 12_500, type: 'shop_purchase' }, tx);
    });
    const coins = await coinsOf(player.id);
    const ids = await transactionIds(player.id);

    const now = new Date();
    const run = await checkpointLedger(now);
    expect(run.periodStart).toBe(periodStartFor(now, getBalance().economy.ledger.checkpointDay));
    // Les deux monnaies sont figées ensemble, même sans écriture en gemmes.
    expect(run.written).toBe(2);
    expect(run.drifts).toBe(0);

    const rows = await checkpointRows(player.id);
    expect(rows).toEqual([
      {
        currency: 'coins',
        periodStart: run.periodStart,
        openingBalance: coins,
        transactionsThrough: ids.at(-1),
        drift: 0,
      },
      { currency: 'gems', periodStart: run.periodStart, openingBalance: 0, transactionsThrough: 0, drift: 0 },
    ]);

    // Idempotent : rejouer le mois ne réécrit rien.
    expect((await checkpointLedger(now)).written).toBe(0);

    // Des écritures postérieures : l'audit les ajoute à l'ouverture.
    await grantCoins(player.id, 1_000);
    await expectLedgerBalanced();
    expect(await coinsOf(player.id)).toBe(coins + 1_000);
  });

  it('purge ce qu\'un checkpoint plus vieux que la rétention couvre, sans casser l\'audit', async () => {
    const player = await createTestPlayer();
    await grantCoins(player.id, 50_000);
    await withTransaction(async (tx) => {
      await economyService.charge({ userId: player.id, amount: 12_500, type: 'shop_purchase' }, tx);
    });
    const covered = await transactionIds(player.id);

    // Un checkpoint daté d'avant la rétention — étiquette ET instant de calcul.
    const now = new Date();
    const old = beyondRetention(now);
    expect((await checkpointLedger(old)).written).toBe(2);
    await ageCheckpoints(player.id, old);

    // Une écriture après le checkpoint : elle doit survivre à la purge.
    await grantCoins(player.id, 1_000);
    const coins = await coinsOf(player.id);
    expect(await ledgerOf(player.id)).toBe(coins);

    // Rien à purger sans instant dépassé : un checkpoint tout frais ne compte pas.
    const nothing = await purgeLedger(old);
    expect(nothing.deleted).toBe(0);

    const purge = await purgeLedger(now);
    expect(purge.deleted).toBe(covered.length);
    expect(purge.pairs).toBe(1);
    expect(purge.skipped).toBe(0);

    // Les lignes couvertes ont disparu, la postérieure est là, et le solde n'a pas bougé.
    const remaining = await transactionIds(player.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBeGreaterThan(covered.at(-1)!);
    expect(await coinsOf(player.id)).toBe(coins);

    // La somme brute ne vaut plus le solde — c'est précisément pour cela que
    // l'audit repart du checkpoint, et il tombe juste.
    expect(await ledgerOf(player.id)).not.toBe(coins);
    await expectLedgerBalanced();

    // Une seconde nuit ne trouve plus rien, et l'ouverture reste consultable.
    expect((await purgeLedger(now)).deleted).toBe(0);
    expect((await checkpointRows(player.id)).map((row) => row.currency)).toEqual(['coins', 'gems']);
  });

  it('refuse la purge d\'un joueur en dérive et journalise l\'écart', async () => {
    const honest = await createTestPlayer('honnete');
    const tampered = await createTestPlayer('trafique');
    await grantCoins(honest.id, 2_000);
    await grantCoins(tampered.id, 2_000);

    // Manipulation directe de la base, hors journal : ce que le checkpoint doit voir.
    await getDb().execute(sql`UPDATE users SET coins = coins + 7 WHERE id = ${tampered.id}`);

    const now = new Date();
    const old = beyondRetention(now);
    const run = await checkpointLedger(old);
    expect(run.written).toBe(4);
    expect(run.drifts).toBe(1);
    await ageCheckpoints(honest.id, old);
    await ageCheckpoints(tampered.id, old);

    const drifted = (await checkpointRows(tampered.id)).find((row) => row.currency === 'coins');
    expect(drifted?.drift).toBe(7);
    // L'ouverture reste celle du JOURNAL, pas du solde trafiqué.
    expect(drifted?.openingBalance).toBe((await coinsOf(tampered.id)) - 7);

    const audit = await getDb().execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM audit_logs
      WHERE action = 'ledger_mismatch' AND target_id = ${tampered.id}
        AND payload->>'source' = 'ledger:checkpoint'
    `);
    expect(Number(audit.rows[0]?.count)).toBe(1);

    const before = await transactionIds(tampered.id);
    const purge = await purgeLedger(now);
    expect(purge.pairs).toBe(1);
    expect(purge.skipped).toBe(1);
    // Le joueur sain est purgé, le joueur en dérive garde tout son journal.
    expect(await transactionIds(honest.id)).toEqual([]);
    expect(await transactionIds(tampered.id)).toEqual(before);

    // Et l'audit horaire continue de le signaler — lui seul.
    const mismatches = await economyRepo.findLedgerMismatches(50, new Date(0));
    expect(mismatches.map((entry) => entry.userId)).toEqual([tampered.id]);
  });

  it('laisse le journal immuable hors de la purge', async () => {
    const player = await createTestPlayer();
    await grantCoins(player.id, 100);

    await expectImmutable(
      getDb().execute(sql`DELETE FROM transactions WHERE user_id = ${player.id}`),
    );
    await expectImmutable(
      getDb().execute(sql`UPDATE transactions SET amount = 1 WHERE user_id = ${player.id}`),
    );
    // Même annoncée, une transaction ne peut pas MODIFIER une ligne : seul le DELETE de la purge passe.
    await expectImmutable(
      withTransaction(async (tx) => {
        await tx.execute(sql`SET LOCAL harvester.ledger_purge = 'on'`);
        await tx.execute(sql`UPDATE transactions SET amount = 1 WHERE user_id = ${player.id}`);
      }),
    );

    expect(await transactionIds(player.id)).toHaveLength(2);
    await expectLedgerBalanced();
  });
});
