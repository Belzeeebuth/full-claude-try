import { balance as getBalance } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import {
  ROLE_LABELS,
  addCoopXp,
  buildCoopObjective,
  canActOn,
  canManageMembers,
  canWithdrawTreasury,
  contributionXp,
  coopBonuses,
  coopLevelState,
  coopMemberLimit,
  COOP_OBJECTIVE_TEMPLATES,
  type CoopRole,
} from '../game/coop';
import { dailyRng } from '../game/rng';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as socialRepo from '../repositories/social.repo';
import * as economyService from './economy.service';
import { currentWeekStart } from '../utils/time';
import type { PlayerContext } from '../types';

const log = moduleLogger('coop');

/**
 * Coopératives : création, gestion des membres, trésorerie, objectifs.
 *
 * L'appartenance a une source de vérité unique : la table `guild_members` avec
 * un index unique sur `user_id`. Un joueur ne peut donc pas se retrouver dans
 * deux coopératives, même en cas de double clic sur deux invitations.
 */

const NAME_PATTERN = /^[\p{L}\p{N} '\-]{3,32}$/u;
const TAG_PATTERN = /^[A-Za-z0-9]{2,5}$/;

export interface CoopInfo {
  id: string;
  name: string;
  tag: string;
  emblem: string;
  description: string | null;
  level: number;
  xp: number;
  xpForNext: number;
  progress: number;
  treasury: number;
  memberCount: number;
  memberLimit: number;
  weeklyScore: number;
  totalScore: number;
  isPublic: boolean;
  joinRequirementLevel: number;
  bonuses: ReturnType<typeof coopBonuses>;
  role?: CoopRole;
  roleLabel?: string;
}

export async function getCoopInfo(coopId: string, viewerId?: string): Promise<CoopInfo> {
  const balance = getBalance();
  const coop = await socialRepo.findCoopById(coopId);
  if (!coop) throw gameError('coop_not_found', 'Coopérative introuvable.');

  const state = coopLevelState({ level: coop.level, xp: coop.xp }, balance);
  const membership = viewerId ? await socialRepo.getMembership(viewerId) : undefined;

  return {
    id: coop.id,
    name: coop.name,
    tag: coop.tag,
    emblem: coop.emblem,
    description: coop.description,
    level: coop.level,
    xp: coop.xp,
    xpForNext: state.xpForNext,
    progress: state.progress,
    treasury: coop.treasury,
    memberCount: coop.memberCount,
    memberLimit: coop.memberLimit,
    weeklyScore: coop.weeklyScore,
    totalScore: coop.totalScore,
    isPublic: coop.isPublic,
    joinRequirementLevel: coop.joinRequirementLevel,
    bonuses: coopBonuses(coop.level, balance),
    ...(membership?.member.guildId === coopId
      ? {
          role: membership.member.role as CoopRole,
          roleLabel: ROLE_LABELS[membership.member.role as CoopRole],
        }
      : {}),
  };
}

export async function requireMembership(userId: string) {
  const membership = await socialRepo.getMembership(userId);
  if (!membership) {
    throw gameError('coop_not_member', "Vous n'êtes dans aucune coopérative.", {
      hint: 'Créez-en une avec `/coop creer` ou rejoignez-en une avec `/coop rejoindre`.',
      suggestedCommand: 'coop',
    });
  }
  return membership;
}

export async function createCoop(
  player: PlayerContext,
  input: { name: string; tag: string; description?: string; emblem?: string },
): Promise<CoopInfo> {
  const balance = getBalance();
  const name = input.name.trim();
  const tag = input.tag.trim().toUpperCase();

  if (!NAME_PATTERN.test(name)) {
    throw gameError(
      'quantity_invalid',
      'Le nom doit faire 3 à 32 caractères (lettres, chiffres, espaces, apostrophes, tirets).',
    );
  }
  if (!TAG_PATTERN.test(tag)) {
    throw gameError('quantity_invalid', "L'étiquette doit faire 2 à 5 caractères alphanumériques.");
  }
  if (player.level < balance.coop.creationMinLevel) {
    throw gameError(
      'level_too_low',
      `La création d'une coopérative demande le niveau ${balance.coop.creationMinLevel}.`,
    );
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const existing = await socialRepo.getMembership(player.id, tx);
    if (existing) {
      throw gameError('coop_already_member', 'Vous êtes déjà dans une coopérative.', {
        hint: 'Quittez-la avec `/coop quitter` avant d\'en créer une.',
      });
    }

    const taken = await socialRepo.findCoopByNameOrTag(name, tx);
    const tagTaken = await socialRepo.findCoopByNameOrTag(tag, tx);
    if (taken || tagTaken) {
      throw gameError('coop_name_taken', 'Ce nom ou cette étiquette est déjà pris.');
    }

    await economyService.charge(
      {
        userId: player.id,
        amount: balance.coop.creationCostCoins,
        type: 'coop_contribution',
        metadata: { action: 'create', name, tag },
      },
      tx,
    );

    const coop = await socialRepo.createCoop(
      {
        name,
        tag,
        ownerId: player.id,
        description: input.description,
        emblem: input.emblem,
        memberLimit: coopMemberLimit(1, balance),
      },
      tx,
    );

    log.info({ coopId: coop.id, name, ownerId: player.id }, 'coopérative créée');
    return getCoopInfo(coop.id, player.id);
  });
}

