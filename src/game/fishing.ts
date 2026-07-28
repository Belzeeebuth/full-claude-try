import type { Balance } from '../config/gameplay/schemas';
import type { Quality } from './quality';
import type { Rng } from './rng';

type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

/**
 * Pêche : sélection de l'espèce et notation du ferrage.
 *
 * Le rendement n'a pas de composante de quantité (une prise = un poisson) ; toute
 * la profondeur du système tient dans DEUX tirages indépendants :
 *   1. quelle espèce mord (pondéré par rareté, filtré par saison/moment/niveau) ;
 *   2. quelle qualité elle a (dérivée de la PRÉCISION du ferrage, pas du hasard
 *      pur) — c'est ce qui rend le mini-jeu de timing réellement significatif.
 */

export type TimeOfDay = 'day' | 'night' | 'any';

export interface FishConfig {
  key: string;
  rarity: Rarity;
  requiredLevel: number;
  seasons?: readonly string[];
  timeOfDay?: TimeOfDay;
}

/** Le jour va de 6h à 20h UTC ; le reste est la nuit. Simple, mais suffisant. */
export function isDaytime(hourUtc: number): boolean {
  return hourUtc >= 6 && hourUtc < 20;
}

/** Filtre les espèces disponibles pour ce joueur, cette saison, ce moment. */
export function eligibleFish(
  pool: readonly FishConfig[],
  input: { level: number; season: string; daytime: boolean },
): FishConfig[] {
  return pool.filter((fish) => {
    if (fish.requiredLevel > input.level) return false;
    if (fish.seasons && fish.seasons.length > 0 && !fish.seasons.includes(input.season)) return false;
    const timeOfDay = fish.timeOfDay ?? 'any';
    if (timeOfDay === 'day' && !input.daytime) return false;
    if (timeOfDay === 'night' && input.daytime) return false;
    return true;
  });
}

/** Tirage pondéré par rareté parmi les espèces éligibles. */
export function rollFish(
  pool: readonly FishConfig[],
  balance: Balance,
  rng: Rng,
): FishConfig | undefined {
  const weights = balance.fishing.rarityWeights;
  return rng.weighted(
    pool.map((fish) => ({ value: fish, weight: weights[fish.rarity] ?? 0 })),
  );
}

export type CastOutcome = 'too_early' | 'hit' | 'too_late';

/**
 * Compare l'instant du clic à la fenêtre de touche `[biteAt, biteAt + windowMs]`.
 * Toutes les bornes sont des timestamps epoch (ms), jamais des délais relatifs :
 * comparer des instants absolus élimine la latence de traitement du serveur de
 * l'équation, seule la latence réseau du clic lui-même (symétrique pour tous les
 * joueurs) subsiste.
 */
export function scoreCastTiming(clickAt: number, biteAt: number, windowMs: number): CastOutcome {
  if (clickAt < biteAt) return 'too_early';
  if (clickAt > biteAt + windowMs) return 'too_late';
  return 'hit';
}

/** Précision du ferrage : 1 = pile au centre de la fenêtre, 0 = sur un bord. */
export function timingAccuracy(clickAt: number, biteAt: number, windowMs: number): number {
  const center = biteAt + windowMs / 2;
  const halfWindow = windowMs / 2;
  if (halfWindow <= 0) return 1;
  const distance = Math.abs(clickAt - center);
  return Math.max(0, 1 - distance / halfWindow);
}

/**
 * Qualité de la prise : réutilise les poids globaux de `balance.quality` (les
 * mêmes qui régissent les récoltes), avec un score dérivé de la précision du
 * ferrage plutôt que de la fertilité — 0,5 pour un ferrage limite, 1,5 pour un
 * ferrage parfait, exactement centré sur la fenêtre.
 */
export function rollFishQuality(accuracy: number, balance: Balance, rng: Rng): Quality {
  const weights = balance.quality.weights;
  const score = 0.5 + Math.max(0, Math.min(1, accuracy));
  const entries: Array<{ value: Quality; weight: number }> = [
    { value: 'normal', weight: weights.normal },
    { value: 'silver', weight: weights.silver * score },
    { value: 'gold', weight: weights.gold * score ** 2 },
    { value: 'iridium', weight: weights.iridium * score ** 3 },
  ];
  return rng.weighted(entries) ?? 'normal';
}
