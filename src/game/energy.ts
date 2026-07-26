import type { Balance } from '../config/gameplay/schemas';

/**
 * Système d'énergie, calculé à la lecture (aucun job de régénération).
 *
 * On stocke `energy` + `energyUpdatedAt`, et l'énergie courante est
 * `min(max, energy + minutesÉcoulées × regen)`. Même raisonnement que pour la
 * croissance : zéro écriture pour les joueurs inactifs, aucune dérive possible.
 *
 * Rôle de l'énergie dans le design : c'est un limitateur DOUX de session. À 100
 * points et 1 point/minute, un joueur peut faire ~70 actions d'affilée puis doit
 * revenir plus tard — ce qui correspond exactement au format visé (sessions de
 * 2-5 minutes, plusieurs fois par jour) sans jamais bloquer une session normale.
 * Le système est désactivable (`ENERGY_SYSTEM_ENABLED=false`) car certains
 * serveurs préfèrent le jeu libre.
 */

export interface EnergyState {
  energy: number;
  energyMax: number;
  energyUpdatedAt: Date;
}

export interface EnergyProjection {
  current: number;
  max: number;
  /** Instant où l'énergie sera pleine (null si déjà pleine). */
  fullAt: Date | null;
  /** Minutes avant le prochain point d'énergie. */
  minutesToNextPoint: number;
}

export function projectEnergy(
  state: EnergyState,
  now: Date,
  balance: Balance,
): EnergyProjection {
  if (!balance.energy.enabled) {
    return { current: state.energyMax, max: state.energyMax, fullAt: null, minutesToNextPoint: 0 };
  }

  const minutes = Math.max(0, now.getTime() - state.energyUpdatedAt.getTime()) / 60_000;
  const regen = balance.energy.regenPerMinute;
  const current = Math.min(state.energyMax, Math.floor(state.energy + minutes * regen));
  const missing = state.energyMax - current;

  return {
    current,
    max: state.energyMax,
    fullAt: missing <= 0 ? null : new Date(now.getTime() + (missing / regen) * 60_000),
    minutesToNextPoint: missing <= 0 ? 0 : Math.max(0, Math.ceil(1 / regen)),
  };
}

/** Coût en énergie d'une action, après réduction par les outils. */
export function energyCost(
  action: string,
  balance: Balance,
  costReduction = 0,
  quantity = 1,
): number {
  if (!balance.energy.enabled) return 0;
  const base = balance.energy.costs[action] ?? balance.energy.costs.default ?? 1;
  const reduced = base * quantity * (1 - Math.min(0.75, Math.max(0, costReduction)));
  // Une action coûte toujours au moins 1 point si elle a un coût de base.
  return base === 0 ? 0 : Math.max(1, Math.round(reduced));
}

export function hasEnergy(projection: EnergyProjection, cost: number): boolean {
  return projection.current >= cost;
}

/** Nouvel état après consommation (l'horodatage est repositionné à `now`). */
export function spendEnergy(
  projection: EnergyProjection,
  cost: number,
  now: Date,
): { energy: number; energyUpdatedAt: Date } {
  return {
    energy: Math.max(0, projection.current - Math.max(0, cost)),
    energyUpdatedAt: now,
  };
}

/** Nouvel état après restauration (jus d'énergie, gemmes, montée de niveau). */
export function restoreEnergy(
  projection: EnergyProjection,
  amount: number,
  now: Date,
): { energy: number; energyUpdatedAt: Date } {
  return {
    energy: Math.min(projection.max, projection.current + Math.max(0, amount)),
    energyUpdatedAt: now,
  };
}
