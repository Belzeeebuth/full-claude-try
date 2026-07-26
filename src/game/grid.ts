import type { Balance } from '../config/gameplay/schemas';

/**
 * Géométrie de la ferme et coût d'extension.
 *
 * La ferme est une grille qui grandit de 3×3 (9 parcelles) à 8×8 (64). On ne
 * stocke PAS la forme : on stocke le nombre de parcelles débloquées, et la forme
 * s'en déduit par la table `balance.plots.gridSteps`. Conséquence utile : le
 * renderer et l'interface n'ont qu'une seule source de vérité, et un correctif
 * d'équilibrage sur la table repositionne tout le monde sans migration.
 *
 * Les parcelles sont numérotées de 1 à 64 en « spirale par anneaux » : la
 * parcelle 10 (la première achetée) tombe toujours au même endroit, et la grille
 * grandit vers la droite puis vers le bas. Ainsi le numéro affiché au joueur ne
 * change JAMAIS quand la ferme s'agrandit — imaginez le contraire : « /planter 5 »
 * ne planterait pas au même endroit après un achat.
 */

export interface GridSize {
  width: number;
  height: number;
  capacity: number;
}

/** Forme de la grille pour un nombre de parcelles débloquées. */
export function gridSizeFor(unlockedPlots: number, balance: Balance): GridSize {
  const steps = balance.plots.gridSteps;
  let chosen = steps[0]!;
  for (const step of steps) {
    if (unlockedPlots >= step.plots) chosen = step;
  }
  return { width: chosen.width, height: chosen.height, capacity: chosen.plots };
}

/**
 * Coordonnées (x, y) du slot `slot` (1-indexé) dans la grille maximale 8×8.
 *
 * Ordre de remplissage : on complète la grille carrée courante avant de passer à
 * la suivante, en ajoutant d'abord une colonne puis une ligne. C'est exactement
 * l'ordre décrit par `gridSteps`, ce qui garantit que les N premières parcelles
 * remplissent toujours la grille de taille N.
 */
export function slotToCoords(slot: number, balance: Balance): { x: number; y: number } {
  const steps = balance.plots.gridSteps;
  let previousWidth = 0;
  let previousHeight = 0;
  let previousPlots = 0;

  for (const step of steps) {
    if (slot <= step.plots) {
      const indexInStep = slot - previousPlots - 1; // 0-indexé dans le palier
      if (previousPlots === 0) {
        // Premier palier : remplissage ligne par ligne.
        return { x: indexInStep % step.width, y: Math.floor(indexInStep / step.width) };
      }
      if (step.width > previousWidth) {
        // Nouvelle colonne à droite : on descend le long de x = width - 1.
        return { x: step.width - 1, y: indexInStep };
      }
      // Nouvelle ligne en bas : on avance le long de y = height - 1.
      return { x: indexInStep, y: step.height - 1 };
    }
    previousWidth = step.width;
    previousHeight = step.height;
    previousPlots = step.plots;
  }

  // Au-delà du dernier palier (ne devrait pas arriver) : dernière case.
  return { x: Math.max(0, previousWidth - 1), y: Math.max(0, previousHeight - 1) };
}

/** Inverse de `slotToCoords`. */
export function coordsToSlot(x: number, y: number, balance: Balance): number | undefined {
  for (let slot = 1; slot <= balance.plots.maxPlots; slot += 1) {
    const coords = slotToCoords(slot, balance);
    if (coords.x === x && coords.y === y) return slot;
  }
  return undefined;
}

/**
 * Coût de déblocage de la n-ième parcelle (n = index du slot, 1-indexé).
 *
 * `coût = baseCost × croissance^(n − départ)`, arrondi à la dizaine.
 * Avec base = 800 et croissance = 1,155 :
 *   parcelle 10 →      800   |  parcelle 30 →     25 900
 *   parcelle 20 →    4 550   |  parcelle 64 →  1 930 000
 * Total pour tout débloquer ≈ 14,4 M de pièces, soit environ 140 h de revenus de
 * fin de partie : l'extension reste un objectif long terme, mais atteignable.
 *
 * Croissance 1,155 et non 1,25 : à 1,25 la 64ᵉ parcelle coûterait 1,4 milliard,
 * ce qui la rendrait purement décorative.
 */
export function plotUnlockCost(slot: number, balance: Balance): number {
  const config = balance.plots;
  if (slot <= config.startingUnlocked) return 0;
  const exponent = slot - config.startingUnlocked - 1;
  const raw = config.baseCost * config.costGrowth ** exponent;
  const rounding = Math.max(1, config.costRounding);
  return Math.round(raw / rounding) * rounding;
}

/** Coût cumulé pour passer de `from` parcelles à `to` parcelles. */
export function cumulativePlotCost(from: number, to: number, balance: Balance): number {
  let total = 0;
  for (let slot = from + 1; slot <= to; slot += 1) {
    total += plotUnlockCost(slot, balance);
  }
  return total;
}

/** Table complète pour la documentation d'équilibrage. */
export function plotCostTable(balance: Balance): Array<{
  slot: number;
  cost: number;
  cumulative: number;
  gridWidth: number;
  gridHeight: number;
}> {
  const rows = [];
  let cumulative = 0;
  for (let slot = 1; slot <= balance.plots.maxPlots; slot += 1) {
    const cost = plotUnlockCost(slot, balance);
    cumulative += cost;
    const size = gridSizeFor(slot, balance);
    rows.push({ slot, cost, cumulative, gridWidth: size.width, gridHeight: size.height });
  }
  return rows;
}
