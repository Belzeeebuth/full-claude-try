import { balance as getBalance, getBuildingTier, getConfig, type AnimalConfig } from '../config';
import { lockUserRow, withTransaction, type Executor } from '../db/client';
import {
  breed as breedGenetics,
  collectQuantity,
  computeReadyProduction,
  feedCost,
  nextProductionAt,
  projectAnimal,
  sellValue,
  vetCost,
  type AnimalState,
  type AnimalStatus,
} from '../game/animals';
import { liveRng } from '../game/rng';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as animalRepo from '../repositories/animal.repo';
import * as playerRepo from '../repositories/player.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { consumeEnergy, getFarmModifiers, grantXp } from './player.service';
import { grantPassXp, mergeResults, passXpFor, trackAction, type TrackResult } from './tracker.service';
import { uuidv7 } from '../utils/uuid';
import type { PlayerContext } from '../types';

const log = moduleLogger('animals');

/**
 * Élevage : achat, nourrissage, collecte, soins, caresses, reproduction, vente.
 *
 * Comme pour les cultures, l'état des animaux est projeté à la lecture depuis
 * `statsUpdatedAt`. Toute action commence donc par `projectAnimal()` : les
 * jauges affichées et celles utilisées pour décider sont toujours les mêmes.
 */

export interface AnimalView {
  id: string;
  animalKey: string;
  name: string;
  nickname: string | null;
  emoji: string;
  status: AnimalStatus;
  productItemKey: string;
  productName: string;
  productEmoji: string;
  qualityMultiplier: number;
  generation: number;
  buildingKey: string;
  canCollect: boolean;
  canFeed: boolean;
  canPet: boolean;
  needsVet: boolean;
}

export interface HerdView {
  animals: AnimalView[];
  capacityByBuilding: Array<{
    buildingKey: string;
    name: string;
    emoji: string;
    used: number;
    capacity: number;
    tier: number;
  }>;
  totals: { alive: number; hungry: number; sick: number; readyToCollect: number };
}

function toAnimalState(row: animalRepo.OwnedAnimalRow): AnimalState {
  return {
    animalKey: row.animalKey,
    hunger: row.hunger,
    happiness: row.happiness,
    health: row.health,
    statsUpdatedAt: row.statsUpdatedAt,
    lastFedAt: row.lastFedAt,
    lastCollectedAt: row.lastCollectedAt,
    lastPettedAt: row.lastPettedAt,
    productionReadyAt: row.productionReadyAt,
    pendingProduction: row.pendingProduction,
    qualityMultiplier: Number(row.qualityMultiplier),
    isSick: row.isSick,
    isAlive: row.isAlive,
    bornAt: row.bornAt,
  };
}

export async function getHerd(
  player: Pick<PlayerContext, 'id' | 'farmId' | 'locale'>,
  now: Date = new Date(),
): Promise<HerdView> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const [rows, buildings] = await Promise.all([
    animalRepo.listAnimals(player.farmId),
    animalRepo.listBuildings(player.farmId),
  ]);

  const animals: AnimalView[] = [];
  const totals = { alive: 0, hungry: 0, sick: 0, readyToCollect: 0 };

  for (const row of rows) {
    const animalConfig = config.animals.get(row.animalKey);
    if (!animalConfig) continue;
    const status = projectAnimal(toAnimalState(row.animal), animalConfig, now, balance);
    const product = config.items.get(animalConfig.productItemKey);

    totals.alive += 1;
    if (status.hungry) totals.hungry += 1;
    if (status.sick) totals.sick += 1;
    if (status.readyProduction > 0 && status.productionFactor > 0) totals.readyToCollect += 1;

    animals.push({
      id: row.animal.id,
      animalKey: row.animalKey,
      // `row.name` vient de la jointure SQL : le seed la peuple en français.
      name: animalConfig.name,
      nickname: row.animal.nickname,
      emoji: row.emoji,
      status,
      productItemKey: animalConfig.productItemKey,
      productName: product?.name ?? animalConfig.productItemKey,
      productEmoji: product?.emoji ?? '📦',
      qualityMultiplier: Number(row.animal.qualityMultiplier),
      generation: row.animal.generation,
      buildingKey: animalConfig.buildingKey,
      canCollect: status.readyProduction > 0 && status.productionFactor > 0,
      canFeed: status.hunger < 95,
      canPet:
        !row.animal.lastPettedAt ||
        now.getTime() - row.animal.lastPettedAt.getTime() >=
          balance.animals.petCooldownSeconds * 1_000,
      needsVet: status.sick,
    });
  }

  const capacityByBuilding = buildings
    .filter((entry) => entry.category === 'livestock')
    .map((entry) => ({
      buildingKey: entry.buildingKey,
      name: config.buildings.get(entry.buildingKey)?.name ?? entry.name,
      emoji: entry.emoji,
      used: animals.filter((animal) => animal.buildingKey === entry.buildingKey).length,
      capacity: entry.building.capacity,
      tier: entry.building.tier,
    }));

  return { animals, capacityByBuilding, totals };
}

