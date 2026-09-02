import type { AnimalConfig, AnimalVariant, Balance } from '../config/gameplay/schemas';
import type { Quality } from './quality';
import type { Rng } from './rng';

export type { AnimalVariant };

/**
 * Cycle de vie et production des animaux.
 *
 * Comme pour les cultures, la décroissance des jauges (faim, bonheur, santé) est
 * CALCULÉE À LA LECTURE depuis `statsUpdatedAt`. Le job nocturne ne fait que
 * matérialiser l'état pour deux choses qu'on ne peut pas déduire paresseusement :
 * déclencher la maladie/la mort, et envoyer les notifications DM.
 *
 * Équilibre visé : un joueur qui passe deux fois par jour garde tout son cheptel
 * en pleine forme ; un joueur absent 24 h trouve des animaux affamés qui
 * produisent moitié moins ; il faut 4 jours d'abandon complet pour qu'un animal
 * meure — assez long pour ne jamais punir un week-end, assez court pour que la
 * négligence ait un sens.
 */

export interface AnimalState {
  animalKey: string;
  hunger: number;
  happiness: number;
  health: number;
  statsUpdatedAt: Date;
  lastFedAt: Date | null;
  lastCollectedAt: Date | null;
  lastPettedAt: Date | null;
  productionReadyAt: Date | null;
  pendingProduction: number;
  qualityMultiplier: number;
  isSick: boolean;
  isAlive: boolean;
  bornAt: Date;
}

export interface AnimalStatus {
  hunger: number;
  happiness: number;
  health: number;
  /** L'animal produit-il actuellement ? */
  productive: boolean;
  /** Facteur de production (0 à 1) appliqué à la quantité collectée. */
  productionFactor: number;
  hungry: boolean;
  starving: boolean;
  sick: boolean;
  shouldDie: boolean;
  ageDays: number;
  /** Productions accumulées prêtes à collecter. */
  readyProduction: number;
  nextProductionAt: Date | null;
  /** Libellé d'humeur affiché au joueur. */
  mood: string;
}

/**
 * Projette les jauges d'un animal à l'instant `now`.
 *
 * - la faim descend de `hungerRate` points/heure (4 à 8 selon l'espèce) ;
 * - le bonheur descend de `happinessRate` points/heure, ET deux fois plus vite si
 *   l'animal est affamé : négliger la nourriture dégrade tout le reste ;
 * - la santé ne descend que si l'animal est affamé depuis un moment, à raison de
 *   2 points/heure.
 */
