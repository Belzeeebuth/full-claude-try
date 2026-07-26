import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { moduleLogger } from '../utils/logger';
import {
  achievementSchema,
  animalSchema,
  balanceSchema,
  buildingSchema,
  cropSchema,
  eventSchema,
  itemSchema,
  questSchema,
  recipeSchema,
  seasonPassSchema,
  type AchievementConfig,
  type AnimalConfig,
  type Balance,
  type BuildingConfig,
  type BuildingTier,
  type CropConfig,
  type EventConfig,
  type ItemConfig,
  type QuestConfig,
  type RecipeConfig,
  type SeasonPassConfig,
} from './gameplay/schemas';

const log = moduleLogger('config');

/**
 * ---------------------------------------------------------------------------
 * CHARGEUR DE CONFIGURATION DE GAMEPLAY
 * ---------------------------------------------------------------------------
 * Le contenu du jeu (cultures, animaux, objets, recettes, bâtiments, quêtes,
 * succès, événements, équilibrage) vit dans des fichiers JSON, pas dans le code.
 * Conséquences concrètes :
 *  - un game designer peut rééquilibrer sans savoir écrire du TypeScript ;
 *  - `/admin reload-config` applique les changements SANS redéploiement ;
 *  - la validation Zod est stricte : une config cassée est REFUSÉE et l'ancienne
 *    reste en place (jamais de bot à moitié configuré en production) ;
 *  - les références croisées sont vérifiées (une recette ne peut pas produire un
 *    objet inexistant), donc les fautes de frappe explosent au démarrage et non
 *    à 3 h du matin quand un joueur clique.
 *
 * Les objets « graine » et « récolte » ne sont PAS écrits à la main : ils sont
 * dérivés de `crops.json`. Une culture = une graine + une récolte, toujours
 * cohérentes, impossible d'en oublier une.
 */

const GAMEPLAY_DIR = join(__dirname, 'gameplay');

export interface GameConfig {
  balance: Balance;
  crops: Map<string, CropConfig>;
  cropList: CropConfig[];
  animals: Map<string, AnimalConfig>;
  animalList: AnimalConfig[];
  /** Objets explicites + graines et récoltes dérivées des cultures. */
  items: Map<string, ItemConfig>;
  itemList: ItemConfig[];
  recipes: Map<string, RecipeConfig>;
  recipeList: RecipeConfig[];
  buildings: Map<string, BuildingConfig>;
  buildingList: BuildingConfig[];
  quests: Map<string, QuestConfig>;
  questList: QuestConfig[];
  achievements: Map<string, AchievementConfig>;
  achievementList: AchievementConfig[];
  events: Map<string, EventConfig>;
  eventList: EventConfig[];
  seasonPasses: SeasonPassConfig[];
  /** Instant du dernier chargement réussi (affiché par `/admin stats`). */
  loadedAt: Date;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readJson(fileName: string): unknown {
  const path = join(GAMEPLAY_DIR, fileName);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigError(`Impossible de lire ${fileName} : ${(error as Error).message}`);
  }
}

function parseArray<T>(fileName: string, schema: z.ZodType<T>): T[] {
  const raw = readJson(fileName);
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${fileName} doit contenir un tableau JSON`);
  }
  const issues: string[] = [];
  const parsed: T[] = [];
  raw.forEach((entry, index) => {
    const result = schema.safeParse(entry);
    if (result.success) {
      parsed.push(result.data);
    } else {
      const label =
        entry && typeof entry === 'object' && 'key' in entry
          ? String((entry as { key: unknown }).key)
          : `#${index}`;
      for (const issue of result.error.issues) {
        issues.push(`${fileName} [${label}] ${issue.path.join('.') || '(racine)'} : ${issue.message}`);
      }
    }
  });
  if (issues.length > 0) {
    throw new ConfigError(`${issues.length} erreur(s) dans ${fileName}`, issues);
  }
  return parsed;
}

function indexBy<T extends { key: string }>(entries: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    if (map.has(entry.key)) {
      throw new ConfigError(`Duplicate key: "${entry.key}"`);
    }
    map.set(entry.key, entry);
  }
  return map;
}

/** Clé de l'objet graine correspondant à une culture. */
export function seedKeyOf(cropKey: string): string {
  return `seed_${cropKey}`;
}