// ---------------------------------------------------------------------------
// ACHAT
// ---------------------------------------------------------------------------

export async function buyAnimal(
  player: PlayerContext,
  input: { animalKey: string; quantity?: number; discordGuildId?: string },
): Promise<{ animalKey: string; name: string; emoji: string; quantity: number; total: number; currency: 'coins' | 'gems' }> {
  const config = getConfig(player.locale);
  const animalConfig = config.animals.get(input.animalKey);
  if (!animalConfig || !animalConfig.enabled) {
    throw gameError('animal_not_found', `Unknown species: \`${input.animalKey}\`.`, {
      i18nKey: 'errors.animal.unknown_species',
      params: { animalKey: input.animalKey },
    });
  }
  if (animalConfig.eventOnly) {
    throw gameError(
      'forbidden',
      `${animalConfig.emoji} ${animalConfig.name} can only be obtained during an event.`,
      {
        i18nKey: 'errors.animal.event_only',
        params: { emoji: animalConfig.emoji, name: animalConfig.name },
        suggestedCommand: 'event',
      },
    );
  }
  if (player.level < animalConfig.requiredLevel) {
    throw gameError(
      'level_too_low',
      `${animalConfig.emoji} ${animalConfig.name} requires level ${animalConfig.requiredLevel}.`,
      {
        i18nKey: 'errors.level_too_low',
        params: { name: animalConfig.name, level: animalConfig.requiredLevel },
      },
    );
  }

  const quantity = Math.max(1, Math.min(10, input.quantity ?? 1));
  const buildingConfig = config.buildings.get(animalConfig.buildingKey);
  const currency: 'coins' | 'gems' = animalConfig.price > 0 ? 'coins' : 'gems';
  const unitPrice = currency === 'coins' ? animalConfig.price : animalConfig.priceGems;

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);

    const building = await animalRepo.getBuilding(player.farmId, animalConfig.buildingKey, tx);
    if (!building) {
      throw gameError(
        'building_required',
        `You need a ${buildingConfig?.emoji ?? ''} ${buildingConfig?.name ?? animalConfig.buildingKey} to house this animal.`,
        {
          i18nKey: 'errors.animal.building_required',
          hintKey: 'errors.craft.building_required_hint',
          params: {
            emoji: buildingConfig?.emoji ?? '',
            name: buildingConfig?.name ?? animalConfig.buildingKey,
          },
          suggestedCommand: 'buildings',
        },
      );
    }

    const used = await animalRepo.countAnimalsInBuilding(
      player.farmId,
      animalConfig.buildingKey,
      tx,
    );
    if (used + quantity > building.capacity) {
      throw gameError(
        'building_full',
        `Your ${buildingConfig?.name ?? 'building'} is full (${used}/${building.capacity}).`,
        {
          i18nKey: 'errors.animal.building_full',
          hintKey: 'errors.animal.building_full_hint',
          params: { name: buildingConfig?.name ?? 'building', used, capacity: building.capacity },
        },
      );
    }

    const total = unitPrice * quantity;
    await economyService.charge(
      {
        userId: player.id,
        amount: total,
        type: 'animal_purchase',
        currency,
        itemKey: input.animalKey,
        quantity,
        unitPrice,
        discordGuildId: input.discordGuildId,
      },
      tx,
    );

    const now = new Date();
    for (let index = 0; index < quantity; index += 1) {
      await animalRepo.insertAnimal(
        {
          farmId: player.farmId,
          userId: player.id,
          animalKey: input.animalKey,
          buildingId: building.id,
          hunger: 100,
          happiness: 80,
          health: 100,
          statsUpdatedAt: now,
          bornAt: now,
          productionReadyAt: nextProductionAt(
            animalConfig,
            now,
            Number(building.speedMultiplier),
          ),
          purchasePrice: unitPrice,
        },
        tx,
      );
    }

    await playerRepo.incrementStats(player.id, { totalAnimalsRaised: quantity }, tx);
    if (currency === 'coins') {
      await economyService.trackSpending(
        { userId: player.id, coopId: player.coopId, level: player.level },
        total,
        tx,
      );
    }

    return {
      animalKey: input.animalKey,
      name: animalConfig.name,
      emoji: animalConfig.emoji,
      quantity,
      total,
      currency,
    };
  });
}

