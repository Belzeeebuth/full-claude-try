import { getConfig, type ItemConfig } from '../config';
import { getDb, type Executor } from '../db/client';
import { gameError } from '../utils/errors';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import type { Quality, Mutation, StackKey } from '../repositories/inventory.repo';

/**
 * Inventaire : capacité, ajout, retrait, consommation d'objets.
 *
 * Le service ajoute au repository ce que celui-ci n'a pas le droit de savoir :
 * la CAPACITÉ de l'entrepôt (règle de jeu), la validation des clés d'objets
 * contre la configuration, et les messages d'erreur destinés au joueur.
 */

export interface InventoryPage {
  entries: inventoryRepo.InventoryEntry[];
  totalPages: number;
  page: number;
  used: number;
  capacity: number;
  totalValue: number;
}

const PAGE_SIZE = 10;

export function requireItem(itemKey: string): ItemConfig {
  const item = getConfig().items.get(itemKey);
  if (!item || !item.enabled) {
    throw gameError('item_unknown', `Unknown item: \`${itemKey}\`.`);
  }
  return item;
}

export async function getPage(
  userId: string,
  options: { category?: string; page?: number } = {},
): Promise<InventoryPage> {
  const [entries, capacityInfo] = await Promise.all([
    inventoryRepo.listInventory(userId, { category: options.category }),
    getCapacity(userId),
  ]);

  const page = Math.max(1, options.page ?? 1);
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);

  return {
    entries: entries.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE),
    totalPages,
    page: clampedPage,
    used: capacityInfo.used,
    capacity: capacityInfo.capacity,
    totalValue: entries.reduce((sum, entry) => sum + entry.sellPrice * entry.quantity, 0),
  };
}

export async function getCapacity(
  userId: string,
  executor: Executor = getDb(),
): Promise<{ used: number; capacity: number; free: number }> {
  const [used, farm] = await Promise.all([
    inventoryRepo.totalQuantity(userId, executor),
    playerRepo.getFarmByUserId(userId, executor),
  ]);
  const capacity = farm?.warehouseCapacity ?? 0;
  return { used, capacity, free: Math.max(0, capacity - used) };
}

/**
 * Ajoute des objets en vérifiant la capacité de l'entrepôt.
 *
 * Choix de design : on REFUSE l'ajout plutôt que de perdre silencieusement le
 * surplus. Un joueur qui perd 40 truffes parce que son entrepôt était plein sans
 * avertissement quitte le jeu ; un joueur à qui l'on dit « videz ou améliorez
 * votre entrepôt » va acheter l'amélioration. `allowOverflow` existe pour les
 * récompenses de quête, qu'on ne veut jamais bloquer.
 */
export async function addItems(
  userId: string,
  entries: Array<{ itemKey: string; quantity: number; quality?: Quality; mutation?: Mutation }>,
  tx: Executor,
  options: { allowOverflow?: boolean } = {},
): Promise<void> {
  const positive = entries.filter((entry) => entry.quantity > 0);
  if (positive.length === 0) return;

  for (const entry of positive) requireItem(entry.itemKey);

  if (!options.allowOverflow) {
    const total = positive.reduce((sum, entry) => sum + entry.quantity, 0);
    const capacity = await getCapacity(userId, tx);
    if (total > capacity.free) {
      throw gameError(
        'inventory_full',
        `Your warehouse is full (${capacity.used}/${capacity.capacity}).`,
        {
          hint: 'Sell items with `/sell` or upgrade your warehouse with `/buildings`.',
          context: { needed: total, free: capacity.free },
          suggestedCommand: 'buildings',
        },
      );
    }
  }

  await inventoryRepo.addItems(
    userId,
    positive.map((entry) => ({
      key: { itemKey: entry.itemKey, quality: entry.quality, mutation: entry.mutation },
      quantity: entry.quantity,
    })),
    tx,
  );
}

/** Retire une quantité précise d'une pile donnée. Lève si le stock manque. */
export async function removeExact(
  userId: string,
  key: StackKey,
  quantity: number,
  tx: Executor,
): Promise<void> {
  const item = requireItem(key.itemKey);
  const removed = await inventoryRepo.removeItem(userId, key, quantity, tx);
  if (!removed) {
    const owned = await inventoryRepo.countItem(userId, key.itemKey, tx);
    throw gameError(
      'insufficient_items',
      `You need ${quantity}× ${item.emoji} ${item.name} (you have ${owned}).`,
      { context: { itemKey: key.itemKey, quantity, owned } },
    );
  }
}

/**
 * Retire une quantité toutes qualités confondues, de la plus basse à la plus
 * haute. Utilisé par l'artisanat et les livraisons : on ne consomme pas une
 * récolte iridium pour faire de la farine.
 */
export async function consume(
  userId: string,
  itemKey: string,
  quantity: number,
  tx: Executor,
): Promise<Array<{ quality: Quality; mutation: Mutation; quantity: number }>> {
  const item = requireItem(itemKey);
  const result = await inventoryRepo.removeItemAnyQuality(userId, itemKey, quantity, tx);
  if (!result.removed) {
    const owned = await inventoryRepo.countItem(userId, itemKey, tx);
    throw gameError(
      'insufficient_items',
      `You need ${quantity}× ${item.emoji} ${item.name} (you have ${owned}).`,
      { context: { itemKey, quantity, owned } },
    );
  }
  return result.consumed;
}

export async function count(
  userId: string,
  itemKey: string,
  executor: Executor = getDb(),
): Promise<number> {
  return inventoryRepo.countItem(userId, itemKey, executor);
}

export async function has(
  userId: string,
  itemKey: string,
  quantity: number,
  executor: Executor = getDb(),
): Promise<boolean> {
  return (await inventoryRepo.countItem(userId, itemKey, executor)) >= quantity;
}

/** Le joueur possède-t-il cet outil ? (les outils ne se consomment jamais) */
export async function hasTool(
  userId: string,
  itemKey: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  return has(userId, itemKey, 1, executor);
}

/** Meilleur outil d'un type possédé, d'après l'ordre de la configuration. */
export async function bestTool(
  userId: string,
  effectType: string,
  executor: Executor = getDb(),
): Promise<ItemConfig | undefined> {
  const config = getConfig();
  const owned = await inventoryRepo.listInventory(userId, { category: 'tool' }, executor);
  const candidates = owned
    .map((entry) => config.items.get(entry.itemKey))
    .filter((item): item is ItemConfig => item?.effect?.type === effectType);
  return candidates.sort((a, b) => b.sortOrder - a.sortOrder)[0];
}

/** Résumé lisible d'une liste d'objets, pour les messages de récompense. */
export function describeItems(
  entries: Array<{ itemKey: string; quantity: number; quality?: string }>,
): string {
  const config = getConfig();
  return entries
    .map((entry) => {
      const item = config.items.get(entry.itemKey);
      const qualityIcon =
        entry.quality && entry.quality !== 'normal'
          ? { silver: '🥈', gold: '🥇', iridium: '💠' }[entry.quality] ?? ''
          : '';
      return `${entry.quantity}× ${item?.emoji ?? '📦'} ${item?.name ?? entry.itemKey}${qualityIcon}`;
    })
    .join(', ');
}

export { PAGE_SIZE as INVENTORY_PAGE_SIZE };