/** Clé de l'objet récolté correspondant à une culture (identique à la culture). */
export function harvestKeyOf(cropKey: string): string {
  return cropKey;
}

/**
 * Dérive les objets « graine » et « récolte » depuis les cultures.
 * Le prix de rachat d'une graine est 40 % de son prix d'achat : revendre ses
 * graines est donc toujours perdant, ce qui ferme un exploit classique
 * (acheter en masse pendant une promo, revendre au prix plein).
 */
export function deriveCropItems(crops: CropConfig[]): ItemConfig[] {
  const derived: ItemConfig[] = [];
  for (const crop of crops) {
    derived.push(
      itemSchema.parse({
        key: seedKeyOf(crop.key),
        name: `Graines de ${crop.name.toLowerCase()}`,
        emoji: crop.emoji,
        category: 'seed',
        rarity: crop.rarity,
        basePrice: crop.seedPrice,
        sellPrice: Math.max(1, Math.floor(crop.seedPrice * 0.4)),
        marketTracked: false,
        requiredLevel: crop.requiredLevel,
        sourceKey: crop.key,
        description: `Se plante avec /plant. Pousse en ${Math.round(crop.growthSeconds / 60)} min.`,
        sortOrder: 100_000 + crop.sortOrder,
        enabled: crop.enabled,
      }),
      itemSchema.parse({
        key: harvestKeyOf(crop.key),
        name: crop.name,
        emoji: crop.emoji,
        category: 'harvest',
        rarity: crop.rarity,
        basePrice: 0,
        sellPrice: crop.sellPrice,
        marketTracked: true,
        requiredLevel: crop.requiredLevel,
        sourceKey: crop.key,
        description: crop.description ?? `Harvested ${crop.name.toLowerCase()}.`,
        sortOrder: 200_000 + crop.sortOrder,
        enabled: crop.enabled,
      }),
    );
  }
  return derived;
}

/**
 * Vérifie toutes les références croisées entre fichiers.
 * C'est LA raison d'être de ce module : sans ce contrôle, une faute de frappe
 * dans `animals.json` (`"productItemKey": "milkk"`) passerait inaperçue jusqu'à
 * ce qu'un joueur essaie de collecter du lait.
 */
