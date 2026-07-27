import type { Balance } from '../config/gameplay/schemas';
import type { Rng } from './rng';

/**
 * Évolution d'une parcelle dans le temps : fertilité, mauvaises herbes,
 * nuisibles. Comme la croissance des cultures, tout est déduit d'un horodatage
 * plutôt que matérialisé par un tick.
 */

export type PestType = 'crows' | 'insects' | 'fungus' | 'mole';

export const PEST_LABELS: Record<PestType, { name: string; emoji: string; hint: string }> = {
  crows: { name: 'Crows', emoji: '🐦‍⬛', hint: 'A scarecrow would keep them away.' },
  insects: { name: 'Insects', emoji: '🐛', hint: 'An organic treatment is enough.' },
  fungus: { name: 'Blight', emoji: '🍄', hint: 'Treat it fast, it spreads.' },
  mole: { name: 'Mole', emoji: '🦫', hint: 'It ruins the roots deep down.' },
};

/**
 * Fertilité restaurée par la jachère.
 * 1,5 point/heure : une parcelle épuisée (0) revient à 70 en ~47 h. C'est plus
 * lent qu'un engrais (instantané, +15 à +40) mais gratuit : le joueur choisit
 * entre payer et attendre, ce qui est exactement l'arbitrage qu'on veut créer.
 */
export function fallowRecovery(
  fertility: number,
  fallowSinceMs: number,
  balance: Balance,
): number {
  const hours = Math.max(0, fallowSinceMs) / 3_600_000;
  const recovered = fertility + hours * balance.fertility.fallowRecoveryPerHour;
  return Math.min(balance.fertility.max, Math.round(recovered));
}

/**
 * Progression des mauvaises herbes depuis la dernière intervention.
 * 2,5 points/heure : le seuil de pénalité (30) est atteint en 12 h, la pénalité
 * maximale (−30 % de rendement) en 40 h. Un joueur qui passe une fois par jour
 * ne subit donc qu'une gêne légère, celui qui disparaît une semaine trouve un
 * champ à nettoyer.
 */
export function weedGrowth(
  currentWeedLevel: number,
  sinceMs: number,
  balance: Balance,
): number {
  const hours = Math.max(0, sinceMs) / 3_600_000;
  return Math.min(100, Math.round(currentWeedLevel + hours * balance.weeds.growthPerHour));
}

/**
 * Tire l'apparition d'un nuisible pour une parcelle plantée.
 * La probabilité de base (5 %/jour) est modulée par la météo : la pluie double
 * presque le risque (limaces, mildiou), la neige l'annule. On raisonne par
 * fenêtre de temps écoulée pour rester cohérent quel que soit l'intervalle du
 * job — si le scheduler tourne toutes les 2 h, la probabilité est
 * proportionnellement réduite.
 */
export function rollPest(
  input: {
    windowMs: number;
    weatherPestChance: number;
    repelActive: boolean;
    weedLevel: number;
  },
  balance: Balance,
  rng: Rng,
): PestType | undefined {
  if (input.repelActive) return undefined;

  const dayFraction = Math.max(0, input.windowMs) / 86_400_000;
  // Les mauvaises herbes attirent les nuisibles : +50 % de risque à 100.
  const weedFactor = 1 + (input.weedLevel / 100) * 0.5;
  const chance =
    (balance.pests.baseDailyChancePerPlot + input.weatherPestChance) * dayFraction * weedFactor;

  if (!rng.chance(Math.min(0.9, chance))) return undefined;

  return (
    rng.weighted<PestType>([
      { value: 'insects', weight: 40 },
      { value: 'crows', weight: 30 },
      { value: 'fungus', weight: 20 },
      { value: 'mole', weight: 10 },
    ]) ?? 'insects'
  );
}

/**
 * Conséquence d'un nuisible ignoré au-delà de son délai.
 * Deux issues : perte partielle de rendement (cas général) ou flétrissement
 * complet (15 %). On ne détruit pas systématiquement : perdre 10 h de citrouilles
 * parce qu'on a dormi serait punitif au point de faire quitter le jeu.
 */
export function pestConsequence(
  balance: Balance,
  rng: Rng,
): { damagePenalty: number; withered: boolean } {
  if (rng.chance(balance.pests.witherIfIgnoredChance)) {
    return { damagePenalty: 1, withered: true };
  }
  return { damagePenalty: balance.pests.yieldLossIfIgnored, withered: false };
}

/**
 * Dégâts météo sur une parcelle (orage, gel, canicule).
 * La serre réduit ou annule ces dégâts (`weatherDamageReduction`).
 */
export function rollWeatherDamage(
  input: { damageChance: number; damageReduction: number },
  rng: Rng,
): number {
  const effectiveChance = input.damageChance * (1 - Math.min(1, input.damageReduction));
  if (effectiveChance <= 0 || !rng.chance(effectiveChance)) return 0;
  // Dégâts partiels : 15 % à 45 % du rendement.
  return Math.round((0.15 + rng.next() * 0.3) * 100) / 100;
}

/** Applique un engrais : fertilité + bonus de rendement/qualité pour le cycle. */
export function applyFertilizer(
  fertility: number,
  effect: { fertility?: number; yieldBoost?: number; qualityBoost?: number },
  balance: Balance,
): { fertility: number; yieldBoost: number; qualityBoost: number } {
  return {
    fertility: Math.min(balance.fertility.max, fertility + (effect.fertility ?? 0)),
    yieldBoost: effect.yieldBoost ?? 0,
    qualityBoost: effect.qualityBoost ?? 0,
  };
}

/** Clé i18n d'état d'une parcelle pour l'affichage (résolue par l'appelant). */
export function describeFertility(fertility: number, balance: Balance): string {
  if (fertility >= 85) return 'common.fertility.excellent';
  if (fertility >= balance.fertility.start) return 'common.fertility.good';
  if (fertility >= balance.fertility.lowThreshold) return 'common.fertility.average';
  if (fertility > 0) return 'common.fertility.depleted';
  return 'common.fertility.barren';
}
