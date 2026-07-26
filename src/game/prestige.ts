import type { Balance } from '../config/gameplay/schemas';

/**
 * Prestige (« renaissance ») : le contenu de rétention à très long terme.
 *
 * Le joueur qui atteint le niveau maximum peut repartir de zéro contre des
 * multiplicateurs PERMANENTS. C'est le seul mécanisme qui donne un sens à la fin
 * de la courbe de progression sans nécessiter d'ajouter du contenu à l'infini.
 *
 * Ce qui est conservé (et pourquoi) :
 *  - les BÂTIMENTS : leur reconstruction serait 30 h de rejeu pur, sans intérêt ;
 *  - 50 % des PARCELLES : on garde le sentiment d'un domaine, tout en redonnant
 *    un objectif d'extension ;
 *  - les COSMÉTIQUES, OUTILS et objets d'ÉVÉNEMENT : ce sont des trophées, les
 *    reprendre serait vécu comme une punition ;
 *  - les GEMMES et 5 % des pièces : la monnaie premium se gagne lentement, la
 *    remettre à zéro découragerait tout prestige.
 *
 * Ce qui est perdu : niveau, XP, animaux, stocks consommables et la quasi-totalité
 * des pièces. C'est ce qui rend la renaissance signifiante.
 *
 * Gain : `+15 % de rendement et d'XP par prestige`, cumulatif jusqu'à 20 renaissances
 * (soit ×4 au maximum). Les points de prestige servent de monnaie pour de futurs
 * arbres de talents (v2).
 */

export interface PrestigeEligibility {
  eligible: boolean
  requiredLevel: number;
  currentLevel: number;
  currentPrestige: number;
  maxPrestige: number;
  reason?: string;
}

export function checkPrestigeEligibility(
  user: { level: number; prestige: number },
  balance: Balance,
): PrestigeEligibility {
  const requiredLevel = balance.prestige.requiredLevel;
  if (user.prestige >= balance.prestige.maxPrestige) {
    return {
      eligible: false,
      requiredLevel,
      currentLevel: user.level,
      currentPrestige: user.prestige,
      maxPrestige: balance.prestige.maxPrestige,
      reason: `Vous avez atteint le nombre maximum de renaissances (${balance.prestige.maxPrestige}).`,
    };
  }
  if (user.level < requiredLevel) {
    return {
      eligible: false,
      requiredLevel,
      currentLevel: user.level,
      currentPrestige: user.prestige,
      maxPrestige: balance.prestige.maxPrestige,
      reason: `Le prestige demande le niveau ${requiredLevel} (vous êtes niveau ${user.level}).`,
    };
  }
  return {
    eligible: true,
    requiredLevel,
    currentLevel: user.level,
    currentPrestige: user.prestige,
    maxPrestige: balance.prestige.maxPrestige,
  };
}

export interface PrestigePlan {
  newPrestige: number;
  pointsGained: number;
  /** Multiplicateur permanent après renaissance. */
  newMultiplier: number;
  coinsKept: number;
  plotsKept: number;
  gemsKept: boolean;
  buildingsKept: boolean;
  animalsKept: boolean;
  inventoryCategoriesKept: string[];
  startingCoins: number;
}

/**
 * Prépare une renaissance : calcule exactement ce que le joueur garde.
 * Fonction pure, ce qui permet à `/prestige` d'AFFICHER le plan avant
 * confirmation — une action irréversible doit toujours être prévisualisée.
 */
export function planPrestige(
  user: { level: number; xp: number; coins: number; prestige: number; unlockedPlots: number },
  balance: Balance,
): PrestigePlan {
  const config = balance.prestige;
  const overLevels = Math.max(0, user.level - config.requiredLevel);
  const pointsGained = config.pointsPerPrestige.base + overLevels * config.pointsPerPrestige.perLevelOverMax;
  const newPrestige = Math.min(config.maxPrestige, user.prestige + 1);

  return {
    newPrestige,
    pointsGained,
    newMultiplier: 1 + config.multiplierPerPrestige * newPrestige,
    coinsKept: Math.floor(user.coins * config.keeps.coinsPercent),
    plotsKept: Math.max(
      balance.plots.startingUnlocked,
      Math.floor(user.unlockedPlots * config.keeps.plots),
    ),
    gemsKept: config.keeps.gems,
    buildingsKept: config.keeps.buildings,
    animalsKept: config.keeps.animals,
    inventoryCategoriesKept: [...config.keeps.inventoryCategories],
    startingCoins: config.startingCoinsAfterPrestige,
  };
}

/** Multiplicateur permanent pour un nombre de prestiges donné. */
export function prestigeMultiplier(prestige: number, balance: Balance): number {
  return 1 + balance.prestige.multiplierPerPrestige * Math.max(0, prestige);
}

/** Étoiles affichées à côté du pseudo (une par prestige, ★ pleines par 5). */
export function prestigeBadge(prestige: number): string {
  if (prestige <= 0) return '';
  const stars = Math.floor(prestige / 5);
  const remainder = prestige % 5;
  return '🌟'.repeat(stars) + '⭐'.repeat(remainder);
}