function validateReferences(config: Omit<GameConfig, 'loadedAt'>): void {
  const issues: string[] = [];
  const has = (map: Map<string, unknown>, key: string): boolean => map.has(key);

  for (const animal of config.animalList) {
    if (!has(config.buildings, animal.buildingKey)) {
      issues.push(`animals.json [${animal.key}] bâtiment inconnu : ${animal.buildingKey}`);
    }
    if (!has(config.items, animal.productItemKey)) {
      issues.push(`animals.json [${animal.key}] objet produit inconnu : ${animal.productItemKey}`);
    }
    if (!has(config.items, animal.feedItemKey)) {
      issues.push(`animals.json [${animal.key}] nourriture inconnue : ${animal.feedItemKey}`);
    }
  }

  for (const recipe of config.recipeList) {
    if (!has(config.buildings, recipe.buildingKey)) {
      issues.push(`recipes.json [${recipe.key}] bâtiment inconnu : ${recipe.buildingKey}`);
    }
    if (!has(config.items, recipe.outputItemKey)) {
      issues.push(`recipes.json [${recipe.key}] objet produit inconnu : ${recipe.outputItemKey}`);
    }
    for (const ingredient of recipe.ingredients) {
      if (!has(config.items, ingredient.itemKey)) {
        issues.push(`recipes.json [${recipe.key}] unknown ingredient: ${ingredient.itemKey}`);
      }
    }
    const building = config.buildings.get(recipe.buildingKey);
    if (building && !building.unlocksRecipes.includes(recipe.key)) {
      issues.push(
        `buildings.json [${building.key}] does not declare recipe "${recipe.key}" in unlocksRecipes`,
      );
    }
  }

  for (const building of config.buildingList) {
    for (const recipeKey of building.unlocksRecipes) {
      if (!has(config.recipes, recipeKey)) {
        issues.push(`buildings.json [${building.key}] recette inconnue : ${recipeKey}`);
      }
    }
    for (const tier of building.tiers) {
      for (const cost of tier.costItems) {
        if (!has(config.items, cost.itemKey)) {
          issues.push(
            `buildings.json [${building.key}] tier ${tier.tier}: unknown material ${cost.itemKey}`,
          );
        }
      }
    }
  }

  const checkTarget = (
    source: string,
    label: string,
    target: { cropKey?: string; itemKey?: string; animalKey?: string; recipeKey?: string },
  ): void => {
    if (target.cropKey && !has(config.crops, target.cropKey)) {
      issues.push(`${source} [${label}] culture inconnue : ${target.cropKey}`);
    }
    if (target.itemKey && !has(config.items, target.itemKey)) {
      issues.push(`${source} [${label}] objet inconnu : ${target.itemKey}`);
    }
    if (target.animalKey && !has(config.animals, target.animalKey)) {
      issues.push(`${source} [${label}] animal inconnu : ${target.animalKey}`);
    }
    if (target.recipeKey && !has(config.recipes, target.recipeKey)) {
      issues.push(`${source} [${label}] recette inconnue : ${target.recipeKey}`);
    }
  };

  for (const quest of config.questList) {
    checkTarget('quests.json', quest.key, quest.objectiveTarget);
    for (const reward of quest.rewardItems) {
      if (!has(config.items, reward.itemKey)) {
        issues.push(`quests.json [${quest.key}] unknown reward: ${reward.itemKey}`);
      }
    }
  }

  for (const achievement of config.achievementList) {
    checkTarget('achievements.json', achievement.key, achievement.conditionTarget);
    for (const reward of achievement.rewardItems) {
      if (!has(config.items, reward.itemKey)) {
        issues.push(
          `achievements.json [${achievement.key}] unknown reward: ${reward.itemKey}`,
        );
      }
    }
  }

  for (const event of config.eventList) {
    if (event.currencyItemKey && !has(config.items, event.currencyItemKey)) {
      issues.push(`events.json [${event.key}] monnaie inconnue : ${event.currencyItemKey}`);
    }
    for (const shopItem of event.shopItems) {
      if (!has(config.items, shopItem.itemKey)) {
        issues.push(`events.json [${event.key}] objet de boutique inconnu : ${shopItem.itemKey}`);
      }
      if (shopItem.currencyItemKey && !has(config.items, shopItem.currencyItemKey)) {
        issues.push(
          `events.json [${event.key}] monnaie de boutique inconnue : ${shopItem.currencyItemKey}`,
        );
      }
    }
    for (const tier of event.rewardTiers) {
      for (const reward of tier.rewards.items ?? []) {
        if (!has(config.items, reward.itemKey)) {
          issues.push(`events.json [${event.key}] unknown reward: ${reward.itemKey}`);
        }
      }
      if (tier.rewards.animalKey && !has(config.animals, tier.rewards.animalKey)) {
        issues.push(`events.json [${event.key}] animal inconnu : ${tier.rewards.animalKey}`);
      }
    }
    for (const cropKey of Object.keys(event.modifiers.cropPriceMultipliers ?? {})) {
      if (!has(config.items, cropKey)) {
        issues.push(`events.json [${event.key}] multiplicateur sur objet inconnu : ${cropKey}`);
      }
    }
  }

  for (const pass of config.seasonPasses) {
    for (const tier of pass.tiers) {
      for (const reward of [...(tier.free.items ?? []), ...(tier.premium.items ?? [])]) {
        if (!has(config.items, reward.itemKey)) {
          issues.push(`season-pass.json [${pass.id}] palier ${tier.tier} : objet inconnu ${reward.itemKey}`);
        }
      }
    }
  }

  // Cohérence de l'équilibrage
  const balance = config.balance;
  if (balance.plots.startingUnlocked > balance.plots.maxPlots) {
    issues.push('balance.json : plots.startingUnlocked > plots.maxPlots');
  }
  const lastStep = balance.plots.gridSteps.at(-1);
  if (!lastStep || lastStep.plots !== balance.plots.maxPlots) {
    issues.push('balance.json : le dernier gridStep doit couvrir plots.maxPlots');
  }
  for (const step of balance.plots.gridSteps) {
    if (step.width * step.height !== step.plots) {
      issues.push(
        `balance.json: gridStep ${step.plots} inconsistent (${step.width}×${step.height} = ${step.width * step.height})`,
      );
    }
  }
  if (balance.prestige.requiredLevel > balance.progression.maxLevel) {
    issues.push('balance.json : prestige.requiredLevel > progression.maxLevel');
  }
  for (const crop of config.cropList) {
    if (crop.regrowCycles > 0 && crop.regrowSeconds <= 0) {
      issues.push(`crops.json [${crop.key}] regrowCycles > 0 mais regrowSeconds = 0`);
    }
    if (crop.requiredLevel > balance.progression.maxLevel) {
      issues.push(`crops.json [${crop.key}] requiredLevel exceeds the maximum level`);
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`${issues.length} configuration inconsistency(ies)`, issues);
  }
}

