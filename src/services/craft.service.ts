import { balance as getBalance, getConfig, type BuildingConfig, type RecipeConfig } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as animalRepo from '../repositories/animal.repo';
import * as playerRepo from '../repositories/player.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { consumeEnergy, getFarmModifiers, grantXp } from './player.service';
import { grantPassXp, passXpFor, trackAction, type TrackResult } from './tracker.service';
import { getWorldState } from './world.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('craft');

/**
 * Artisanat et bâtiments de production.
 *
 * Une production occupe un EMPLACEMENT du bâtiment jusqu'à sa collecte. Le
 * nombre d'emplacements (1 à 3 selon le palier) est la vraie ressource rare :
 * c'est ce qui pousse à améliorer les bâtiments plutôt qu'à empiler des recettes.
 */

export interface RecipeView {
  recipe: RecipeConfig;
  building: BuildingConfig | undefined;
  hasBuilding: boolean;
  unlocked: boolean;
  ingredients: Array<{ itemKey: string; name: string; emoji: string; needed: number; owned: number }>;
  craftableCount: number;
  outputName: string;
  outputEmoji: string;
  outputValue: number;
  ingredientsValue: number;
  margin: number;
}

export async function listRecipes(
  player: Pick<PlayerContext, 'id' | 'farmId' | 'level'>,
  options: { category?: string } = {},
): Promise<RecipeView[]> {
  const config = getConfig();
  const [buildings, inventory] = await Promise.all([
    animalRepo.listBuildings(player.farmId),
    (await import('../repositories/inventory.repo')).listInventory(player.id, {}),
  ]);

  const ownedBuildings = new Set(buildings.map((entry) => entry.buildingKey));
  const owned = new Map<string, number>();
  for (const entry of inventory) {
    owned.set(entry.itemKey, (owned.get(entry.itemKey) ?? 0) + entry.quantity);
  }

  return config.recipeList
    .filter((recipe) => recipe.enabled)
    .filter((recipe) => !options.category || recipe.category === options.category)
    .map((recipe) => {
      const ingredients = (recipe.ingredients as Array<{ itemKey: string; quantity: number }>).map(
        (ingredient) => {
          const item = config.items.get(ingredient.itemKey);
          return {
            itemKey: ingredient.itemKey,
            name: item?.name ?? ingredient.itemKey,
            emoji: item?.emoji ?? '📦',
            needed: ingredient.quantity,
            owned: owned.get(ingredient.itemKey) ?? 0,
          };
        },
      );

      const craftableCount = Math.min(
        ...ingredients.map((ingredient) => Math.floor(ingredient.owned / ingredient.needed)),
      );
      const output = config.items.get(recipe.outputItemKey);
      const ingredientsValue = ingredients.reduce((sum, ingredient) => {
        const item = config.items.get(ingredient.itemKey);
        return sum + (item?.sellPrice ?? 0) * ingredient.needed;
      }, 0);
      const outputValue = (output?.sellPrice ?? 0) * recipe.outputQuantity;

      return {
        recipe,
        building: config.buildings.get(recipe.buildingKey),
        hasBuilding: ownedBuildings.has(recipe.buildingKey),
        unlocked: player.level >= recipe.requiredLevel,
        ingredients,
        craftableCount: Number.isFinite(craftableCount) ? Math.max(0, craftableCount) : 0,
        outputName: output?.name ?? recipe.outputItemKey,
        outputEmoji: output?.emoji ?? '📦',
        outputValue,
        ingredientsValue,
        margin: ingredientsValue > 0 ? outputValue / ingredientsValue : 0,
      };
    });
}

export interface CraftResult {
  recipeKey: string;
  recipeName: string;
  emoji: string;
  quantity: number;
  finishAt: Date;
  slotIndex: number;
  buildingName: string;
  consumed: Array<{ itemKey: string; quantity: number }>;
}

/**
 * Lance une production.
 * Les ingrédients sont consommés IMMÉDIATEMENT (comme dans tous les jeux de
 * gestion) : cela empêche de lancer dix productions avec le stock d'une seule et
 * rend la file lisible. Ils sont mémorisés dans `consumed` pour pouvoir être
 * remboursés si le joueur annule.
 */