export async function joinCoop(
  player: PlayerContext,
  query: string,
): Promise<CoopInfo> {
  return withTransaction(async (tx) => {
    const existing = await socialRepo.getMembership(player.id, tx);
    if (existing) throw gameError('coop_already_member', 'Vous êtes déjà dans une coopérative.');

    const coop = await socialRepo.findCoopByNameOrTag(query, tx);
    if (!coop) throw gameError('coop_not_found', `Aucune coopérative « ${query} ».`);
    if (!coop.isPublic) {
      throw gameError('coop_forbidden', 'Cette coopérative est sur invitation uniquement.');
    }
    if (player.level < coop.joinRequirementLevel) {
      throw gameError(
        'level_too_low',
        `${coop.name} demande le niveau ${coop.joinRequirementLevel}.`,
      );
    }

    const joined = await socialRepo.joinCoop(coop.id, player.id, tx);
    if (!joined) {
      throw gameError('coop_full', `${coop.name} est complète (${coop.memberLimit} membres).`);
    }

    return getCoopInfo(coop.id, player.id);
  });
}

/**
 * Invitation directe par un officier : contourne `isPublic` mais respecte la
 * capacité. La cible doit être libre de tout engagement.
 */
export async function inviteMember(
  player: PlayerContext,
  targetUserId: string,
): Promise<{ coopName: string }> {
  const membership = await requireMembership(player.id);
  if (!canManageMembers(membership.member.role as CoopRole)) {
    throw gameError('coop_forbidden', 'Seuls les officiers et le chef peuvent inviter.');
  }

  return withTransaction(async (tx) => {
    const targetMembership = await socialRepo.getMembership(targetUserId, tx);
    if (targetMembership) {
      throw gameError('coop_already_member', 'Ce joueur est déjà dans une coopérative.');
    }
    const joined = await socialRepo.joinCoop(membership.coop.id, targetUserId, tx);
    if (!joined) throw gameError('coop_full', 'Votre coopérative est complète.');
    return { coopName: membership.coop.name };
  });
}

export async function leaveCoop(player: PlayerContext): Promise<{ coopName: string; dissolved: boolean }> {
  const membership = await requireMembership(player.id);

  return withTransaction(async (tx) => {
    const coop = await socialRepo.lockCoop(tx, membership.coop.id);
    if (!coop) throw gameError('coop_not_found', 'Coopérative introuvable.');

    // Le chef ne peut pas partir sans transmettre : sinon la trésorerie et les
    // objectifs se retrouveraient sans responsable.
    if (membership.member.role === 'owner' && coop.memberCount > 1) {
      throw gameError(
        'coop_forbidden',
        'En tant que chef, transmettez d\'abord la direction avec `/coop promouvoir`.',
      );
    }

    await socialRepo.leaveCoop(coop.id, player.id, tx);
    const dissolved = coop.memberCount <= 1;
    return { coopName: coop.name, dissolved };
  });
}