// ---------------------------------------------------------------------------
// NOURRIR
// ---------------------------------------------------------------------------

export async function feed(
  player: PlayerContext,
  input: { animalId?: string; all?: boolean },
): Promise<{ fed: number; consumed: Array<{ itemKey: string; quantity: number }>; tracking: TrackResult }> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();
  const modifiers = await getFarmModifiers(player, { now });

  return withTransaction(async (tx) => {
    const rows = await animalRepo.listAnimals(player.farmId, {}, tx);
    const targets = rows.filter((row) => {
      if (input.animalId && row.animal.id !== input.animalId) return false;
      const animalConfig = config.animals.get(row.animalKey);
      if (!animalConfig) return false;
      const status = projectAnimal(toAnimalState(row.animal), animalConfig, now, balance);
      return status.hunger < 95 && row.animal.isAlive;
    });

    if (targets.length === 0) {
      throw gameError('animal_not_hungry', "No animal is hungry right now.", {
        i18nKey: 'errors.animal.none_hungry',
      });
    }

    const selected = input.all ? targets : targets.slice(0, 1);

    // Agrégation des besoins : on consomme le foin en une seule opération plutôt
    // qu'une par animal, ce qui évite 20 requêtes pour un troupeau de 20 bêtes.
    const needs = new Map<string, number>();
    for (const row of selected) {
      const animalConfig = config.animals.get(row.animalKey);
      if (!animalConfig) continue;
      const cost = feedCost(animalConfig);
      needs.set(cost.itemKey, (needs.get(cost.itemKey) ?? 0) + cost.quantity);
    }

    for (const [itemKey, quantity] of needs) {
      await inventoryService.consume(player.id, itemKey, quantity, tx, player.locale);
    }

    await consumeEnergy(player.id, 'feed', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    for (const row of selected) {
      const animalConfig = config.animals.get(row.animalKey);
      if (!animalConfig) continue;
      const status = projectAnimal(toAnimalState(row.animal), animalConfig, now, balance);
      await animalRepo.updateAnimal(
        row.animal.id,
        {
          hunger: Math.min(100, status.hunger + balance.animals.feedHungerGain),
          happiness: Math.min(100, status.happiness + 3),
          health: status.health,
          statsUpdatedAt: now,
          lastFedAt: now,
        },
        tx,
      );
    }

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'feed_animal',
      selected.length,
      {},
      tx,
    );

    return {
      fed: selected.length,
      consumed: [...needs.entries()].map(([itemKey, quantity]) => ({ itemKey, quantity })),
      tracking,
    };
  });
}

// ---------------------------------------------------------------------------
// COLLECTER
// ---------------------------------------------------------------------------

export interface CollectResult {
  lines: Array<{ animalKey: string; name: string; itemKey: string; itemName: string; emoji: string; quantity: number }>;
  totalQuantity: number;
  xpGained: number;
  levelUp: { level: number; levelsGained: number } | null;
  tracking: TrackResult;
}

