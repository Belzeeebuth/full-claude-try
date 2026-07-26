import type { AnimalConfig, Balance, BuildingConfig, ItemConfig } from '../config/gameplay/schemas';

/**
 * Agrégat de tous les bonus qui s'appliquent à une ferme à un instant donné.
 *
 * Rassembler ces valeurs en un seul objet immuable est ce qui rend le moteur de
 * jeu testable : `computeHarvest()` ne va rien chercher en base, il reçoit les
 * modificateurs déjà calculés. Le service, lui, sait comment les assembler
 * depuis les bâtiments, outils, animaux, coopérative, prestige, événements et
 * consommables actifs.
 *
 * Convention de composition :
 *  - les MULTIPLICATEURS se multiplient entre eux (1,1 × 1,05 = 1,155) ;
 *  - les BONUS additifs s'additionnent puis sont appliqués une seule fois
 *    (+5 % coop, +3 % paon → +8 %) ;
 *  - les valeurs sont toujours bornées pour qu'aucun empilement ne permette un
 *    rendement infini (cf. `clampModifiers`).
 */
export interface FarmModifiers {
  /** > 1 = pousse plus rapide. */
  growthMultiplier: number;
  /** Multiplicateur de rendement. */
  yieldMultiplier: number;
  /** Unités ajoutées à plat après les multiplicateurs (outils). */
  flatYield: number;
  /** Bonus additif de chance de qualité supérieure. */
  qualityBonus: number;
  /** Chance générale (mutations + qualité). */
  luck: number;
  xpMultiplier: number;
  /** Bonus additif sur les prix de vente. */
  sellBonus: number;
  /** La serre annule les malus de saison. */
  seasonImmunity: boolean;
  /** 0-1 : proportion des dégâts météo évités. */
  weatherDamageReduction: number;
  /** Probabilité de récupérer la graine à la récolte (grainerie). */
  seedRecoveryChance: number;
  /** Proportion des parcelles arrosées automatiquement (puits). */
  autoWaterRatio: number;
  /** Réduction du coût en énergie (gants). */
  energyCostReduction: number;
  /** Multiplicateur de vitesse d'artisanat. */
  craftSpeedMultiplier: number;
  /** Multiplicateur de vitesse de production animale. */
  animalSpeedMultiplier: number;
}

export const NEUTRAL_MODIFIERS: Readonly<FarmModifiers> = Object.freeze({
  growthMultiplier: 1,
  yieldMultiplier: 1,
  flatYield: 0,
  qualityBonus: 0,
  luck: 0,
  xpMultiplier: 1,
  sellBonus: 0,
  seasonImmunity: false,
  weatherDamageReduction: 0,
  seedRecoveryChance: 0,
  autoWaterRatio: 0,
  energyCostReduction: 0,
  craftSpeedMultiplier: 1,
  animalSpeedMultiplier: 1,
});