export function projectAnimal(
  state: AnimalState,
  config: AnimalConfig,
  now: Date,
  balance: Balance,
): AnimalStatus {
  const elapsedHours = Math.max(0, now.getTime() - state.statsUpdatedAt.getTime()) / 3_600_000;

  const hunger = clamp(state.hunger - config.hungerRate * elapsedHours);
  const starving = hunger <= 0;
  const happinessRate = config.happinessRate * (hunger <= 20 ? 2 : 1);
  const happiness = clamp(state.happiness - happinessRate * elapsedHours);

  const starvingHours = starving
    ? Math.max(0, elapsedHours - state.hunger / Math.max(0.1, config.hungerRate))
    : 0;
  const health = clamp(state.health - (starving ? 2 * starvingHours : 0));

  const ageDays = Math.floor((now.getTime() - state.bornAt.getTime()) / 86_400_000);

  const hungry = hunger < balance.notifications.animalHungryThreshold;
  const sick = state.isSick || health <= balance.animals.sickHealthThreshold;
  const shouldDie =
    state.isAlive &&
    (health <= 0 ||
      starvingHours >= balance.animals.starvationHoursBeforeDeath ||
      (config.lifespanDays > 0 && ageDays > config.lifespanDays));

  // Facteur de production : plein régime si repu et heureux, 50 % si affamé,
  // 0 si malade ou mort. Les seuils viennent de la config d'équilibrage.
  let productionFactor = 1;
  if (!state.isAlive || sick) {
    productionFactor = 0;
  } else {
    if (hunger < balance.animals.hungerProductionThreshold) {
      productionFactor *= 1 - balance.animals.hungerYieldPenalty;
    }
    if (happiness < balance.animals.happinessProductionThreshold) {
      productionFactor *= 0.75;
    }
  }

  const readyProduction = computeReadyProduction(state, config, now, balance);

  return {
    hunger: Math.round(hunger),
    happiness: Math.round(happiness),
    health: Math.round(health),
    productive: productionFactor > 0,
    productionFactor,
    hungry,
    starving,
    sick,
    shouldDie,
    ageDays,
    readyProduction,
    nextProductionAt: state.productionReadyAt,
    mood: describeMood(hunger, happiness, health, sick, state.isAlive),
  };
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Productions accumulées depuis la dernière collecte, plafonnées.
 *
 * Le plafond (`maxPendingProduction`, 5 par défaut) est essentiel : sans lui, un
 * joueur pourrait laisser 30 vaches produire pendant une semaine et revenir
 * encaisser 500 laits d'un coup, ce qui casse à la fois l'économie et l'intérêt
 * de se connecter régulièrement. Avec le plafond, revenir toutes les 12 h reste
 * la stratégie optimale.
 */
export function computeReadyProduction(
  state: AnimalState,
  config: AnimalConfig,
  now: Date,
  balance: Balance,
): number {
  if (!state.isAlive) return 0;
  const cap = balance.animals.maxPendingProduction;
  if (!state.productionReadyAt) return Math.min(cap, state.pendingProduction);
  if (now.getTime() < state.productionReadyAt.getTime()) {
    return Math.min(cap, state.pendingProduction);
  }
  const elapsed = now.getTime() - state.productionReadyAt.getTime();
  const extraCycles = Math.floor(elapsed / (config.productionSeconds * 1_000));
  return Math.min(cap, state.pendingProduction + 1 + extraCycles);
}

/**
 * Quantité réellement collectée, une fois appliqués le facteur d'état, la
 * génétique de l'animal, la vitesse du bâtiment et la variante.
 *
 * Le multiplicateur d'une bête dorée s'applique à la quantité PAR CYCLE, pas
 * au nombre de cycles : ceux-ci restent plafonnés par `maxPendingProduction`,
 * donc revenir régulièrement reste la stratégie optimale, dorée ou pas.
 */
export function collectQuantity(
  config: AnimalConfig,
  status: AnimalStatus,
  state: AnimalState,
  cycles: number,
  productMultiplier = 1,
): number {
  if (cycles <= 0 || status.productionFactor <= 0) return 0;
  const raw =
    config.productQuantity * cycles * status.productionFactor * Math.max(0.5, state.qualityMultiplier);
  return Math.max(1, Math.floor(raw * Math.max(1, productMultiplier)));
}

/** Prochaine échéance de production après une collecte. */
export function nextProductionAt(
  config: AnimalConfig,
  now: Date,
  speedMultiplier: number,
): Date {
  const seconds = Math.max(60, config.productionSeconds / Math.max(0.1, speedMultiplier));
  return new Date(now.getTime() + seconds * 1_000);
}

/** Coût de nourrissage en objets (`feedItemKey` × `feedPerCycle`). */
export function feedCost(config: AnimalConfig): { itemKey: string; quantity: number } {
  return { itemKey: config.feedItemKey, quantity: config.feedPerCycle };
}

/** Coût du vétérinaire, croissant avec le niveau requis de l'animal. */
export function vetCost(config: AnimalConfig, balance: Balance): number {
  return Math.round(
    balance.animals.vetCostBase + balance.animals.vetCostPerLevel * config.requiredLevel,
  );
}

/**
 * Prix de revente d'un animal (60 % du prix d'achat, modulé par sa santé).
 *
 * Une bête dorée se revend `goldenSellMultiplier` fois plus cher : c'est le
 * seul endroit où une variante touche directement aux pièces, et 3 × 0,6 =
 * 1,8 fois le prix d'achat sur 0,2 % des bêtes laisse l'achat-revente en
 * boucle largement déficitaire (voir `balance.animals.variants`).
 */
export function sellValue(
  config: AnimalConfig,
  status: AnimalStatus,
  balance: Balance,
  variant: AnimalVariant = 'normal',
): number {
  const healthFactor = 0.5 + (status.health / 100) * 0.5;
  const multiplier = variant === 'golden' ? balance.animals.variants.goldenSellMultiplier : 1;
  return Math.max(1, Math.floor(config.price * balance.animals.sellPriceRatio * healthFactor * multiplier));
}

// ---------------------------------------------------------------------------
// VARIANTES : SHINY ET DORÉE
// ---------------------------------------------------------------------------

/**
 * Tirage de la variante d'une bête qui ENTRE dans le jeu (achat, naissance).
 *
 * Deux tirages indépendants, la dorée d'abord : c'est l'issue la plus rare,
 * elle ne doit jamais être « mangée » par un tirage shiny réussi juste avant.
 * Chaque chance est multipliée par le poids de rareté de l'espèce
 * (`rarityWeights`, 1 pour une poule, 3 pour un mythique) : un joueur achète
 * dix poules pour un dragonnet, donc à chance égale la poule shiny serait
 * banale et le dragonnet shiny introuvable. La courbe est linéaire par cran
 * de rareté — simple à lire dans `balance.json`, simple à retoucher.
 *
 * `allowGolden: false` sert à la reproduction : la dorée se TROUVE (à l'achat),
 * elle ne s'élève pas — c'est ce qui en fait le graal.
 */
export function rollVariant(
  rng: Rng,
  balance: Balance,
  input: { rarity: string; allowGolden?: boolean },
): AnimalVariant {
  const config = balance.animals.variants;
  const weight = config.rarityWeights[input.rarity as keyof typeof config.rarityWeights] ?? 1;
  // Plafond à 50 % : un poids mal réglé ne doit jamais rendre la variante
  // majoritaire — elle cesserait d'être une variante.
  const goldenChance = Math.min(0.5, config.goldenChance * weight);
  const shinyChance = Math.min(0.5, config.shinyChance * weight);
  if (input.allowGolden !== false && rng.chance(goldenChance)) return 'golden';
  if (rng.chance(shinyChance)) return 'shiny';
  return 'normal';
}

/**
 * Variante d'un petit à la naissance.
 *
 * Un parent shiny transmet avec `inheritanceChance` (35 %), deux parents avec
 * `doubleInheritanceChance` (60 %) : garder ses reproducteurs shiny finit par
 * payer, sans que la lignée devienne shiny à coup sûr. Si l'hérédité échoue,
 * le petit passe par le tirage ordinaire — sans dorée : un parent doré ne
 * transmet rien, et aucune portée n'en produit.
 */
export function inheritVariant(
  parents: readonly [AnimalVariant, AnimalVariant],
  rarity: string,
  balance: Balance,
  rng: Rng,
): AnimalVariant {
  const config = balance.animals.variants;
  const shinyParents = parents.filter((variant) => variant === 'shiny').length;
  if (shinyParents > 0) {
    const chance = shinyParents === 2 ? config.doubleInheritanceChance : config.inheritanceChance;
    if (rng.chance(chance)) return 'shiny';
  }
  return rollVariant(rng, balance, { rarity, allowGolden: false });
}

export interface VariantEffects {
  /** Multiplicateur de la quantité produite par cycle (dorée : ×2). */
  productMultiplier: number;
  /** Multiplicateur du prix de revente de la bête (dorée : ×3). */
  sellMultiplier: number;
  /** Probabilité qu'une collecte sorte un cran de qualité au-dessus (shiny). */
  qualityBoost: number;
}

/** Effets d'une variante, tous lus dans `balance.animals.variants`. */
export function variantEffects(variant: AnimalVariant, balance: Balance): VariantEffects {
  const config = balance.animals.variants;
  switch (variant) {
    case 'shiny':
      return { productMultiplier: 1, sellMultiplier: 1, qualityBoost: config.shinyQualityBoost };
    case 'golden':
      return {
        productMultiplier: config.goldenProductMultiplier,
        sellMultiplier: config.goldenSellMultiplier,
        qualityBoost: 0,
      };
    default:
      return { productMultiplier: 1, sellMultiplier: 1, qualityBoost: 0 };
  }
}

/**
 * Qualité des produits d'une collecte.
 *
 * Les produits d'élevage sortent en qualité normale ; une bête shiny les fait
 * passer UN cran au-dessus (argent) avec la probabilité `qualityBoost`, et
 * jamais plus : l'or et l'iridium restent réservés aux cultures et à la
 * pêche, où ils se méritent par l'engrais et le niveau.
 */
export function variantProductQuality(
  variant: AnimalVariant,
  balance: Balance,
  rng: Rng,
): Quality {
  const boost = variantEffects(variant, balance).qualityBoost;
  return boost > 0 && rng.chance(boost) ? 'silver' : 'normal';
}

/** Icône d'une variante à côté d'un nom ; vide pour une bête ordinaire. */
export function variantIcon(variant: AnimalVariant): string {
  switch (variant) {
    case 'shiny':
      return '✨';
    case 'golden':
      return '🌟';
    default:
      return '';
  }
}

export interface BreedingResult {
  success: boolean;
  /** Multiplicateur de production hérité par le petit. */
  qualityMultiplier: number;
  generation: number;
  /** Variante du petit ; `normal` sur un échec (aucun petit). */
  variant: AnimalVariant;
  /** Clé de traduction de l'échec (fonction pure : jamais de texte en dur). */
  reasonKey?: string;
  reasonParams?: Record<string, string | number>;
}

/**
 * Reproduction. Le petit hérite de la moyenne des parents, plus un aléa de
 * ±10 %, ce qui crée une véritable boucle d'élevage sélectif : garder les
 * meilleurs reproducteurs finit par payer. L'héritage est amorti par
 * `breedingQualityInheritance` pour éviter une explosion exponentielle.
 */
export interface BreedingParent {
  qualityMultiplier: number;
  generation: number;
  status: AnimalStatus;
  /** Absente pour les appels antérieurs aux variantes : équivaut à `normal`. */
  variant?: AnimalVariant;
}

export function breed(
  parentA: BreedingParent,
  parentB: BreedingParent,
  config: AnimalConfig,
  balance: Balance,
  rng: Rng,
): BreedingResult {
  if (!config.breedable) {
    return {
      success: false,
      qualityMultiplier: 1,
      generation: 1,
      variant: 'normal',
      reasonKey: 'errors.animal.cannot_breed',
      reasonParams: { name: config.name },
    };
  }
  if (parentA.status.sick || parentB.status.sick) {
    return {
      success: false,
      qualityMultiplier: 1,
      generation: 1,
      variant: 'normal',
      reasonKey: 'errors.animal.breed_sick',
    };
  }
  if (parentA.status.happiness < 50 || parentB.status.happiness < 50) {
    return {
      success: false,
      qualityMultiplier: 1,
      generation: 1,
      variant: 'normal',
      reasonKey: 'errors.animal.breed_unhappy',
    };
  }
  if (!rng.chance(balance.animals.breedingSuccessChance)) {
    return {
      success: false,
      qualityMultiplier: 1,
      generation: 1,
      variant: 'normal',
      reasonKey: 'errors.animal.breed_failed',
    };
  }

  const parentAverage = (parentA.qualityMultiplier + parentB.qualityMultiplier) / 2;
  const inherited =
    1 + (parentAverage - 1) * (1 + balance.animals.breedingQualityInheritance);
  const variance = 1 + (rng.next() - 0.5) * 0.2;

  return {
    success: true,
    qualityMultiplier: Math.min(3, Math.max(0.8, Math.round(inherited * variance * 1000) / 1000)),
    generation: Math.max(parentA.generation, parentB.generation) + 1,
    // Après la génétique : l'ordre des tirages est figé, donc une graine
    // donnée reproduit toujours la même portée (tests, rejeu d'incident).
    variant: inheritVariant(
      [parentA.variant ?? 'normal', parentB.variant ?? 'normal'],
      config.rarity,
      balance,
      rng,
    ),
  };
}

function describeMood(
  hunger: number,
  happiness: number,
  health: number,
  sick: boolean,
  alive: boolean,
): string {
  if (!alive) return 'Deceased 🪦';
  if (sick || health <= 25) return 'Sick 🤒';
  if (hunger <= 10) return 'Hungry 🥺';
  if (hunger <= 30) return 'Hungry 😕';
  if (happiness >= 80 && hunger >= 70) return 'Radiant 😄';
  if (happiness >= 50) return 'Content 🙂';
  if (happiness >= 25) return 'Morose 😐';
  return 'Unhappy 😞';
}
