import type { Balance } from '../config/gameplay/schemas';
import type { Rng } from './rng';

/**
 * Mine : profondeur qui ne recule jamais, minerai tiré par rareté.
 *
 * Pas de table de butin par palier à maintenir à la main : la profondeur
 * maximale accessible est une FORMULE du niveau du joueur (comme le coût des
 * parcelles ou la courbe d'XP), et chaque minerai porte simplement une
 * profondeur minimale d'apparition dans sa fiche objet. Ajouter un minerai ou
 * décaler la courbe ne touche jamais ce fichier.
 */

type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface OreConfig {
  key: string;
  rarity: Rarity;
  requiredLevel: number;
  minDepth: number;
}

/**
 * Profondeur maximale accessible à ce niveau : 1 au niveau de déblocage, puis
 * +1 tous les `levelsPerDepth` niveaux, plafonnée à `maxDepth`. Le tirage
 * d'avancement (`advanceChance`) fait le reste : atteindre le plafond demande
 * de jouer, pas seulement de monter de niveau.
 */
export function maxDepthForLevel(level: number, balance: Balance): number {
  const mining = balance.mining;
  if (level < mining.unlockLevel) return 0;
  const steps = 1 + Math.floor((level - mining.unlockLevel) / mining.levelsPerDepth);
  return Math.min(mining.maxDepth, Math.max(1, steps));
}

/** Minerais qui peuvent apparaître à cette profondeur, pour ce niveau. */
export function eligibleOre(
  pool: readonly OreConfig[],
  input: { level: number; depth: number },
): OreConfig[] {
  return pool.filter((ore) => ore.requiredLevel <= input.level && ore.minDepth <= input.depth);
}

/** Tirage pondéré par rareté parmi les minerais éligibles. */
export function rollOre(pool: readonly OreConfig[], balance: Balance, rng: Rng): OreConfig | undefined {
  const weights = balance.mining.rarityWeights;
  return rng.weighted(pool.map((ore) => ({ value: ore, weight: weights[ore.rarity] ?? 0 })));
}

/**
 * Un passage vers le bas s'ouvre-t-il cette fois-ci ? Indépendant du tirage de
 * minerai : on peut trouver du minerai ET descendre au même coup de pioche.
 */
export function rollAdvance(currentDepth: number, maxDepth: number, balance: Balance, rng: Rng): boolean {
  if (currentDepth >= maxDepth) return false;
  return rng.chance(balance.mining.advanceChance);
}
