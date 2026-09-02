import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerContext } from '../../src/types';
import { gameErrorCodeOf, startIsolatedStack, type IsolatedStack } from './stack';

/**
 * ÉCHANGE DIRECT — la révision protège contre le « swap » de dernière seconde.
 *
 * L'abus classique : faire confirmer une offre, puis la modifier avant que
 * l'autre ne valide. La parade est une colonne `revision` incrémentée à chaque
 * modification, qui remet les deux confirmations à zéro, et un `UPDATE ...
 * WHERE revision = $attendue` à la confirmation. C'est une garantie du moteur —
 * la clause `WHERE` et le verrou de ligne — pas de la logique de jeu : elle se
 * vérifie contre un vrai PostgreSQL, en enchaînant réellement les appels.
 *
 * Tout module applicatif est importé dynamiquement, après le démarrage des
 * conteneurs : voir `stack.ts`.
 */

type Helpers = typeof import('./helpers');
type TradeService = typeof import('../../src/services/trade.service');
type InventoryService = typeof import('../../src/services/inventory.service');
type DbClient = typeof import('../../src/db/client');
type Money = typeof import('../../src/game/money');
type Config = typeof import('../../src/config');

const ITEM = 'wheat';
const OWNED = 20;
const OFFERED = 10;
const COINS = 1_000;

