import type { Balance } from '../config/gameplay/schemas';

/**
 * Coopératives : progression collective et bonus partagés.
 *
 * Une coopérative gagne de l'XP quand ses membres contribuent (2 % des pièces
 * versées à la trésorerie) et quand elle valide ses objectifs hebdomadaires.
 * Chaque niveau accorde des bonus PASSIFS à tous les membres, ce qui aligne les
 * intérêts : aider la coop, c'est s'aider soi-même. Les bonus sont volontairement
 * faibles par niveau (+0,4 % de vitesse de pousse) mais atteignent +12 % au
 * niveau 30 — significatif sans jamais rendre le jeu solo non viable, ce qui
 * serait une forme de pay-to-win social.
 */

export interface CoopLevelState {
  level: number;
  xp: number;
  xpForNext: number;
  progress: number;
  memberLimit: number;
  isMaxLevel: boolean;
}

/** XP nécessaire pour passer du niveau `level` au suivant. */
export function coopXpForNext(level: number, balance: Balance): number {
  if (level >= balance.coop.maxLevel) return 0;
  const { base, exponent } = balance.coop.xpPerLevel;
  return Math.floor(base * level ** exponent);
}

export function coopLevelState(
  coop: { level: number; xp: number },
  balance: Balance,
): CoopLevelState {
  const xpForNext = coopXpForNext(coop.level, balance);
  return {
    level: coop.level,
    xp: coop.xp,
    xpForNext,
    progress: xpForNext === 0 ? 1 : Math.min(1, coop.xp / xpForNext),
    memberLimit: coopMemberLimit(coop.level, balance),
    isMaxLevel: coop.level >= balance.coop.maxLevel,
  };
}

export function coopMemberLimit(level: number, balance: Balance): number {
  return Math.min(
    50,
    balance.coop.baseMemberLimit + balance.coop.memberLimitPerLevel * Math.max(0, level - 1),
  );
}

/** Ajoute de l'XP à une coopérative, avec montées en cascade. */
export function addCoopXp(
  coop: { level: number; xp: number },
  amount: number,
  balance: Balance,
): { level: number; xp: number; levelsGained: number } {
  let level = coop.level;
  let xp = coop.xp + Math.max(0, Math.floor(amount));
  let levelsGained = 0;

  while (level < balance.coop.maxLevel) {
    const need = coopXpForNext(level, balance);
    if (need <= 0 || xp < need) break;
    xp -= need;
    level += 1;
    levelsGained += 1;
  }

  return { level, xp, levelsGained };
}

/** XP de coopérative générée par une contribution en pièces. */
export function contributionXp(coins: number, balance: Balance): number {
  return Math.floor(Math.max(0, coins) * balance.coop.contributionXpRatio);
}

export interface CoopBonuses {
  growthSpeed: number;
  sellBonus: number;
  xpBonus: number;
  qualityBonus: number;
}

export function coopBonuses(level: number, balance: Balance): CoopBonuses {
  const perLevel = balance.coop.bonusesPerLevel;
  const effective = Math.max(0, level);
  return {
    growthSpeed: perLevel.growthSpeed * effective,
    sellBonus: perLevel.sellBonus * effective,
    xpBonus: perLevel.xpBonus * effective,
    qualityBonus: perLevel.qualityBonus * effective,
  };
}

export type CoopRole = 'owner' | 'officer' | 'member';

const ROLE_RANK: Record<CoopRole, number> = { owner: 3, officer: 2, member: 1 };

export function canManageMembers(role: CoopRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.officer;
}

export function canWithdrawTreasury(role: CoopRole, balance: Balance): boolean {
  return balance.coop.treasuryWithdrawRoles.includes(role);
}

/** Un officier ne peut agir que sur un rang strictement inférieur au sien. */
export function canActOn(actor: CoopRole, target: CoopRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

export const ROLE_LABELS: Record<CoopRole, string> = {
  owner: 'Chef',
  officer: 'Officier',
  member: 'Membre',
};

/**
 * Objectifs hebdomadaires générés pour une coopérative.
 * La cible est proportionnelle au nombre de membres ET au niveau, de sorte
 * qu'une coop de 3 personnes au niveau 2 et une coop de 40 au niveau 25 aient
 * toutes deux un objectif atteignable mais exigeant.
 */
export interface CoopObjectiveTemplate {
  objectiveKey: string;
  title: string;
  description: string;
  basePerMember: number;
  rewardCoinsPerMember: number;
  rewardGems: number;
  rewardCoopXp: number;
}

export const COOP_OBJECTIVE_TEMPLATES: readonly CoopObjectiveTemplate[] = [
  {
    objectiveKey: 'harvest_total',
    title: 'Moisson collective',
    description: 'Harvest {target} units across all members.',
    basePerMember: 120,
    rewardCoinsPerMember: 4000,
    rewardGems: 2,
    rewardCoopXp: 2500,
  },
  {
    objectiveKey: 'craft_total',
    title: 'Co-op chain',
    description: 'Craft {target} processed goods.',
    basePerMember: 20,
    rewardCoinsPerMember: 5000,
    rewardGems: 2,
    rewardCoopXp: 3000,
  },
  {
    objectiveKey: 'collect_total',
    title: 'Grande traite',
    description: 'Collectez {target} productions animales.',
    basePerMember: 50,
    rewardCoinsPerMember: 3500,
    rewardGems: 2,
    rewardCoopXp: 2200,
  },
  {
    objectiveKey: 'sell_value_total',
    title: 'Co-op market',
    description: 'Sell {target} coins worth of goods.',
    basePerMember: 60000,
    rewardCoinsPerMember: 6000,
    rewardGems: 3,
    rewardCoopXp: 3500,
  },
  {
    objectiveKey: 'help_total',
    title: 'Entraide',
    description: 'Aidez {target} fois des fermiers, membres ou non.',
    basePerMember: 8,
    rewardCoinsPerMember: 3000,
    rewardGems: 2,
    rewardCoopXp: 2000,
  },
  {
    objectiveKey: 'treasury_total',
    title: 'Caisse commune',
    description: 'Pay {target} coins into the treasury.',
    basePerMember: 25000,
    rewardCoinsPerMember: 2500,
    rewardGems: 1,
    rewardCoopXp: 4000,
  },
];

export function buildCoopObjective(
  template: CoopObjectiveTemplate,
  memberCount: number,
  level: number,
): {
  objectiveKey: string;
  title: string;
  description: string;
  target: number;
  rewardCoins: number;
  rewardGems: number;
  rewardCoopXp: number;
} {
  const members = Math.max(1, memberCount);
  const levelFactor = 1 + 0.05 * Math.max(0, level - 1);
  const target = Math.round(template.basePerMember * members * levelFactor);
  return {
    objectiveKey: template.objectiveKey,
    title: template.title,
    description: template.description.replace('{target}', target.toLocaleString('fr-FR')),
    target,
    rewardCoins: template.rewardCoinsPerMember * members,
    rewardGems: template.rewardGems,
    rewardCoopXp: template.rewardCoopXp,
  };
}