export async function craft(
  player: PlayerContext,
  input: { recipeKey: string; quantity?: number },
): Promise<CraftResult> {
  const config = getConfig();
  const recipe = config.recipes.get(input.recipeKey);
  if (!recipe || !recipe.enabled) {
    throw gameError('recipe_unknown', `Recette inconnue : \`${input.recipeKey}\`.`);
  }
  if (player.level < recipe.requiredLevel) {
    throw gameError('level_too_low', `${recipe.name} demande le niveau ${recipe.requiredLevel}.`);
  }

  const quantity = Math.max(1, Math.min(20, input.quantity ?? 1));
  const now = new Date();
  const modifiers = await getFarmModifiers(player, { now });
  const buildingConfig = config.buildings.get(recipe.buildingKey);

  return withTransaction(async (tx) => {
    const building = await animalRepo.getBuilding(player.farmId, recipe.buildingKey, tx);
    if (!building) {
      throw gameError(
        'building_required',
        `Il vous faut un ${buildingConfig?.emoji ?? ''} ${buildingConfig?.name ?? recipe.buildingKey}.`,
        { hint: 'Construisez-le avec `/buildings`.', suggestedCommand: 'buildings' },
      );
    }

    const slotIndex = await animalRepo.firstFreeSlot(building.id, building.slots, tx);
    if (slotIndex === undefined) {
      throw gameError(
        'no_crafting_slot',
        `All slots of your ${buildingConfig?.name ?? 'building'} are busy (${building.slots}).`,
        { hint: 'Collect a finished run with `/production` or upgrade the building.', suggestedCommand: 'production' },
      );
    }

    const consumed: Array<{ itemKey: string; quantity: number }> = [];
    for (const ingredient of recipe.ingredients as Array<{ itemKey: string; quantity: number }>) {
      const total = ingredient.quantity * quantity;
      await inventoryService.consume(player.id, ingredient.itemKey, total, tx);
      consumed.push({ itemKey: ingredient.itemKey, quantity: total });
    }

    await consumeEnergy(player.id, 'craft', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    // La vitesse du bâtiment ET les bonus de coop réduisent la durée.
    const speed = Number(building.speedMultiplier) * modifiers.craftSpeedMultiplier;
    const durationSeconds = Math.max(
      30,
      Math.round((recipe.durationSeconds * quantity) / Math.max(0.1, speed)),
    );
    const finishAt = new Date(now.getTime() + durationSeconds * 1_000);

    await animalRepo.insertCraftJob(
      {
        userId: player.id,
        buildingId: building.id,
        recipeKey: recipe.key,
        quantity,
        slotIndex,
        startedAt: now,
        finishAt,
        consumed,
      },
      tx,
    );

    log.debug({ userId: player.id, recipeKey: recipe.key, quantity, finishAt }, 'production started');

    return {
      recipeKey: recipe.key,
      recipeName: recipe.name,
      emoji: recipe.emoji,
      quantity,
      finishAt,
      slotIndex,
      buildingName: buildingConfig?.name ?? recipe.buildingKey,
      consumed,
    };
  });
}

export interface ProductionLine {
  id: string;
  recipeKey: string;
  recipeName: string;
  emoji: string;
  quantity: number;
  outputItemKey: string;
  outputName: string;
  outputQuantity: number;
  buildingName: string;
  buildingEmoji: string;
  slotIndex: number;
  finishAt: Date;
  ready: boolean;
}

export async function listProduction(player: Pick<PlayerContext, 'id'>): Promise<ProductionLine[]> {
  const config = getConfig();
  const now = new Date();
  const jobs = await animalRepo.listCraftingQueue(player.id);

  return jobs.map((entry) => {
    const recipe = config.recipes.get(entry.job.recipeKey);
    const output = recipe ? config.items.get(recipe.outputItemKey) : undefined;
    return {
      id: entry.job.id,
      recipeKey: entry.job.recipeKey,
      recipeName: recipe?.name ?? entry.job.recipeKey,
      emoji: recipe?.emoji ?? '🛠️',
      quantity: entry.job.quantity,
      outputItemKey: recipe?.outputItemKey ?? '',
      outputName: output?.name ?? '',
      outputQuantity: (recipe?.outputQuantity ?? 1) * entry.job.quantity,
      buildingName: entry.buildingName,
      buildingEmoji: entry.buildingEmoji,
      slotIndex: entry.job.slotIndex,
      finishAt: entry.job.finishAt,
      ready: entry.job.finishAt.getTime() <= now.getTime(),
    };
  });
}

export interface CollectCraftResult {
  lines: Array<{ recipeName: string; itemKey: string; itemName: string; emoji: string; quantity: number }>;
  xpGained: number;
  levelUp: { level: number; levelsGained: number } | null;
  tracking: TrackResult;
}

export async function collectProduction(
  player: PlayerContext,
  input: { jobId?: string; all?: boolean },
): Promise<CollectCraftResult> {
  const config = getConfig();
  const now = new Date();
  const world = await getWorldState(now);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const jobs = await animalRepo.listCraftingQueue(player.id, {}, tx);
    const ready = jobs.filter(
      (entry) =>
        entry.job.finishAt.getTime() <= now.getTime() &&
        (!input.jobId || entry.job.id === input.jobId),
    );

    if (ready.length === 0) {
      throw gameError('craft_not_ready', 'No finished production.', {
        hint: 'Check `/production` for the deadlines.',
        suggestedCommand: 'production',
      });
    }

    const selected = input.all ? ready : ready.slice(0, 1);
    const lines: CollectCraftResult['lines'] = [];
    let xpTotal = 0;
    let craftedUnits = 0;

    for (const entry of selected) {
      const recipe = config.recipes.get(entry.job.recipeKey);
      if (!recipe) continue;

      const claimed = await animalRepo.markCraftCollected(entry.job.id, now, tx);
      if (!claimed) continue; // déjà collecté par un autre clic

      const output = config.items.get(recipe.outputItemKey);
      const quantity = recipe.outputQuantity * entry.job.quantity;
      await inventoryService.addItems(
        player.id,
        [{ itemKey: recipe.outputItemKey, quantity }],
        tx,
        { allowOverflow: true },
      );

      // Jetons d'événement pour les fabrications (Marché de Noël).
      for (const event of world.activeEvents) {
        const perCraft = event.modifiers.tokenPerCraft ?? 0;
        if (event.currencyItemKey && perCraft > 0) {
          await inventoryService.addItems(
            player.id,
            [{ itemKey: event.currencyItemKey, quantity: perCraft * entry.job.quantity }],
            tx,
            { allowOverflow: true },
          );
        }
      }

      xpTotal += recipe.xpReward * entry.job.quantity;
      craftedUnits += entry.job.quantity;
      lines.push({
        recipeName: recipe.name,
        itemKey: recipe.outputItemKey,
        itemName: output?.name ?? recipe.outputItemKey,
        emoji: output?.emoji ?? '📦',
        quantity,
      });
    }

    if (lines.length === 0) {
      throw gameError('busy', 'Those productions were just collected.');
    }

    await playerRepo.incrementStats(player.id, { totalCrafts: craftedUnits }, tx);
    const xpResult = xpTotal > 0 ? await grantXp(player.id, xpTotal, tx) : null;
    await grantPassXp(player.id, passXpFor(xpTotal), tx);

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'craft_item',
      craftedUnits,
      {},
      tx,
    );

    return {
      lines,
      xpGained: xpTotal,
      levelUp:
        xpResult && xpResult.levelsGained > 0
          ? { level: xpResult.level, levelsGained: xpResult.levelsGained }
          : null,
      tracking,
    };
  });
}