describe('échange direct : révision et double confirmation', () => {
  let stack: IsolatedStack;
  let helpers: Helpers;
  let tradeService: TradeService;
  let inventoryService: InventoryService;
  let db: DbClient;
  let money: Money;
  let config: Config;

  let alice: PlayerContext;
  let bob: PlayerContext;

  beforeAll(async () => {
    stack = await startIsolatedStack();
    helpers = await import('./helpers');
    tradeService = await import('../../src/services/trade.service');
    inventoryService = await import('../../src/services/inventory.service');
    db = await import('../../src/db/client');
    money = await import('../../src/game/money');
    config = await import('../../src/config');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  beforeEach(async () => {
    await helpers.resetDatabase();
    await helpers.resetRedis();
    const created = await Promise.all([
      helpers.createTestPlayer('alice'),
      helpers.createTestPlayer('bob'),
    ]);

    // L'échange est réservé aux joueurs d'un niveau minimum : on l'atteint par
    // la base, puis on RECHARGE le contexte — c'est lui que le service lit.
    const minLevel = config.balance().trade.minLevel;
    await helpers.setLevel(created[0].id, minLevel);
    await helpers.setLevel(created[1].id, minLevel);
    alice = await helpers.reloadPlayer(created[0].discordId);
    bob = await helpers.reloadPlayer(created[1].discordId);

    await db.withTransaction(async (tx) => {
      await inventoryService.addItems(alice.id, [{ itemKey: ITEM, quantity: OWNED }], tx, {
        allowOverflow: true,
      });
    });
    await helpers.grantCoins(bob.id, 100_000);
  });

  async function itemsOf(userId: string): Promise<number> {
    return inventoryService.count(userId, ITEM);
  }

  async function tradeStatus(tradeId: string): Promise<string> {
    const rows = await db.getDb().execute<{ status: string }>(
      sql`SELECT status FROM trades WHERE id = ${tradeId}`,
    );
    return rows.rows[0]?.status ?? 'inconnu';
  }

  it('modifier l\'offre invalide la confirmation ; l\'ancienne révision est refusée, la nouvelle exécute', async () => {
    const aliceBefore = await helpers.coinsOf(alice.id);
    const bobBefore = await helpers.coinsOf(bob.id);

    const opened = await tradeService.openTrade(alice, bob.id);
    expect(opened.status).toBe('pending');
    expect(opened.initiatorId).toBe(alice.id);
    expect(opened.partnerId).toBe(bob.id);

    const withItem = await tradeService.offerItem(alice, {
      tradeId: opened.id,
      itemKey: ITEM,
      quantity: OFFERED,
    });
    expect(withItem.revision).toBeGreaterThan(opened.revision);
    // L'objet est promis, pas encore retiré : rien ne bouge avant l'exécution.
    expect(await itemsOf(alice.id)).toBe(OWNED);

    const staleRevision = withItem.revision;
    const aliceConfirmed = await tradeService.confirmTrade(alice, opened.id, staleRevision);
    expect(aliceConfirmed.completed).toBe(false);
    expect(aliceConfirmed.trade.initiatorConfirmed).toBe(true);
    expect(aliceConfirmed.trade.partnerConfirmed).toBe(false);

    // Bob touche à l'offre : la révision avance et la confirmation d'Alice tombe.
    const withCoins = await tradeService.offerCoins(bob, { tradeId: opened.id, amount: COINS });
    expect(withCoins.revision).toBeGreaterThan(staleRevision);
    expect(withCoins.partnerCoins).toBe(COINS);
    expect(withCoins.initiatorConfirmed).toBe(false);
    expect(withCoins.partnerConfirmed).toBe(false);

    // Le cœur du scénario : confirmer ce qu'on a vu AVANT la modification échoue.
    expect(
      await gameErrorCodeOf(tradeService.confirmTrade(alice, opened.id, staleRevision)),
    ).toBe('invalid_state');
    const stale = await tradeService.getTrade(opened.id);
    expect(stale.initiatorConfirmed).toBe(false);
    expect(stale.status).toBe('pending');
    // Et rien n'a été transféré sur ce refus.
    expect(await itemsOf(alice.id)).toBe(OWNED);
    expect(await itemsOf(bob.id)).toBe(0);
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore);

    // Les deux confirment la révision courante : la seconde exécute l'échange.
    const freshRevision = withCoins.revision;
    const aliceAgain = await tradeService.confirmTrade(alice, opened.id, freshRevision);
    expect(aliceAgain.completed).toBe(false);
    const bobConfirmed = await tradeService.confirmTrade(bob, opened.id, freshRevision);
    expect(bobConfirmed.completed).toBe(true);
    expect(bobConfirmed.trade.status).toBe('completed');
    expect(await tradeStatus(opened.id)).toBe('completed');

    // Transferts croisés exacts, taxe comprise — celle du jeu, pas une
    // formule recopiée : la taxe est prélevée sur le payeur et disparaît.
    const tax = money.feeOf(COINS, config.balance().trade.taxRate);
    expect(await itemsOf(alice.id)).toBe(OWNED - OFFERED);
    expect(await itemsOf(bob.id)).toBe(OFFERED);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore - COINS);
    expect(await helpers.coinsOf(alice.id)).toBe(aliceBefore + COINS - tax);
    expect(await helpers.ledgerOf(alice.id)).toBe(aliceBefore + COINS - tax);
    expect(await helpers.ledgerOf(bob.id)).toBe(bobBefore - COINS);
    await helpers.expectLedgerBalanced();

    // Un échange exécuté ne se rejoue pas : confirmer encore est refusé et ne
    // transfère rien de plus.
    expect(
      await gameErrorCodeOf(tradeService.confirmTrade(bob, opened.id, freshRevision)),
    ).toBe('invalid_state');
    expect(await itemsOf(bob.id)).toBe(OFFERED);
    expect(await helpers.coinsOf(bob.id)).toBe(bobBefore - COINS);
    await helpers.expectLedgerBalanced();
  });

  it('un tiers ne peut pas confirmer à la place d\'une partie', async () => {
    const mallory = await helpers.createTestPlayer('mallory');
    const opened = await tradeService.openTrade(alice, bob.id);
    const withItem = await tradeService.offerItem(alice, {
      tradeId: opened.id,
      itemKey: ITEM,
      quantity: OFFERED,
    });

    expect(
      await gameErrorCodeOf(tradeService.confirmTrade(mallory, opened.id, withItem.revision)),
    ).toBe('invalid_state');
    const unchanged = await tradeService.getTrade(opened.id);
    expect(unchanged.initiatorConfirmed).toBe(false);
    expect(unchanged.partnerConfirmed).toBe(false);
    expect(unchanged.status).toBe('pending');
  });
});