export async function kickMember(
  player: PlayerContext,
  targetUserId: string,
): Promise<{ coopName: string }> {
  const membership = await requireMembership(player.id);
  const actorRole = membership.member.role as CoopRole;
  if (!canManageMembers(actorRole)) {
    throw gameError('coop_forbidden', 'Seuls les officiers et le chef peuvent expulser.');
  }
  if (targetUserId === player.id) {
    throw gameError('target_invalid', 'Utilisez `/coop quitter` pour partir.');
  }

  return withTransaction(async (tx) => {
    const target = await socialRepo.getMembership(targetUserId, tx);
    if (!target || target.member.guildId !== membership.coop.id) {
      throw gameError('coop_not_member', "Ce joueur n'est pas dans votre coopérative.");
    }
    if (!canActOn(actorRole, target.member.role as CoopRole)) {
      throw gameError('coop_forbidden', 'Vous ne pouvez pas expulser un membre de rang égal ou supérieur.');
    }
    await socialRepo.leaveCoop(membership.coop.id, targetUserId, tx);
    return { coopName: membership.coop.name };
  });
}

export async function promoteMember(
  player: PlayerContext,
  targetUserId: string,
  role: CoopRole,
): Promise<{ role: CoopRole; roleLabel: string }> {
  const membership = await requireMembership(player.id);
  if (membership.member.role !== 'owner') {
    throw gameError('coop_forbidden', 'Seul le chef peut changer les rangs.');
  }

  return withTransaction(async (tx) => {
    const target = await socialRepo.getMembership(targetUserId, tx);
    if (!target || target.member.guildId !== membership.coop.id) {
      throw gameError('coop_not_member', "Ce joueur n'est pas dans votre coopérative.");
    }

    await socialRepo.setMemberRole(membership.coop.id, targetUserId, role, tx);
    // Passer la direction : l'ancien chef devient officier, il n'y a jamais deux
    // chefs ni zéro chef.
    if (role === 'owner') {
      await socialRepo.setMemberRole(membership.coop.id, player.id, 'officer', tx);
    }
    return { role, roleLabel: ROLE_LABELS[role] };
  });
}

export async function listMembers(coopId: string) {
  return socialRepo.listMembers(coopId);
}

export async function listPublicCoops(limit = 10) {
  return socialRepo.listPublicCoops(limit);
}

// ---------------------------------------------------------------------------
// Trésorerie
// ---------------------------------------------------------------------------

export async function contribute(
  player: PlayerContext,
  amount: number,
): Promise<{ treasury: number; coopXp: number; level: number; levelsGained: number }> {
  const balance = getBalance();
  if (amount <= 0) throw gameError('quantity_invalid', 'Le montant doit être positif.');
  const membership = await requireMembership(player.id);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const coop = await socialRepo.lockCoop(tx, membership.coop.id);
    if (!coop) throw gameError('coop_not_found', 'Coopérative introuvable.');

    await economyService.charge(
      {
        userId: player.id,
        amount,
        type: 'coop_contribution',
        referenceType: 'coop',
        referenceId: coop.id,
      },
      tx,
    );

    const treasury = await socialRepo.contributeTreasury(
      coop.id,
      player.id,
      amount,
      'Contribution volontaire',
      tx,
    );

    const xpGain = contributionXp(amount, balance);
    const next = addCoopXp({ level: coop.level, xp: coop.xp }, xpGain, balance);
    await socialRepo.addCoopXp(coop.id, next.level, next.xp, tx);

    // Chaque niveau de coop augmente la limite de membres.
    if (next.levelsGained > 0) {
      await tx
        .update((await import('../db/schema')).coops)
        .set({ memberLimit: coopMemberLimit(next.level, balance) })
        .where((await import('drizzle-orm')).eq((await import('../db/schema')).coops.id, coop.id));
    }

    await socialRepo.progressObjective(
      coop.id,
      'treasury_total',
      currentWeekStart(new Date()),
      amount,
      tx,
    );

    return {
      treasury,
      coopXp: xpGain,
      level: next.level,
      levelsGained: next.levelsGained,
    };
  });
}