function build(): GameConfig {
  const balance = balanceSchema.parse(readJson('balance.json'));
  const cropList = parseArray('crops.json', cropSchema).sort((a, b) => a.sortOrder - b.sortOrder);
  const animalList = parseArray('animals.json', animalSchema).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const explicitItems = parseArray('items.json', itemSchema);
  const itemList = [...explicitItems, ...deriveCropItems(cropList)].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const recipeList = parseArray('recipes.json', recipeSchema).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const buildingList = parseArray('buildings.json', buildingSchema).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const questList = parseArray('quests.json', questSchema);
  const achievementList = parseArray('achievements.json', achievementSchema).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const eventList = parseArray('events.json', eventSchema);
  const seasonPasses = parseArray('season-pass.json', seasonPassSchema);

  const config: Omit<GameConfig, 'loadedAt'> = {
    balance,
    crops: indexBy(cropList),
    cropList,
    animals: indexBy(animalList),
    animalList,
    items: indexBy(itemList),
    itemList,
    recipes: indexBy(recipeList),
    recipeList,
    buildings: indexBy(buildingList),
    buildingList,
    quests: indexBy(questList),
    questList,
    achievements: indexBy(achievementList),
    achievementList,
    events: indexBy(eventList),
    eventList,
    seasonPasses,
  };

  validateReferences(config);

  return { ...config, loadedAt: new Date() };
}

let current: GameConfig | undefined;

/** Configuration courante (chargée à la première utilisation). */
export function getConfig(): GameConfig {
  if (!current) {
    current = build();
    log.info(
      {
        crops: current.cropList.length,
        animals: current.animalList.length,
        items: current.itemList.length,
        recipes: current.recipeList.length,
        buildings: current.buildingList.length,
        quests: current.questList.length,
        achievements: current.achievementList.length,
        events: current.eventList.length,
      },
      'configuration de gameplay chargée',
    );
  }
  return current;
}

/**
 * Recharge à chaud. En cas d'erreur, la configuration précédente est conservée
 * et l'exception est propagée pour être affichée à l'administrateur.
 */
export function reloadConfig(): GameConfig {
  const next = build();
  current = next;
  log.warn({ loadedAt: next.loadedAt }, 'configuration de gameplay rechargée à chaud');
  return next;
}

// ---------------------------------------------------------------------------
// Accès typés fréquents
// ---------------------------------------------------------------------------

export function balance(): Balance {
  return getConfig().balance;
}

export function getCrop(cropKey: string): CropConfig | undefined {
  return getConfig().crops.get(cropKey);
}

export function getAnimal(animalKey: string): AnimalConfig | undefined {
  return getConfig().animals.get(animalKey);
}

export function getItem(itemKey: string): ItemConfig | undefined {
  return getConfig().items.get(itemKey);
}

export function getRecipe(recipeKey: string): RecipeConfig | undefined {
  return getConfig().recipes.get(recipeKey);
}

export function getBuilding(buildingKey: string): BuildingConfig | undefined {
  return getConfig().buildings.get(buildingKey);
}

export function getBuildingTier(buildingKey: string, tier: number): BuildingTier | undefined {
  return getConfig().buildings.get(buildingKey)?.tiers.find((entry) => entry.tier === tier);
}

/** Passe saisonnier actif à l'instant donné, s'il y en a un. */
export function getActiveSeasonPass(now: Date = new Date()): SeasonPassConfig | undefined {
  return getConfig().seasonPasses.find(
    (pass) =>
      pass.active &&
      new Date(pass.startsAt).getTime() <= now.getTime() &&
      new Date(pass.endsAt).getTime() >= now.getTime(),
  );
}

export type {
  AchievementConfig,
  AnimalConfig,
  Balance,
  BuildingConfig,
  BuildingTier,
  CropConfig,
  EventConfig,
  ItemConfig,
  QuestConfig,
  RecipeConfig,
  SeasonPassConfig,
};
