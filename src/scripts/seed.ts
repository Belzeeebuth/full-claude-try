import { getConfig, seedKeyOf } from '../config';
import { balance as getBalance } from '../config';
import { closeDatabase, getDb } from '../db/client';
import {
  achievementsConfig,
  animalsConfig,
  buildingsConfig,
  cropsConfig,
  eventsConfig,
  itemsConfig,
  questsConfig,
  recipesConfig,
  seasonPass,
} from '../db/schema';
import { referenceVolumeFor } from '../game/market';
import * as economyRepo from '../repositories/economy.repo';
import { ensureSeasonCalendar } from '../services/world.service';
import { rotateShop } from '../services/market.service';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('seed');

/**
 * Peuplement de la base à partir des fichiers de configuration.
 *
 * Idempotent : `INSERT ... ON CONFLICT DO UPDATE` partout. On peut donc le
 * rejouer après chaque modification de `src/config/gameplay/` — c'est d'ailleurs
 * ce que fait `/admin reload-config` pour la partie mémoire.
 *
 * ⚠️ Le seed ne touche JAMAIS aux données de joueurs : uniquement les tables
 * `*_config`, les prix de marché initiaux, le calendrier des saisons et la
 * boutique du jour.
 */
export async function seed(): Promise<Record<string, number>> {
  const config = getConfig();
  const balance = getBalance();
  const db = getDb();
  const counts: Record<string, number> = {};

  // --- Cultures ---------------------------------------------------------
  for (const crop of config.cropList) {
    await db
      .insert(cropsConfig)
      .values({
        key: crop.key,
        name: crop.name,
        emoji: crop.emoji,
        rarity: crop.rarity,
        seedPrice: crop.seedPrice,
        growthSeconds: crop.growthSeconds,
        baseYield: crop.baseYield,
        sellPrice: crop.sellPrice,
        requiredLevel: crop.requiredLevel,
        seasons: crop.seasons,
        qualityMultiplier: crop.qualityMultiplier.toFixed(2),
        waterRequired: crop.waterRequired,
        fertilityCost: crop.fertilityCost,
        xpReward: crop.xpReward,
        regrowCycles: crop.regrowCycles,
        regrowSeconds: crop.regrowSeconds,
        mutationChance: crop.mutationChance.toFixed(5),
        sprite: crop.sprite,
        description: crop.description,
        enabled: crop.enabled,
        sortOrder: crop.sortOrder,
      })
      .onConflictDoUpdate({
        target: cropsConfig.key,
        set: {
          name: crop.name,
          emoji: crop.emoji,
          rarity: crop.rarity,
          seedPrice: crop.seedPrice,
          growthSeconds: crop.growthSeconds,
          baseYield: crop.baseYield,
          sellPrice: crop.sellPrice,
          requiredLevel: crop.requiredLevel,
          seasons: crop.seasons,
          qualityMultiplier: crop.qualityMultiplier.toFixed(2),
          waterRequired: crop.waterRequired,
          fertilityCost: crop.fertilityCost,
          xpReward: crop.xpReward,
          regrowCycles: crop.regrowCycles,
          regrowSeconds: crop.regrowSeconds,
          mutationChance: crop.mutationChance.toFixed(5),
          description: crop.description,
          enabled: crop.enabled,
          sortOrder: crop.sortOrder,
          updatedAt: new Date(),
        },
      });
  }
  counts.crops = config.cropList.length;

  // --- Objets (explicites + graines/récoltes dérivées) -------------------
  for (const item of config.itemList) {
    const values = {
      key: item.key,
      name: item.name,
      emoji: item.emoji,
      category: item.category,
      rarity: item.rarity,
      basePrice: item.basePrice,
      sellPrice: item.sellPrice,
      priceGems: item.priceGems,
      stackable: item.stackable,
      maxStack: item.maxStack,
      tradable: item.tradable,
      sellable: item.sellable,
      marketTracked: item.marketTracked,
      effect: item.effect ?? null,
      requiredLevel: item.requiredLevel,
      sourceKey: item.sourceKey,
      collectionKey: item.collectionKey,
      sprite: item.sprite,
      description: item.description,
      enabled: item.enabled,
      sortOrder: item.sortOrder,
    };
    await db
      .insert(itemsConfig)
      .values(values)
      .onConflictDoUpdate({ target: itemsConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.items = config.itemList.length;

  // --- Bâtiments (avant les animaux et recettes, qui les référencent) ----
  for (const building of config.buildingList) {
    const values = {
      key: building.key,
      name: building.name,
      emoji: building.emoji,
      category: building.category,
      maxTier: building.maxTier,
      tiers: building.tiers,
      requiredLevel: building.requiredLevel,
      unlocksRecipes: building.unlocksRecipes,
      sprite: building.sprite,
      description: building.description,
      enabled: building.enabled,
      sortOrder: building.sortOrder,
    };
    await db
      .insert(buildingsConfig)
      .values(values)
      .onConflictDoUpdate({ target: buildingsConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.buildings = config.buildingList.length;

  // --- Animaux ----------------------------------------------------------
  for (const animal of config.animalList) {
    const values = {
      key: animal.key,
      name: animal.name,
      emoji: animal.emoji,
      rarity: animal.rarity,
      price: animal.price,
      priceGems: animal.priceGems,
      buildingKey: animal.buildingKey,
      productItemKey: animal.productItemKey,
      productQuantity: animal.productQuantity,
      productionSeconds: animal.productionSeconds,
      feedItemKey: animal.feedItemKey,
      feedPerCycle: animal.feedPerCycle,
      requiredLevel: animal.requiredLevel,
      lifespanDays: animal.lifespanDays,
      breedable: animal.breedable,
      breedingCooldownSeconds: animal.breedingCooldownSeconds,
      hungerRate: animal.hungerRate.toFixed(2),
      happinessRate: animal.happinessRate.toFixed(2),
      passiveBonus: animal.passiveBonus,
      eventOnly: animal.eventOnly,
      sprite: animal.sprite,
      description: animal.description,
      enabled: animal.enabled,
      sortOrder: animal.sortOrder,
    };
    await db
      .insert(animalsConfig)
      .values(values)
      .onConflictDoUpdate({ target: animalsConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.animals = config.animalList.length;

  // --- Recettes ---------------------------------------------------------
  for (const recipe of config.recipeList) {
    const values = {
      key: recipe.key,
      name: recipe.name,
      emoji: recipe.emoji,
      buildingKey: recipe.buildingKey,
      outputItemKey: recipe.outputItemKey,
      outputQuantity: recipe.outputQuantity,
      ingredients: recipe.ingredients,
      durationSeconds: recipe.durationSeconds,
      requiredLevel: recipe.requiredLevel,
      xpReward: recipe.xpReward,
      category: recipe.category,
      enabled: recipe.enabled,
      sortOrder: recipe.sortOrder,
    };
    await db
      .insert(recipesConfig)
      .values(values)
      .onConflictDoUpdate({ target: recipesConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.recipes = config.recipeList.length;

  // --- Quêtes -----------------------------------------------------------
  for (const quest of config.questList) {
    const values = {
      key: quest.key,
      type: quest.type,
      title: quest.title,
      description: quest.description,
      objectiveType: quest.objectiveType,
      objectiveTarget: quest.objectiveTarget,
      requiredAmount: quest.requiredAmount,
      rewardCoins: quest.rewardCoins,
      rewardGems: quest.rewardGems,
      rewardXp: quest.rewardXp,
      rewardItems: quest.rewardItems,
      rewardPassXp: quest.rewardPassXp,
      requiredLevel: quest.requiredLevel,
      chainKey: quest.chainKey,
      chainStep: quest.chainStep,
      weight: quest.weight,
      enabled: quest.enabled,
    };
    await db
      .insert(questsConfig)
      .values(values)
      .onConflictDoUpdate({ target: questsConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.quests = config.questList.length;

  // --- Succès -----------------------------------------------------------
  for (const achievement of config.achievementList) {
    const values = {
      key: achievement.key,
      name: achievement.name,
      description: achievement.description,
      category: achievement.category,
      icon: achievement.icon,
      tier: achievement.tier,
      conditionType: achievement.conditionType,
      conditionTarget: achievement.conditionTarget,
      conditionAmount: achievement.conditionAmount,
      rewardCoins: achievement.rewardCoins,
      rewardGems: achievement.rewardGems,
      rewardItems: achievement.rewardItems,
      rewardTitle: achievement.rewardTitle,
      rewardBadge: achievement.rewardBadge,
      hidden: achievement.hidden,
      enabled: achievement.enabled,
      sortOrder: achievement.sortOrder,
    };
    await db
      .insert(achievementsConfig)
      .values(values)
      .onConflictDoUpdate({
        target: achievementsConfig.key,
        set: { ...values, updatedAt: new Date() },
      });
  }
  counts.achievements = config.achievementList.length;

  // --- Événements -------------------------------------------------------
  for (const event of config.eventList) {
    const values = {
      key: event.key,
      name: event.name,
      description: event.description,
      type: event.type,
      startsAt: event.startsAt ? new Date(event.startsAt) : null,
      endsAt: event.endsAt ? new Date(event.endsAt) : null,
      recurringCron: event.recurringCron,
      banner: event.banner,
      modifiers: event.modifiers,
      rewardTiers: event.rewardTiers,
      shopItems: event.shopItems,
      currencyItemKey: event.currencyItemKey,
      enabled: event.enabled,
    };
    await db
      .insert(eventsConfig)
      .values(values)
      .onConflictDoUpdate({ target: eventsConfig.key, set: { ...values, updatedAt: new Date() } });
  }
  counts.events = config.eventList.length;

  // --- Passe saisonnier --------------------------------------------------
  for (const pass of config.seasonPasses) {
    const values = {
      id: pass.id,
      seasonKey: pass.seasonKey,
      name: pass.name,
      description: pass.description,
      startsAt: new Date(pass.startsAt),
      endsAt: new Date(pass.endsAt),
      maxTier: pass.maxTier,
      xpPerTier: pass.xpPerTier,
      tiers: pass.tiers,
      active: pass.active,
    };
    await db
      .insert(seasonPass)
      .values(values)
      .onConflictDoUpdate({ target: seasonPass.id, set: { ...values, updatedAt: new Date() } });
  }
  counts.seasonPasses = config.seasonPasses.length;

  // --- Prix de marché initiaux ------------------------------------------
  let marketRows = 0;
  for (const item of config.itemList) {
    if (!item.marketTracked || !item.enabled || item.sellPrice <= 0) continue;
    await economyRepo.upsertMarketPrice({
      itemKey: item.key,
      basePrice: item.sellPrice,
      currentPrice: item.sellPrice,
      previousPrice: item.sellPrice,
      referenceVolume: referenceVolumeFor(item.rarity, balance),
      volatility: balance.market.volatility.toFixed(4),
      priceFloorPct: balance.market.priceFloorPct.toFixed(4),
      priceCeilPct: balance.market.priceCeilPct.toFixed(4),
      nextUpdateAt: new Date(),
    });
    marketRows += 1;
  }
  counts.marketPrices = marketRows;

  // --- Monde ------------------------------------------------------------
  await ensureSeasonCalendar();
  counts.shopEntries = await rotateShop();

  // Vérification finale : chaque culture doit avoir sa graine.
  const missingSeeds = config.cropList.filter((crop) => !config.items.has(seedKeyOf(crop.key)));
  if (missingSeeds.length > 0) {
    throw new Error(`Graines manquantes : ${missingSeeds.map((crop) => crop.key).join(', ')}`);
  }

  return counts;
}

if (require.main === module) {
  seed()
    .then(async (counts) => {
      log.info(counts, '✅ base peuplée');
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      log.fatal({ err: error }, '❌ peuplement impossible');
      await closeDatabase();
      process.exit(1);
    });
}