export async function withdrawTreasury(
  player: PlayerContext,
  amount: number,
): Promise<{ treasury: number; amount: number }> {
  const balance = getBalance();
  const membership = await requireMembership(player.id);
  if (!canWithdrawTreasury(membership.member.role as CoopRole, balance)) {
    throw gameError('coop_forbidden', 'Votre rang ne permet pas de retirer de la trésorerie.');
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const treasury = await socialRepo.withdrawTreasury(
      membership.coop.id,
      player.id,
      amount,
      'withdraw',
      'Retrait',
      tx,
    );
    if (treasury === null) {
      throw gameError('insufficient_funds', 'La trésorerie est insuffisante.');
    }
    await economyService.pay(
      {
        userId: player.id,
        amount,
        type: 'coop_payout',
        referenceType: 'coop',
        referenceId: membership.coop.id,
      },
      tx,
    );
    return { treasury, amount };
  });
}

// ---------------------------------------------------------------------------
// Objectifs hebdomadaires
// ---------------------------------------------------------------------------

/**
 * Génère les objectifs de la semaine s'ils n'existent pas encore.
 * Tirage déterministe par (coopérative, semaine) : deux membres qui ouvrent
 * `/coop objectifs` en même temps obtiennent la même liste.
 */
export async function ensureObjectives(coopId: string, now: Date = new Date()): Promise<void> {
  const balance = getBalance();
  const weekStart = currentWeekStart(now);
  const existing = await socialRepo.listObjectives(coopId, weekStart);
  if (existing.length >= balance.coop.weeklyObjectiveCount) return;

  const coop = await socialRepo.findCoopById(coopId);
  if (!coop) return;

  const rng = dailyRng(`coop-objectives:${coopId}`, weekStart);
  const picked = rng
    .shuffle(COOP_OBJECTIVE_TEMPLATES)
    .slice(0, balance.coop.weeklyObjectiveCount);

  await socialRepo.insertObjectives(
    picked.map((template) => {
      const objective = buildCoopObjective(template, coop.memberCount, coop.level);
      return {
        guildId: coopId,
        objectiveKey: objective.objectiveKey,
        title: objective.title,
        description: objective.description,
        target: objective.target,
        progress: 0,
        weekStart,
        rewardCoins: objective.rewardCoins,
        rewardGems: objective.rewardGems,
        rewardCoopXp: objective.rewardCoopXp,
      };
    }),
  );
}

export async function listObjectives(coopId: string, now: Date = new Date()) {
  await ensureObjectives(coopId, now);
  return socialRepo.listObjectives(coopId, currentWeekStart(now));
}

/**
 * Distribue les récompenses des objectifs terminés (job horaire).
 * `markObjectiveDistributed` est atomique : même si deux shards lancent le job,
 * une seule distribution a lieu.
 */
export async function distributeObjectiveRewards(limit = 20): Promise<number> {
  const balance = getBalance();
  const pending = await socialRepo.findObjectivesToDistribute(limit);
  let distributed = 0;

  for (const objective of pending) {
    await withTransaction(async (tx) => {
      const claimed = await socialRepo.markObjectiveDistributed(objective.id, tx);
      if (!claimed) return;

      const members = await socialRepo.listMembers(objective.guildId, tx);
      if (members.length === 0) return;

      const perMember = Math.floor(objective.rewardCoins / members.length);
      for (const member of members) {
        if (perMember > 0) {
          await economyService.pay(
            {
              userId: member.member.userId,
              amount: perMember,
              type: 'coop_payout',
              referenceType: 'coop_objective',
              referenceId: objective.id,
            },
            tx,
          );
        }
        if (objective.rewardGems > 0) {
          await economyService.pay(
            {
              userId: member.member.userId,
              amount: objective.rewardGems,
              currency: 'gems',
              type: 'coop_payout',
            },
            tx,
          );
        }
      }

      const coop = await socialRepo.lockCoop(tx, objective.guildId);
      if (coop) {
        const next = addCoopXp(
          { level: coop.level, xp: coop.xp },
          objective.rewardCoopXp,
          balance,
        );
        await socialRepo.addCoopXp(coop.id, next.level, next.xp, tx);
      }

      distributed += 1;
    });
  }

  if (distributed > 0) log.info({ distributed }, 'récompenses d\'objectifs distribuées');
  return distributed;
}

export async function weeklyReset(): Promise<void> {
  await socialRepo.resetWeeklyCoopScores();
  log.info('scores hebdomadaires de coopératives réinitialisés');
}

export { ROLE_LABELS };