export async function collect(
  player: PlayerContext,
  input: { animalId?: string; all?: boolean },
): Promise<CollectResult> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();
  const modifiers = await getFarmModifiers(player, { now });

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const rows = await animalRepo.listAnimals(player.farmId, {}, tx);

    const collectable = rows.filter((row) => {
      if (input.animalId && row.animal.id !== input.animalId) return false;
      const animalConfig = config.animals.get(row.animalKey);
      if (!animalConfig) return false;
      const status = projectAnimal(toAnimalState(row.animal), animalConfig, now, balance);
      return status.readyProduction > 0 && status.productionFactor > 0;
    });

    if (collectable.length === 0) {
      throw gameError('animal_not_ready', 'No production available.', {
        i18nKey: 'animals.nothing_to_collect',
        hintKey: 'errors.animal.nothing_to_collect_hint',
        suggestedCommand: 'animals',
      });
    }

    const selected = input.all ? collectable : collectable.slice(0, 1);
    await consumeEnergy(player.id, 'collect', tx, {
      quantity: 1,
      costReduction: modifiers.energyCostReduction,
      now,
    });

    const lines: CollectResult['lines'] = [];
    let totalQuantity = 0;
    let xpTotal = 0;
    const trackings: TrackResult[] = [];

    for (const row of selected) {
      const animalConfig = config.animals.get(row.animalKey);
      if (!animalConfig) continue;
      const state = toAnimalState(row.animal);
      const status = projectAnimal(state, animalConfig, now, balance);
      const cycles = computeReadyProduction(state, animalConfig, now, balance);
      const quantity = collectQuantity(animalConfig, status, state, cycles);
      if (quantity <= 0) continue;

      const product = config.items.get(animalConfig.productItemKey);
      await inventoryService.addItems(
        player.id,
        [{ itemKey: animalConfig.productItemKey, quantity }],
        tx,
        { allowOverflow: true },
      );

      const building = row.animal.buildingId
        ? await animalRepo.getBuilding(player.farmId, animalConfig.buildingKey, tx)
        : undefined;

      await animalRepo.updateAnimal(
        row.animal.id,
        {
          pendingProduction: 0,
          productionReadyAt: nextProductionAt(
            animalConfig,
            now,
            Number(building?.speedMultiplier ?? 1) * modifiers.animalSpeedMultiplier,
          ),
          lastCollectedAt: now,
          totalProduced: row.animal.totalProduced + quantity,
          hunger: status.hunger,
          happiness: status.happiness,
          health: status.health,
          statsUpdatedAt: now,
        },
        tx,
      );

      // L'XP de collecte est proportionnelle à la valeur du produit : un œuf
      // rapporte moins qu'une écaille de dragon, ce qui reste cohérent avec le
      // reste de la progression.
      const xp = Math.max(1, Math.round(Math.sqrt((product?.sellPrice ?? 10) * quantity)));
      xpTotal += xp;

      lines.push({
        animalKey: row.animalKey,
        name: row.animal.nickname ?? animalConfig.name,
        itemKey: animalConfig.productItemKey,
        itemName: product?.name ?? animalConfig.productItemKey,
        emoji: product?.emoji ?? '📦',
        quantity,
      });
      totalQuantity += quantity;

      trackings.push(
        await trackAction(
          { userId: player.id, coopId: player.coopId, level: player.level },
          'collect_animal',
          quantity,
          { animalKey: row.animalKey },
          tx,
        ),
      );
    }

    const xpResult = xpTotal > 0 ? await grantXp(player.id, xpTotal, tx) : null;
    await grantPassXp(player.id, passXpFor(xpTotal), tx);

    return {
      lines,
      totalQuantity,
      xpGained: xpTotal,
      levelUp:
        xpResult && xpResult.levelsGained > 0
          ? { level: xpResult.level, levelsGained: xpResult.levelsGained }
          : null,
      tracking: mergeResults(trackings),
    };
  });
}

// ---------------------------------------------------------------------------
// CARESSER / SOIGNER / VENDRE / REPRODUIRE
// ---------------------------------------------------------------------------

export async function pet(
  player: PlayerContext,
  animalId: string,
): Promise<{ name: string; emoji: string; happiness: number; gain: number; tracking: TrackResult }> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();

  return withTransaction(async (tx) => {
    const row = await animalRepo.lockAnimal(tx, animalId, player.id);
    if (!row) throw gameError('animal_not_found', 'Animal not found.', { i18nKey: 'errors.animal.not_found' });
    if (!row.isAlive) {
      throw gameError('animal_dead', 'This animal has died.', { i18nKey: 'errors.animal.dead' });
    }

    const animalConfig = config.animals.get(row.animalKey);
    if (!animalConfig) {
      throw gameError('animal_not_found', 'Unknown species.', {
        i18nKey: 'errors.animal.unknown_species_generic',
      });
    }

    if (
      row.lastPettedAt &&
      now.getTime() - row.lastPettedAt.getTime() < balance.animals.petCooldownSeconds * 1_000
    ) {
      throw gameError('cooldown', 'This animal has had its share of affection recently.', {
        i18nKey: 'errors.animal.pet_cooldown',
      });
    }

    const status = projectAnimal(toAnimalState(row), animalConfig, now, balance);
    const gain = balance.animals.petHappinessGain;
    await animalRepo.updateAnimal(
      animalId,
      {
        happiness: Math.min(100, status.happiness + gain),
        hunger: status.hunger,
        health: status.health,
        statsUpdatedAt: now,
        lastPettedAt: now,
      },
      tx,
    );

    const tracking = await trackAction(
      { userId: player.id, coopId: player.coopId, level: player.level },
      'pet_animal',
      1,
      {},
      tx,
    );

    return {
      name: row.nickname ?? animalConfig.name,
      emoji: animalConfig.emoji,
      happiness: Math.min(100, status.happiness + gain),
      gain,
      tracking,
    };
  });
}