/** Annule une production non terminée et rembourse les ingrédients. */
export async function cancelProduction(
  player: PlayerContext,
  jobId: string,
): Promise<{ refunded: Array<{ itemKey: string; quantity: number }> }> {
  return withTransaction(async (tx) => {
    const job = await animalRepo.lockCraftJob(tx, jobId, player.id);
    if (!job) throw gameError('not_found', 'Production introuvable.');
    if (job.collected) throw gameError('invalid_state', 'This production was already collected.');

    const consumed = job.consumed as Array<{ itemKey: string; quantity: number }>;
    // Remboursement à 80 % : annuler n'est pas gratuit, sinon la file de
    // production devient un espace de stockage sans risque.
    const refunded = consumed.map((entry) => ({
      itemKey: entry.itemKey,
      quantity: Math.max(1, Math.floor(entry.quantity * 0.8)),
    }));

    await inventoryService.addItems(player.id, refunded, tx, { allowOverflow: true });
    await animalRepo.deleteCraftJob(jobId, tx);

    return { refunded };
  });
}

// ---------------------------------------------------------------------------
// BÂTIMENTS
// ---------------------------------------------------------------------------

export interface BuildingView {
  key: string;
  name: string;
  emoji: string;
  category: string;
  description: string | null;
  owned: boolean;
  tier: number;
  maxTier: number;
  capacity: number;
  slots: number;
  nextTier?: {
    tier: number;
    requiredLevel: number;
    costCoins: number;
    costItems: Array<{ itemKey: string; name: string; emoji: string; quantity: number; owned: number }>;
    capacity: number;
    slots: number;
  };
}

export async function listBuildings(
  player: Pick<PlayerContext, 'id' | 'farmId' | 'level'>,
): Promise<BuildingView[]> {
  const config = getConfig();
  const [owned, inventory] = await Promise.all([
    animalRepo.listBuildings(player.farmId),
    (await import('../repositories/inventory.repo')).listInventory(player.id, {}),
  ]);

  const ownedByKey = new Map(owned.map((entry) => [entry.buildingKey, entry]));
  const stock = new Map<string, number>();
  for (const entry of inventory) {
    stock.set(entry.itemKey, (stock.get(entry.itemKey) ?? 0) + entry.quantity);
  }

  return config.buildingList
    .filter((building) => building.enabled)
    .map((building) => {
      const current = ownedByKey.get(building.key);
      const currentTier = current?.building.tier ?? 0;
      const next = building.tiers.find((tier) => tier.tier === currentTier + 1);

      return {
        key: building.key,
        name: building.name,
        emoji: building.emoji,
        category: building.category,
        description: building.description ?? null,
        owned: Boolean(current),
        tier: currentTier,
        maxTier: building.maxTier,
        capacity: current?.building.capacity ?? 0,
        slots: current?.building.slots ?? 0,
        nextTier: next
          ? {
              tier: next.tier,
              requiredLevel: next.requiredLevel,
              costCoins: next.costCoins,
              costItems: next.costItems.map((cost) => {
                const item = config.items.get(cost.itemKey);
                return {
                  itemKey: cost.itemKey,
                  name: item?.name ?? cost.itemKey,
                  emoji: item?.emoji ?? '📦',
                  quantity: cost.quantity,
                  owned: stock.get(cost.itemKey) ?? 0,
                };
              }),
              capacity: next.capacity,
              slots: next.slots,
            }
          : undefined,
      };
    });
}

