import { beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/client';
import * as economyService from '../../src/services/economy.service';
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
 * L'invariant du grand livre, vérifié sur le chemin nominal.
 *
 * Ces tests ne cherchent pas de bug précis : ils tiennent la ligne de base. Si
 * une future modification de `credit`/`debit` cesse d'écrire le journal en même
 * temps que le solde, c'est ici que ça casse — avant que le job horaire ne le
 * découvre en production.
 */
describe('grand livre', () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it('un compte neuf a un journal égal à son solde', async () => {
    const player = await createTestPlayer();
    const coins = await coinsOf(player.id);
    expect(coins).toBeGreaterThan(0);
    expect(await ledgerOf(player.id)).toBe(coins);
    await expectLedgerBalanced();
  });

  it('crédits et débits laissent l\'invariant vrai', async () => {
    const player = await createTestPlayer();
    const start = await coinsOf(player.id);

    await grantCoins(player.id, 50_000);
    await withTransaction(async (tx) => {
      await economyService.charge({ userId: player.id, amount: 12_500, type: 'shop_purchase' }, tx);
    });

    expect(await coinsOf(player.id)).toBe(start + 50_000 - 12_500);
    expect(await ledgerOf(player.id)).toBe(start + 50_000 - 12_500);
    await expectLedgerBalanced();
  });

  it('un débit supérieur au solde est refusé, et ne laisse aucune trace', async () => {
    const player = await createTestPlayer();
    const start = await coinsOf(player.id);

    await expect(
      withTransaction(async (tx) => {
        await economyService.charge(
          { userId: player.id, amount: start + 1, type: 'shop_purchase' },
          tx,
        );
      }),
    ).rejects.toThrow();

    expect(await coinsOf(player.id)).toBe(start);
    expect(await ledgerOf(player.id)).toBe(start);
    await expectLedgerBalanced();
  });
});
