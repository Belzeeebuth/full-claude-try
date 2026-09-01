import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { balance as getBalance } from '../../src/config';
import { getDb, withTransaction } from '../../src/db/client';
import * as inventoryService from '../../src/services/inventory.service';
import * as farmService from '../../src/services/farm.service';
import { doPrestige } from '../../src/services/misc.service';
import type { PlayerContext } from '../../src/types';
import {
  coinsOf,
  createTestPlayer,
  expectLedgerBalanced,
  grantCoins,
  ledgerOf,
  reloadPlayer,
  resetDatabase,
  resetRedis,
  setLevel,
} from './helpers';

/**
 * PRESTIGE — non-régression des constats C-2 et D-3.
 *
 * C-2 : la renaissance écrivait le nouveau solde ENTIER dans le journal au lieu
 *       de la variation. Chaque prestige creusait un écart permanent entre
 *       `users.coins` et `SUM(transactions.amount)`, que l'audit horaire
 *       remontait ensuite en erreur — noyant les vraies dérives dans le bruit.
 *
 * D-3 : seules les parcelles `planted` repassaient à `empty`. Une parcelle
 *       `withered` (écrite par le job de flétrissement) restait bloquée : la vue
 *       la comptait libre, `plant()` la refusait, et rien ne pouvait la
 *       débloquer. Le test le plus honnête est donc de replanter dessus.
 */

async function witherPlot(farmId: string, slot: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE plots SET state = 'withered' WHERE farm_id = ${farmId} AND slot = ${slot}`,
  );
}

async function plotState(farmId: string, slot: number): Promise<string> {
  const rows = await getDb().execute<{ state: string }>(
    sql`SELECT state FROM plots WHERE farm_id = ${farmId} AND slot = ${slot}`,
  );
  return rows.rows[0]?.state ?? 'inconnu';
}

async function unlockPlots(farmId: string, upToSlot: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE plots SET state = 'empty', unlocked_at = now()
         WHERE farm_id = ${farmId} AND slot <= ${upToSlot} AND state = 'locked'`,
  );
}

/** Amène le joueur au niveau requis et renvoie son contexte à jour. */
async function makeEligible(player: PlayerContext): Promise<PlayerContext> {
  await setLevel(player.id, getBalance().prestige.requiredLevel);
  return reloadPlayer(player.discordId);
}

describe('prestige', () => {
  let player: PlayerContext;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    player = await createTestPlayer('doyen');
    await grantCoins(player.id, 200_000);
  });

  it('conserve l\'invariant du grand livre', async () => {
    const eligible = await makeEligible(player);
    const before = await coinsOf(eligible.id);

    await doPrestige(eligible);

    const config = getBalance().prestige;
    const expected = Math.floor(before * config.keeps.coinsPercent) + config.startingCoinsAfterPrestige;
    expect(await coinsOf(eligible.id)).toBe(expected);
    // Le point de C-2 : le journal suit le solde, il ne le remplace pas.
    expect(await ledgerOf(eligible.id)).toBe(expected);
    await expectLedgerBalanced();
  });

  it('journalise la variation négative, pas le solde', async () => {
    const eligible = await makeEligible(player);
    const before = await coinsOf(eligible.id);

    await doPrestige(eligible);

    const rows = await getDb().execute<{ amount: string; balance_after: string }>(
      sql`SELECT amount::text AS amount, balance_after::text AS balance_after
            FROM transactions
           WHERE user_id = ${eligible.id} AND type = 'prestige_reset'`,
    );
    expect(rows.rows).toHaveLength(1);
    const entry = rows.rows[0]!;
    const after = await coinsOf(eligible.id);
    expect(Number(entry.amount)).toBe(after - before);
    expect(Number(entry.amount)).toBeLessThan(0);
    expect(Number(entry.balance_after)).toBe(after);
  });

  it('libère les parcelles fanées, qui redeviennent cultivables', async () => {
    const eligible = await makeEligible(player);
    await witherPlot(eligible.farmId, 3);
    expect(await plotState(eligible.farmId, 3)).toBe('withered');

    await doPrestige(eligible);

    // D-3 : sans le correctif, la parcelle restait « withered » pour toujours.
    expect(await plotState(eligible.farmId, 3)).toBe('empty');

    // La preuve par l'usage : le prestige a vidé les graines, on en redonne,
    // puis on plante là où le joueur était bloqué.
    const reborn = await reloadPlayer(eligible.discordId);
    await withTransaction(async (tx) => {
      await inventoryService.addItems(reborn.id, [{ itemKey: 'seed_wheat', quantity: 5 }], tx, {
        allowOverflow: true,
      });
    });
    await expect(farmService.plant(reborn, { cropKey: 'wheat', slot: 3 })).resolves.toBeTruthy();
    expect(await plotState(eligible.farmId, 3)).toBe('planted');
  });

  it('reverrouille les parcelles au-delà de la moitié conservée', async () => {
    await unlockPlots(player.farmId, 14);
    const eligible = await makeEligible(player);

    const plan = await doPrestige(eligible);

    expect(plan.plotsKept).toBe(
      Math.max(getBalance().plots.startingUnlocked, Math.floor(14 * getBalance().prestige.keeps.plots)),
    );
    expect(await plotState(eligible.farmId, plan.plotsKept)).toBe('empty');
    expect(await plotState(eligible.farmId, plan.plotsKept + 1)).toBe('locked');
  });

  it('un joueur sous le niveau requis ne peut pas renaître', async () => {
    const before = await coinsOf(player.id);
    await expect(doPrestige(player)).rejects.toThrow();
    expect(await coinsOf(player.id)).toBe(before);
    await expectLedgerBalanced();
  });
});