/**
 * Construit ou améliore un bâtiment.
 * Une seule fonction pour les deux cas : « construire » n'est que « passer au
 * palier 1 ». Cela évite deux chemins de code qui divergeraient.
 */
export async function buildOrUpgrade(
  player: PlayerContext,
  buildingKey: string,
): Promise<{ name: string; emoji: string; tier: number; costCoins: number; capacity: number; slots: number; built: boolean }> {
  const config = getConfig();
  const building = config.buildings.get(buildingKey);
  if (!building || !building.enabled) {
    throw gameError('not_found', `Bâtiment inconnu : \`${buildingKey}\`.`);
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const current = await animalRepo.getBuilding(player.farmId, buildingKey, tx);
    const currentTier = current?.tier ?? 0;
    const next = building.tiers.find((tier) => tier.tier === currentTier + 1);

    if (!next) {
      throw gameError(
        'building_max_tier',
        `${building.emoji} ${building.name} is already at the maximum tier (${building.maxTier}).`,
      );
    }
    if (player.level < next.requiredLevel) {
      throw gameError(
        'level_too_low',
        `Le palier ${next.tier} de ${building.name} demande le niveau ${next.requiredLevel}.`,
      );
    }

    if (next.costCoins > 0) {
      await economyService.charge(
        {
          userId: player.id,
          amount: next.costCoins,
          type: currentTier === 0 ? 'building_purchase' : 'building_upgrade',
          itemKey: buildingKey,
          metadata: { tier: next.tier },
        },
        tx,
      );
    }
    for (const cost of next.costItems) {
      await inventoryService.consume(player.id, cost.itemKey, cost.quantity, tx);
    }

    await animalRepo.upsertBuilding(
      {
        farmId: player.farmId,
        userId: player.id,
        buildingKey,
        tier: next.tier,
        capacity: next.capacity,
        slots: next.slots,
        speedMultiplier: next.speedMultiplier.toFixed(3),
        totalInvested: next.costCoins,
      },
      tx,
    );

    // Certains bâtiments modifient la ferme elle-même : entrepôt (capacité),
    // maison (énergie), serre, puits. On répercute immédiatement.
    const farmPatch: Record<string, unknown> = {};
    if (buildingKey === 'warehouse') farmPatch.warehouseCapacity = next.capacity;
    if (buildingKey === 'greenhouse') farmPatch.greenhouse = true;
    if (next.effect?.autoWaterRatio) farmPatch.autoWater = true;
    if (Object.keys(farmPatch).length > 0) {
      await playerRepo.updateFarm(player.farmId, farmPatch, tx);
    }
    if (buildingKey === 'house' && next.effect?.energyMax) {
      await playerRepo.setEnergy(
        player.id,
        { energy: player.energy, energyUpdatedAt: new Date(), energyMax: next.effect.energyMax },
        tx,
      );
    }

    // La somme des emplacements d'artisanat est recalculée à chaque changement.
    const totalSlots = await animalRepo.totalCraftingSlots(player.farmId, tx);
    await playerRepo.updateFarm(player.farmId, { craftingSlots: Math.max(1, totalSlots) }, tx);

    await economyService.trackSpending(
      { userId: player.id, coopId: player.coopId, level: player.level },
      next.costCoins,
      tx,
    );

    return {
      name: building.name,
      emoji: building.emoji,
      tier: next.tier,
      costCoins: next.costCoins,
      capacity: next.capacity,
      slots: next.slots,
      built: currentTier === 0,
    };
  });
}

/** Recettes disponibles pour l'autocomplétion. */
export function craftableRecipes(level: number, query: string): RecipeConfig[] {
  const needle = query.trim().toLowerCase();
  return getConfig()
    .recipeList.filter((recipe) => recipe.enabled && recipe.requiredLevel <= level)
    .filter((recipe) => !needle || recipe.name.toLowerCase().includes(needle) || recipe.key.includes(needle))
    .slice(0, 25);
}

export { getBalance as craftBalance };
