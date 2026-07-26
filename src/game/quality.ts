import type { Balance, CropConfig } from '../config/gameplay/schemas';
import type { Rng } from './rng';

export type Quality = 'normal' | 'silver' | 'gold' | 'iridium';
export type Mutation = 'none' | 'giant' | 'rainbow' | 'ancient';

export const QUALITIES: readonly Quality[] = ['normal', 'silver', 'gold', 'iridium'];

/**
 * Tirage de la qualité d'une récolte.
 *
 * Principe : on calcule un « score de qualité » puis on l'utilise comme
 * exposant sur les poids. Les poids de base sont
 * `normal 1000 / argent 180 / or 55 / iridium 8`, et on multiplie le poids de
 * chaque cran supérieur par `score^rang` (argent × score, or × score², iridium ×
 * score³).
 *
 * Pourquoi cette forme plutôt qu'un simple `+x %` par palier :
 *  - elle est monotone (améliorer le score ne peut jamais réduire la chance
 *    d'obtenir mieux) ;
 *  - elle récompense l'investissement de façon accélérée sur les hauts paliers,
 *    donc l'iridium reste un objectif désirable et rare : à score 1 la chance est
 *    de 0,6 %, à score 1,6 (ferme optimisée) elle passe à 2,4 % — significatif
 *    mais loin de banaliser le palier ;
 *  - elle ne peut pas produire de probabilité > 1 par construction (c'est un
 *    tirage pondéré, pas une somme de probabilités).
 *
 * Le score dépend de : la culture (qualityMultiplier), la fertilité du sol, le
 * niveau du joueur, l'engrais utilisé, et la chance (tickets, paon, coop).
 */
export function qualityScore(
  crop: CropConfig,
  input: {
    fertility: number;
    level: number;
    fertilizerQualityBoost: number;
    qualityBonus: number;
    luck: number;
    happinessBonus?: number;
  },
  balance: Balance,
): number {
  const config = balance.quality;
  const fertilityFactor = 1 + config.fertilityInfluence * (input.fertility / 100 - 0.5);
  const levelFactor = 1 + config.levelInfluence * Math.max(0, input.level - 1);
  const luck = Math.min(config.maxLuckBonus, input.luck + input.qualityBonus);
  const bonusFactor = 1 + luck + input.fertilizerQualityBoost + (input.happinessBonus ?? 0);

  return Math.max(0.2, crop.qualityMultiplier * fertilityFactor * levelFactor * bonusFactor);
}

/** Tire une qualité à partir du score. Déterministe pour un `rng` donné. */
export function rollQuality(score: number, balance: Balance, rng: Rng): Quality {
  const weights = balance.quality.weights;
  const entries: Array<{ value: Quality; weight: number }> = [
    { value: 'normal', weight: weights.normal },
    { value: 'silver', weight: weights.silver * score },
    { value: 'gold', weight: weights.gold * score ** 2 },
    { value: 'iridium', weight: weights.iridium * score ** 3 },
  ];
  return rng.weighted(entries) ?? 'normal';
}

export function qualityMultiplier(quality: Quality, balance: Balance): number {
  return balance.quality.multipliers[quality] ?? 1;
}

/**
 * Tirage de mutation. La probabilité globale vient de la culture
 * (`mutationChance`), modulée par la chance et les événements ; le TYPE de
 * mutation est ensuite tiré selon les poids de `balance.mutations`.
 *
 * Séparer « est-ce que ça mute ? » de « en quoi ça mute ? » permet de régler la
 * rareté globale sans toucher à la répartition entre géante / arc-en-ciel /
 * ancienne, et inversement.
 */
export function rollMutation(
  crop: CropConfig,
  input: { luck: number; eventMultiplier: number },
  balance: Balance,
  rng: Rng,
): Mutation {
  const chance = Math.min(
    0.5,
    crop.mutationChance * (1 + input.luck) * Math.max(0, input.eventMultiplier),
  );
  if (!rng.chance(chance)) return 'none';

  const entries = Object.entries(balance.mutations).map(([value, config]) => ({
    value: value as Mutation,
    weight: config.weight,
  }));
  return rng.weighted(entries) ?? 'none';
}

export function mutationEffects(
  mutation: Mutation,
  balance: Balance,
): { yieldMultiplier: number; priceMultiplier: number } {
  if (mutation === 'none') return { yieldMultiplier: 1, priceMultiplier: 1 };
  const config = balance.mutations[mutation];
  return {
    yieldMultiplier: config?.yieldMultiplier ?? 1,
    priceMultiplier: config?.priceMultiplier ?? 1,
  };
}

/**
 * Probabilités exactes d'une distribution de qualité pour un score donné.
 * Sert à la documentation d'équilibrage et aux tests (`/cultures` affiche la
 * chance d'iridium au joueur, il faut donc que ce soit calculable sans tirage).
 */
export function qualityDistribution(score: number, balance: Balance): Record<Quality, number> {
  const weights = balance.quality.weights;
  const raw: Record<Quality, number> = {
    normal: weights.normal,
    silver: weights.silver * score,
    gold: weights.gold * score ** 2,
    iridium: weights.iridium * score ** 3,
  };
  const total = QUALITIES.reduce((sum, quality) => sum + raw[quality], 0);
  return {
    normal: raw.normal / total,
    silver: raw.silver / total,
    gold: raw.gold / total,
    iridium: raw.iridium / total,
  };
}
