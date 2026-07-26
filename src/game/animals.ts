import type { AnimalConfig, Balance } from '../config/gameplay/schemas';
import type { Rng } from './rng';

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
 * génétique de l'animal et la vitesse du bâtiment.
 */
export function collectQuantity(
  config: AnimalConfig,
  status: AnimalStatus,
  state: AnimalState,
  cycles: number,
): number {
  if (cycles <= 0 || status.productionFactor <= 0) return 0;
  const raw =
    config.productQuantity * cycles * status.productionFactor * Math.max(0.5, state.qualityMultiplier);
  return Math.max(1, Math.floor(raw));
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

/** Prix de revente d'un animal (60 % du prix d'achat, modulé par sa santé). */
export function sellValue(
  config: AnimalConfig,
  status: AnimalStatus,
  balance: Balance,
): number {
  const healthFactor = 0.5 + (status.health / 100) * 0.5;
  return Math.max(1, Math.floor(config.price * balance.animals.sellPriceRatio * healthFactor));
}

export interface BreedingResult {
  success: boolean;
  /** Multiplicateur de production hérité par le petit. */
  qualityMultiplier: number;
  generation: number;
  reason?: string;
}

/**
 * Reproduction. Le petit hérite de la moyenne des parents, plus un aléa de
 * ±10 %, ce qui crée une véritable boucle d'élevage sélectif : garder les
 * meilleurs reproducteurs finit par payer. L'héritage est amorti par
 * `breedingQualityInheritance` pour éviter une explosion exponentielle.
 */
export function breed(
  parentA: { qualityMultiplier: number; generation: number; status: AnimalStatus },
  parentB: { qualityMultiplier: number; generation: number; status: AnimalStatus },
  config: AnimalConfig,
  balance: Balance,
  rng: Rng,
): BreedingResult {
  if (!config.breedable) {
    return { success: false, qualityMultiplier: 1, generation: 1, reason: 'species cannot breed' };
  }
  if (parentA.status.sick || parentB.status.sick) {
    return { success: false, qualityMultiplier: 1, generation: 1, reason: 'animal malade' };
  }
  if (parentA.status.happiness < 50 || parentB.status.happiness < 50) {
    return {
      success: false,
      qualityMultiplier: 1,
      generation: 1,
      reason: 'les deux animaux doivent avoir au moins 50 de bonheur',
    };
  }
  if (!rng.chance(balance.animals.breedingSuccessChance)) {
    return { success: false, qualityMultiplier: 1, generation: 1, reason: 'tentative infructueuse' };
  }

  const parentAverage = (parentA.qualityMultiplier + parentB.qualityMultiplier) / 2;
  const inherited =
    1 + (parentAverage - 1) * (1 + balance.animals.breedingQualityInheritance);
  const variance = 1 + (rng.next() - 0.5) * 0.2;

  return {
    success: true,
    qualityMultiplier: Math.min(3, Math.max(0.8, Math.round(inherited * variance * 1000) / 1000)),
    generation: Math.max(parentA.generation, parentB.generation) + 1,
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
  if (sick || health <= 25) return 'Malade 🤒';
  if (hunger <= 10) return 'Hungry 🥺';
  if (hunger <= 30) return 'A faim 😕';
  if (happiness >= 80 && hunger >= 70) return 'Radieux 😄';
  if (happiness >= 50) return 'Content 🙂';
  if (happiness >= 25) return 'Morose 😐';
  return 'Unhappy 😞';
}