/** Bornes dures : aucun empilement ne peut les dépasser. */
export function clampModifiers(modifiers: FarmModifiers): FarmModifiers {
  return {
    growthMultiplier: clamp(modifiers.growthMultiplier, 0.25, 5),
    yieldMultiplier: clamp(modifiers.yieldMultiplier, 0.25, 4),
    flatYield: clamp(modifiers.flatYield, 0, 10),
    qualityBonus: clamp(modifiers.qualityBonus, 0, 2),
    luck: clamp(modifiers.luck, 0, 1.5),
    xpMultiplier: clamp(modifiers.xpMultiplier, 0.25, 6),
    sellBonus: clamp(modifiers.sellBonus, -0.5, 1),
    seasonImmunity: modifiers.seasonImmunity,
    weatherDamageReduction: clamp(modifiers.weatherDamageReduction, 0, 1),
    seedRecoveryChance: clamp(modifiers.seedRecoveryChance, 0, 1),
    autoWaterRatio: clamp(modifiers.autoWaterRatio, 0, 1),
    energyCostReduction: clamp(modifiers.energyCostReduction, 0, 0.75),
    craftSpeedMultiplier: clamp(modifiers.craftSpeedMultiplier, 0.5, 5),
    animalSpeedMultiplier: clamp(modifiers.animalSpeedMultiplier, 0.5, 5),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export interface ModifierSources {
  /** Bâtiments possédés, avec leur palier et leur configuration. */
  buildings: Array<{ config: BuildingConfig; tier: number; speedMultiplier: number }>;
  /** Outils présents dans l'inventaire (le meilleur de chaque type compte). */
  tools: ItemConfig[];
  /** Animaux vivants, pour les bonus passifs (abeilles, cheval, paon…). */
  animals: Array<{ config: AnimalConfig; count: number }>;
  /** Niveau de coopérative (0 si aucune). */
  coopLevel: number;
  /** Nombre de prestiges effectués. */
  prestige: number;
  /** Boosters consommables actifs. */
  activeBoosts: Array<{ type: string; multiplier?: number; bonus?: number }>;
  /** Modificateurs de l'événement en cours. */
  eventModifiers?: {
    xpMultiplier?: number;
    growthMultiplier?: number;
    mutationMultiplier?: number;
    qualityBonus?: number;
  };
  /** Multiplicateurs globaux d'environnement (`GLOBAL_GROWTH_MULTIPLIER`…). */
  globalGrowthMultiplier?: number;
  globalEconomyMultiplier?: number;
}

/**
 * Assemble les modificateurs d'une ferme. Fonction pure : donnez-lui les mêmes
 * sources, elle renverra toujours le même résultat (testé unitairement).
 */
export function buildModifiers(sources: ModifierSources, balance: Balance): FarmModifiers {
  const modifiers: FarmModifiers = { ...NEUTRAL_MODIFIERS };

  // --- Bâtiments --------------------------------------------------------
  for (const owned of sources.buildings) {
    const tier = owned.config.tiers.find((entry) => entry.tier === owned.tier);
    if (!tier) continue;
    const effect = tier.effect;
    if (!effect) {
      if (owned.config.category === 'production') {
        modifiers.craftSpeedMultiplier = Math.max(
          modifiers.craftSpeedMultiplier,
          owned.speedMultiplier,
        );
      }
      if (owned.config.category === 'livestock') {
        modifiers.animalSpeedMultiplier = Math.max(
          modifiers.animalSpeedMultiplier,
          owned.speedMultiplier,
        );
      }
      continue;
    }
    if (effect.seasonImmunity) modifiers.seasonImmunity = true;
    if (effect.weatherDamageReduction !== undefined) {
      modifiers.weatherDamageReduction = Math.max(
        modifiers.weatherDamageReduction,
        effect.weatherDamageReduction,
      );
    }
    if (effect.seedRecoveryChance !== undefined) {
      modifiers.seedRecoveryChance = Math.max(
        modifiers.seedRecoveryChance,
        effect.seedRecoveryChance,
      );
    }
    if (effect.autoWaterRatio !== undefined) {
      modifiers.autoWaterRatio = Math.max(modifiers.autoWaterRatio, effect.autoWaterRatio);
    }
  }

  // --- Outils : le meilleur de chaque effet, jamais cumulés --------------
  for (const tool of sources.tools) {
    const effect = tool.effect;
    if (!effect) continue;
    if (effect.flatYield !== undefined) {
      modifiers.flatYield = Math.max(modifiers.flatYield, effect.flatYield);
    }
    if (effect.qualityBoost !== undefined) {
      modifiers.qualityBonus += effect.qualityBoost;
    }
    if (effect.costReduction !== undefined) {
      modifiers.energyCostReduction = Math.max(modifiers.energyCostReduction, effect.costReduction);
    }
  }

  // --- Animaux : bonus passifs, cumulés mais bornés ----------------------
  for (const entry of sources.animals) {
    const bonus = entry.config.passiveBonus;
    if (bonus.cropYield) modifiers.yieldMultiplier += bonus.cropYield * entry.count;
    if (bonus.marketSellBonus) modifiers.sellBonus += bonus.marketSellBonus * entry.count;
    if (bonus.xpBonus) modifiers.xpMultiplier += bonus.xpBonus * entry.count;
    if (bonus.luck) modifiers.luck += bonus.luck * entry.count;
  }

  // --- Coopérative : bonus linéaires par niveau -------------------------
  if (sources.coopLevel > 0) {
    const perLevel = balance.coop.bonusesPerLevel;
    modifiers.growthMultiplier *= 1 + perLevel.growthSpeed * sources.coopLevel;
    modifiers.sellBonus += perLevel.sellBonus * sources.coopLevel;
    modifiers.xpMultiplier *= 1 + perLevel.xpBonus * sources.coopLevel;
    modifiers.qualityBonus += perLevel.qualityBonus * sources.coopLevel;
  }

  // --- Prestige : la récompense de long terme ---------------------------
  if (sources.prestige > 0) {
    const factor = 1 + balance.prestige.multiplierPerPrestige * sources.prestige;
    modifiers.yieldMultiplier *= factor;
    modifiers.xpMultiplier *= factor;
  }

  // --- Consommables actifs ---------------------------------------------
  for (const boost of sources.activeBoosts) {
    switch (boost.type) {
      case 'xp_boost':
        modifiers.xpMultiplier *= boost.multiplier ?? 1;
        break;
      case 'growth_boost':
        modifiers.growthMultiplier *= boost.multiplier ?? 1;
        break;
      case 'luck':
        modifiers.luck += boost.bonus ?? 0;
        break;
      default:
        break;
    }
  }

  // --- Événement en cours ----------------------------------------------
  const event = sources.eventModifiers;
  if (event) {
    if (event.xpMultiplier) modifiers.xpMultiplier *= event.xpMultiplier;
    if (event.growthMultiplier) modifiers.growthMultiplier *= event.growthMultiplier;
    if (event.qualityBonus) modifiers.qualityBonus += event.qualityBonus;
  }

  // --- Réglages d'exploitation ------------------------------------------
  modifiers.growthMultiplier *= sources.globalGrowthMultiplier ?? 1;
  modifiers.sellBonus += (sources.globalEconomyMultiplier ?? 1) - 1;

  return clampModifiers(modifiers);
}
