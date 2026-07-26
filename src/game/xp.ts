import type { Balance } from '../config/gameplay/schemas';

/**
 * Courbe d'expérience et récompenses de palier.
 *
 * Formule : `xpPourNiveauSuivant(n) = base × n^exposant + linéaire × n`
 * avec base = 60, exposant = 1,45, linéaire = 40.
 *
 * Pourquoi ce couple :
 *  - le terme puissance donne une progression super-linéaire (chaque niveau est
 *    plus long que le précédent, sinon le contenu de fin de partie serait
 *    atteint en une semaine) ;
 *  - le terme linéaire relève les tout premiers niveaux, sinon `60 × 1^1,45 = 60`
 *    XP suffiraient pour le niveau 2 et le joueur passerait 4 niveaux en trois
 *    clics, ce qui casse la lisibilité de l'onboarding ;
 *  - exposant 1,45 (et non 2) parce qu'à 1,45 le total cumulé pour le niveau 60
 *    est d'environ 631 000 XP, soit ~4 mois de jeu régulier — la cible de
 *    rétention avant prestige. À exposant 2, le même palier demanderait 4,8 M
 *    d'XP, soit un mur artificiel.
 *
 * Toutes les fonctions sont pures et mémoïsées : la table cumulative est
 * calculée une fois par jeu de paramètres.
 */

export interface LevelState {
  level: number;
  /** XP accumulée dans le niveau courant. */
  xpInLevel: number;
  /** XP nécessaire pour passer au niveau suivant (0 si niveau maximum). */
  xpForNext: number;
  /** Progression 0-1 dans le niveau courant. */
  progress: number;
  /** XP totale depuis le niveau 1. */
  totalXp: number;
  isMaxLevel: boolean;
}

export interface LevelUpResult extends LevelState {
  levelsGained: number;
  previousLevel: number;
  /** Niveaux franchis, pour distribuer une récompense par palier. */
  crossedLevels: number[];
}

const tableCache = new Map<string, { perLevel: number[]; cumulative: number[] }>();

function tableFor(balance: Balance): { perLevel: number[]; cumulative: number[] } {
  const { base, exponent, linear } = balance.progression.xpCurve;
  const maxLevel = balance.progression.maxLevel;
  const cacheKey = `${base}|${exponent}|${linear}|${maxLevel}`;
  const cached = tableCache.get(cacheKey);
  if (cached) return cached;

  const perLevel: number[] = [0]; // index 0 inutilisé (les niveaux commencent à 1)
  const cumulative: number[] = [0, 0];
  for (let level = 1; level <= maxLevel; level += 1) {
    const need = Math.floor(base * level ** exponent + linear * level);
    perLevel[level] = need;
    cumulative[level + 1] = (cumulative[level] ?? 0) + need;
  }
  const table = { perLevel, cumulative };
  tableCache.set(cacheKey, table);
  return table;
}

/** XP nécessaire pour passer de `level` à `level + 1`. 0 au niveau maximum. */
export function xpForNextLevel(level: number, balance: Balance): number {
  if (level >= balance.progression.maxLevel) return 0;
  return tableFor(balance).perLevel[Math.max(1, level)] ?? 0;
}

/** XP cumulée nécessaire pour atteindre `level` depuis le niveau 1. */
export function totalXpForLevel(level: number, balance: Balance): number {
  const table = tableFor(balance);
  const clamped = Math.min(Math.max(1, level), balance.progression.maxLevel);
  return table.cumulative[clamped] ?? 0;
}

/** Reconstruit niveau + progression depuis l'XP cumulée (source de vérité de secours). */
export function levelFromTotalXp(totalXp: number, balance: Balance): LevelState {
  const table = tableFor(balance);
  const maxLevel = balance.progression.maxLevel;
  let level = 1;
  while (level < maxLevel && totalXp >= (table.cumulative[level + 1] ?? Infinity)) {
    level += 1;
  }
  const consumed = table.cumulative[level] ?? 0;
  const xpInLevel = totalXp - consumed;
  const xpForNext = xpForNextLevel(level, balance);
  return {
    level,
    xpInLevel,
    xpForNext,
    progress: xpForNext === 0 ? 1 : Math.min(1, xpInLevel / xpForNext),
    totalXp,
    isMaxLevel: level >= maxLevel,
  };
}

/**
 * Ajoute de l'XP et calcule les montées de niveau en cascade.
 * Retourne l'état final et la liste des niveaux franchis, ce qui permet au
 * service d'attribuer une récompense pour CHAQUE palier même si le joueur en
 * franchit trois d'un coup (grosse récolte, fin de quête hebdomadaire).
 */
export function addXp(
  current: { level: number; xp: number },
  amount: number,
  balance: Balance,
): LevelUpResult {
  const maxLevel = balance.progression.maxLevel;
  const previousLevel = Math.min(Math.max(1, current.level), maxLevel);
  let level = previousLevel;
  let xpInLevel = Math.max(0, current.xp) + Math.max(0, Math.floor(amount));
  const crossedLevels: number[] = [];

  while (level < maxLevel) {
    const need = xpForNextLevel(level, balance);
    if (need <= 0 || xpInLevel < need) break;
    xpInLevel -= need;
    level += 1;
    crossedLevels.push(level);
  }

  // Au niveau maximum, l'XP excédentaire est conservée : elle alimente le calcul
  // des points de prestige plutôt que d'être perdue.
  const xpForNext = xpForNextLevel(level, balance);
  return {
    level,
    xpInLevel,
    xpForNext,
    progress: xpForNext === 0 ? 1 : Math.min(1, xpInLevel / xpForNext),
    totalXp: totalXpForLevel(level, balance) + xpInLevel,
    isMaxLevel: level >= maxLevel,
    levelsGained: level - previousLevel,
    previousLevel,
    crossedLevels,
  };
}

/**
 * Récompense en pièces d'un passage de niveau.
 * `base + perLevel × niveau^exposant` : croît un peu plus vite que linéairement
 * pour rester significative au niveau 40 sans être une source d'inflation
 * (elle représente moins de 3 % des revenus totaux d'un joueur, cf. docs/04).
 */
export function levelRewardCoins(level: number, balance: Balance): number {
  const { base, perLevel, exponent } = balance.progression.levelRewardCoins;
  return Math.floor(base + perLevel * level ** exponent);
}

/** Gemmes accordées aux paliers remarquables (5, 10, 15…). */
export function levelRewardGems(level: number, balance: Balance): number {
  return balance.progression.milestoneLevels.includes(level)
    ? balance.progression.milestoneGems
    : 0;
}

/**
 * Table complète pour la documentation et les tests d'équilibrage.
 * Utilisée par `npm run balance:report`.
 */
export function xpTable(balance: Balance): Array<{
  level: number;
  xpForNext: number;
  cumulative: number;
  rewardCoins: number;
  rewardGems: number;
}> {
  const rows = [];
  for (let level = 1; level <= balance.progression.maxLevel; level += 1) {
    rows.push({
      level,
      xpForNext: xpForNextLevel(level, balance),
      cumulative: totalXpForLevel(level, balance),
      rewardCoins: levelRewardCoins(level, balance),
      rewardGems: levelRewardGems(level, balance),
    });
  }
  return rows;
}