export async function heal(
  player: PlayerContext,
  animalId: string,
): Promise<{ name: string; emoji: string; cost: number }> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const row = await animalRepo.lockAnimal(tx, animalId, player.id);
    if (!row) throw gameError('animal_not_found', 'Animal not found.', { i18nKey: 'errors.animal.not_found' });
    if (!row.isAlive) {
      throw gameError('animal_dead', 'This animal has died.', { i18nKey: 'errors.animal.dead' });
    }

    const animalConfig = config.animals.get(row.animalKey);
    if (!animalConfig) {
      throw gameError('animal_not_found', 'Unknown species.', {
        i18nKey: 'errors.animal.unknown_species_generic',
      });
    }

    const status = projectAnimal(toAnimalState(row), animalConfig, now, balance);
    if (!status.sick && status.health >= 95) {
      throw gameError('invalid_state', `${animalConfig.name} is in perfect shape.`, {
        i18nKey: 'errors.animal.perfect_shape',
        params: { name: animalConfig.name },
      });
    }

    const cost = vetCost(animalConfig, balance);
    await economyService.charge(
      { userId: player.id, amount: cost, type: 'vet_cost', itemKey: row.animalKey },
      tx,
    );
    await animalRepo.updateAnimal(
      animalId,
      {
        health: 100,
        isSick: false,
        hunger: Math.max(status.hunger, 40),
        happiness: status.happiness,
        statsUpdatedAt: now,
        lastTreatedAt: now,
      },
      tx,
    );

    return { name: row.nickname ?? animalConfig.name, emoji: animalConfig.emoji, cost };
  });
}

export async function sellAnimal(
  player: PlayerContext,
  animalId: string,
): Promise<{ name: string; emoji: string; price: number }> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const row = await animalRepo.lockAnimal(tx, animalId, player.id);
    if (!row) throw gameError('animal_not_found', 'Animal not found.', { i18nKey: 'errors.animal.not_found' });
    if (!row.isAlive) {
      throw gameError('animal_dead', 'This animal has died.', { i18nKey: 'errors.animal.dead' });
    }

    const animalConfig = config.animals.get(row.animalKey);
    if (!animalConfig) {
      throw gameError('animal_not_found', 'Unknown species.', {
        i18nKey: 'errors.animal.unknown_species_generic',
      });
    }

    const status = projectAnimal(toAnimalState(row), animalConfig, now, balance);
    const price = sellValue(animalConfig, status, balance);

    await animalRepo.deleteAnimal(animalId, tx);
    await economyService.pay(
      { userId: player.id, amount: price, type: 'animal_sale', itemKey: row.animalKey, quantity: 1 },
      tx,
    );

    return { name: row.nickname ?? animalConfig.name, emoji: animalConfig.emoji, price };
  });
}

