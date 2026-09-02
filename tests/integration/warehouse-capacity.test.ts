import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerContext } from '../../src/types';
import { gameErrorCodeOf, startIsolatedStack, type IsolatedStack } from './stack';

/**
 * ENTREPÔT PLEIN — la récolte est refusée, jamais perdue.
 *
 * `harvest()` a longtemps déposé sa récolte en `allowOverflow` : l'entrepôt ne
 * limitait rien et le puits de pièces de son amélioration était inerte. Depuis
 * que la capacité est vérifiée, un entrepôt plein doit annuler TOUTE la
 * transaction : la culture reste mûre en terre, l'inventaire ne bouge pas,
 * l'énergie non plus. Ce « tout ou rien » est une propriété du `ROLLBACK`
 * PostgreSQL — la parcelle est vidée et l'énergie dépensée AVANT le dépôt qui
 * échoue — et ne se prouve que contre une vraie base.
 *
 * Tout module applicatif est importé dynamiquement, après le démarrage des
 * conteneurs : voir `stack.ts`.
 */

type Helpers = typeof import('./helpers');
type FarmService = typeof import('../../src/services/farm.service');
type InventoryService = typeof import('../../src/services/inventory.service');
type InventoryRepo = typeof import('../../src/repositories/inventory.repo');
type DbClient = typeof import('../../src/db/client');

const CROP = 'wheat';
const SLOT = 1;
/** De quoi remplir : produit par le désherbage, donc toujours dans `items_config`. */
const FILLER = 'weeds';

// Alias et non interface : `execute<T>` exige un `Record<string, unknown>`,
// qu'un alias satisfait implicitement, pas une interface.
type InventoryLine = {
  item_key: string;
  quality: string;
  mutation: string;
  quantity: number;
};

describe('entrepôt plein', () => {
  let stack: IsolatedStack;
  let helpers: Helpers;
  let farmService: FarmService;
  let inventoryService: InventoryService;
  let inventoryRepo: InventoryRepo;
  let db: DbClient;

  let player: PlayerContext;

  beforeAll(async () => {
    stack = await startIsolatedStack();
    helpers = await import('./helpers');
    farmService = await import('../../src/services/farm.service');
    inventoryService = await import('../../src/services/inventory.service');
    inventoryRepo = await import('../../src/repositories/inventory.repo');
    db = await import('../../src/db/client');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  beforeEach(async () => {
    await helpers.resetDatabase();
    await helpers.resetRedis();
    player = await helpers.createTestPlayer('grenier');
  });

  /**
   * La pousse est calculée à la lecture : on force la maturité plutôt que
   * d'attendre. Alignée sur `planted_at` pour respecter la contrainte CHECK
   * `ready_at >= planted_at`.
   */
  async function forceReady(userId: string): Promise<void> {
    await db.getDb().execute(
      sql`UPDATE planted_crops SET ready_at = planted_at WHERE user_id = ${userId}`,
    );
  }

  async function warehouseCapacity(farmId: string): Promise<number> {
    const rows = await db.getDb().execute<{ warehouse_capacity: number }>(
      sql`SELECT warehouse_capacity FROM farms WHERE id = ${farmId}`,
    );
    const row = rows.rows[0];
    if (!row) throw new Error('ferme introuvable');
    return Number(row.warehouse_capacity);
  }

  async function plantedCropIds(userId: string): Promise<string[]> {
    const rows = await db.getDb().execute<{ id: string }>(
      sql`SELECT id FROM planted_crops WHERE user_id = ${userId} ORDER BY id`,
    );
    return rows.rows.map((row) => row.id);
  }

  async function plotState(farmId: string, slot: number): Promise<string> {
    const rows = await db.getDb().execute<{ state: string }>(
      sql`SELECT state FROM plots WHERE farm_id = ${farmId} AND slot = ${slot}`,
    );
    return rows.rows[0]?.state ?? 'inconnu';
  }

  /** Photographie de l'inventaire, pile par pile, dans un ordre stable. */
  async function inventorySnapshot(userId: string): Promise<InventoryLine[]> {
    const rows = await db.getDb().execute<InventoryLine>(
      sql`SELECT item_key, quality, mutation, quantity FROM inventory
           WHERE user_id = ${userId} ORDER BY item_key, quality, mutation`,
    );
    return rows.rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
  }

  /** Énergie STOCKÉE (pas la projection) : c'est elle qu'un commit modifierait. */
  async function storedEnergy(userId: string): Promise<number> {
    const rows = await db.getDb().execute<{ energy: number }>(
      sql`SELECT energy FROM users WHERE id = ${userId}`,
    );
    return Number(rows.rows[0]?.energy ?? -1);
  }

  it('refuse la récolte avec `inventory_full` : culture en terre, inventaire et énergie intacts', async () => {
    await farmService.plant(player, { cropKey: CROP, slot: SLOT });
    await forceReady(player.id);

    // Remplir à ras bord PAR LE REPOSITORY : la capacité est une règle du
    // service, le repository ne la connaît pas — c'est le seul moyen honnête
    // d'obtenir un entrepôt exactement plein sans contourner le service.
    const capacity = await warehouseCapacity(player.farmId);
    const before = await inventoryService.getCapacity(player.id);
    expect(before.capacity).toBe(capacity);
    expect(before.free).toBeGreaterThan(0);
    await db.withTransaction(async (tx) => {
      await inventoryRepo.addItems(
        player.id,
        [{ key: { itemKey: FILLER }, quantity: before.free }],
        tx,
      );
    });
    const full = await inventoryService.getCapacity(player.id);
    expect(full).toEqual({ used: capacity, capacity, free: 0 });

    const cropsBefore = await plantedCropIds(player.id);
    expect(cropsBefore).toHaveLength(1);
    const inventoryBefore = await inventorySnapshot(player.id);
    const energyBefore = await storedEnergy(player.id);

    expect(await gameErrorCodeOf(farmService.harvest(player, { slot: SLOT }))).toBe(
      'inventory_full',
    );

    // Tout ou rien : la même culture est toujours en terre, la parcelle n'a pas
    // été libérée, aucune pile n'a bougé, l'énergie n'a pas été dépensée.
    expect(await plantedCropIds(player.id)).toEqual(cropsBefore);
    expect(await plotState(player.farmId, SLOT)).toBe('planted');
    expect(await inventorySnapshot(player.id)).toEqual(inventoryBefore);
    expect(await inventoryService.getCapacity(player.id)).toEqual(full);
    expect(await inventoryService.count(player.id, CROP)).toBe(0);
    expect(await storedEnergy(player.id)).toBe(energyBefore);

    // Le refus est sans effet de bord : une fois la place faite, la MÊME culture
    // se récolte, et la parcelle se libère.
    await db.withTransaction(async (tx) => {
      const removed = await inventoryRepo.removeItem(
        player.id,
        { itemKey: FILLER },
        before.free,
        tx,
      );
      expect(removed).toBe(true);
    });
    const summary = await farmService.harvest(player, { slot: SLOT });
    expect(summary.totalQuantity).toBeGreaterThan(0);
    expect(summary.plots.map((plot) => plot.slot)).toEqual([SLOT]);
    expect(await inventoryService.count(player.id, CROP)).toBe(summary.totalQuantity);
    expect(await plantedCropIds(player.id)).toEqual([]);
    expect(await plotState(player.farmId, SLOT)).toBe('empty');
  });
});