export async function breed(
  player: PlayerContext,
  input: { animalAId: string; animalBId: string },
): Promise<{
  success: boolean;
  reasonKey?: string;
  reasonParams?: Record<string, string | number>;
  childId?: string;
  qualityMultiplier?: number;
  generation?: number;
  cost: number;
}> {
  const config = getConfig(player.locale);
  const balance = getBalance();
  const now = new Date();

  if (input.animalAId === input.animalBId) {
    throw gameError('breeding_unavailable', 'You need two different animals.', {
      i18nKey: 'errors.animal.need_two_different',
    });
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    // Verrous pris dans un ordre déterministe (tri des identifiants) : deux
    // reproductions simultanées impliquant les mêmes animaux ne s'interbloquent pas.
    const [firstId, secondId] = [input.animalAId, input.animalBId].sort();
    const first = await animalRepo.lockAnimal(tx, firstId!, player.id);
    const second = await animalRepo.lockAnimal(tx, secondId!, player.id);
    if (!first || !second) {
      throw gameError('animal_not_found', 'Animal not found.', { i18nKey: 'errors.animal.not_found' });
    }
    if (first.animalKey !== second.animalKey) {
      throw gameError('breeding_unavailable', 'Both animals must be of the same species.', {
        i18nKey: 'errors.animal.same_species_required',
      });
    }

    const animalConfig = config.animals.get(first.animalKey);
    if (!animalConfig) {
      throw gameError('animal_not_found', 'Unknown species.', {
        i18nKey: 'errors.animal.unknown_species_generic',
      });
    }
    if (!animalConfig.breedable) {
      throw gameError('breeding_unavailable', `${animalConfig.name} does not breed.`, {
        i18nKey: 'errors.animal.cannot_breed',
        params: { name: animalConfig.name },
      });
    }

    for (const parent of [first, second]) {
      if (
        parent.lastBredAt &&
        now.getTime() - parent.lastBredAt.getTime() <
          animalConfig.breedingCooldownSeconds * 1_000 * (1 - (animalConfig.passiveBonus.breedingSpeed ?? 0))
      ) {
        throw gameError('cooldown', `${animalConfig.name} must rest before another litter.`, {
          i18nKey: 'errors.animal.breeding_cooldown',
          params: { name: animalConfig.name },
        });
      }
    }

    const building = await animalRepo.getBuilding(player.farmId, animalConfig.buildingKey, tx);
    const used = await animalRepo.countAnimalsInBuilding(player.farmId, animalConfig.buildingKey, tx);
    if (!building || used + 1 > building.capacity) {
      throw gameError('building_full', 'No free space for the offspring.', {
        i18nKey: 'errors.animal.no_space_offspring',
      });
    }

    const cost = balance.animals.breedingCostCoins;
    await economyService.charge({ userId: player.id, amount: cost, type: 'feed_cost' }, tx);
    await consumeEnergy(player.id, 'breed', tx, { now });

    const statusA = projectAnimal(toAnimalState(first), animalConfig, now, balance);
    const statusB = projectAnimal(toAnimalState(second), animalConfig, now, balance);

    const outcome = breedGenetics(
      { qualityMultiplier: Number(first.qualityMultiplier), generation: first.generation, status: statusA },
      { qualityMultiplier: Number(second.qualityMultiplier), generation: second.generation, status: statusB },
      animalConfig,
      balance,
      liveRng(`${first.id}:${second.id}`),
    );

    await animalRepo.updateAnimals([first.id, second.id], { lastBredAt: now }, tx);

    if (!outcome.success) {
      return { success: false, reasonKey: outcome.reasonKey, reasonParams: outcome.reasonParams, cost };
    }

    const childId = uuidv7();
    await animalRepo.insertAnimal(
      {
        id: childId,
        farmId: player.farmId,
        userId: player.id,
        animalKey: first.animalKey,
        buildingId: building.id,
        hunger: 100,
        happiness: 90,
        health: 100,
        statsUpdatedAt: now,
        bornAt: now,
        productionReadyAt: nextProductionAt(animalConfig, now, Number(building.speedMultiplier)),
        qualityMultiplier: outcome.qualityMultiplier.toFixed(3),
        generation: outcome.generation,
        parentAId: first.id,
        parentBId: second.id,
        purchasePrice: 0,
      } as never,
      tx,
    );

    await playerRepo.incrementStats(player.id, { totalAnimalsRaised: 1 }, tx);
    log.debug({ userId: player.id, animalKey: first.animalKey, generation: outcome.generation }, 'naissance');

    return {
      success: true,
      childId,
      qualityMultiplier: outcome.qualityMultiplier,
      generation: outcome.generation,
      cost,
    };
  });
}

/** Animaux achetables par un joueur, pour l'autocomplétion. */
export function purchasableAnimals(level: number, query: string, locale?: string): AnimalConfig[] {
  const needle = query.trim().toLowerCase();
  return getConfig(locale)
    .animalList.filter(
      (animal) => animal.enabled && !animal.eventOnly && animal.requiredLevel <= level,
    )
    .filter((animal) => !needle || animal.name.toLowerCase().includes(needle) || animal.key.includes(needle))
    .slice(0, 25);
}

/** Capacité restante d'un bâtiment d'élevage, pour les messages d'aide. */
export async function buildingCapacity(
  farmId: string,
  buildingKey: string,
): Promise<{ used: number; capacity: number } | undefined> {
  const building = await animalRepo.getBuilding(farmId, buildingKey);
  if (!building) return undefined;
  const used = await animalRepo.countAnimalsInBuilding(farmId, buildingKey);
  return { used, capacity: building.capacity };
}

export { getBuildingTier };
