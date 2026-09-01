import { balance as getBalance } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import {
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
}

export async function getCoopInfo(coopId: string, viewerId?: string): Promise<CoopInfo> {
  const balance = getBalance();
  const coop = await socialRepo.findCoopById(coopId);
  if (!coop) throw gameError('coop_not_found', 'Co-op not found.', { i18nKey: 'errors.coop.not_found' });

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
      ? { role: membership.member.role as CoopRole }
      : {}),
  };
}

export async function requireMembership(userId: string) {
  const membership = await socialRepo.getMembership(userId);
  if (!membership) {
    throw gameError('coop_not_member', "You are not in a co-op.", {
      i18nKey: 'coop.not_member',
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
      'The name must be 3 to 32 characters (letters, digits, spaces, apostrophes, hyphens).',
      { i18nKey: 'errors.coop.invalid_name' },
    );
  }
  if (!TAG_PATTERN.test(tag)) {
    throw gameError('quantity_invalid', "The tag must be 2 to 5 alphanumeric characters.", {
      i18nKey: 'errors.coop.invalid_tag',
    });
  }
  if (player.level < balance.coop.creationMinLevel) {
    throw gameError(
      'level_too_low',
      `Creating a co-op requires level ${balance.coop.creationMinLevel}.`,
      { i18nKey: 'errors.coop.creation_min_level', params: { level: balance.coop.creationMinLevel } },
    );
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const existing = await socialRepo.getMembership(player.id, tx);
    if (existing) {
      throw gameError('coop_already_member', 'You are already in a co-op.', {
        i18nKey: 'coop.already_member',
      });
    }

    const taken = await socialRepo.findCoopByNameOrTag(name, tx);
    const tagTaken = await socialRepo.findCoopByNameOrTag(tag, tx);
    if (taken || tagTaken) {
      throw gameError('coop_name_taken', 'That name or tag is already taken.', {
        i18nKey: 'coop.name_taken',
      });
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

    log.info({ coopId: coop.id, name, ownerId: player.id }, 'co-op created');
    return getCoopInfo(coop.id, player.id);
  });
}

export async function joinCoop(
  player: PlayerContext,
  query: string,
): Promise<CoopInfo> {
  return withTransaction(async (tx) => {
    const existing = await socialRepo.getMembership(player.id, tx);
    if (existing) {
      throw gameError('coop_already_member', 'You are already in a co-op.', {
        i18nKey: 'coop.already_member',
      });
    }

    const coop = await socialRepo.findCoopByNameOrTag(query, tx);
    if (!coop) {
      throw gameError('coop_not_found', `No co-op named "${query}".`, {
        i18nKey: 'errors.coop.not_found_named',
        params: { query },
      });
    }
    if (!coop.isPublic) {
      throw gameError('coop_forbidden', 'This co-op is invite-only.', {
        i18nKey: 'errors.coop.invite_only',
      });
    }
    if (player.level < coop.joinRequirementLevel) {
      throw gameError(
        'level_too_low',
        `${coop.name} requires level ${coop.joinRequirementLevel}.`,
        { i18nKey: 'errors.level_too_low', params: { name: coop.name, level: coop.joinRequirementLevel } },
      );
    }

    const joined = await socialRepo.joinCoop(coop.id, player.id, tx);
    if (!joined) {
      throw gameError('coop_full', `${coop.name} is full (${coop.memberLimit} members).`, {
        i18nKey: 'errors.coop.full_named',
        params: { name: coop.name, limit: coop.memberLimit },
      });
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
    throw gameError('coop_forbidden', 'Only officers and the leader can invite.', {
      i18nKey: 'errors.coop.invite_forbidden',
    });
  }

  return withTransaction(async (tx) => {
    const targetMembership = await socialRepo.getMembership(targetUserId, tx);
    if (targetMembership) {
      throw gameError('coop_already_member', 'That player is already in a co-op.', {
        i18nKey: 'errors.coop.target_already_member',
      });
    }
    const joined = await socialRepo.joinCoop(membership.coop.id, targetUserId, tx);
    if (!joined) {
      throw gameError('coop_full', 'Your co-op is full.', { i18nKey: 'errors.coop.own_full' });
    }
    return { coopName: membership.coop.name };
  });
}

export async function leaveCoop(player: PlayerContext): Promise<{ coopName: string; dissolved: boolean }> {
  const membership = await requireMembership(player.id);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const coop = await socialRepo.lockCoop(tx, membership.coop.id);
    if (!coop) throw gameError('coop_not_found', 'Co-op not found.', { i18nKey: 'errors.coop.not_found' });

    // Le chef ne peut pas partir sans transmettre : sinon la trésorerie et les
    // objectifs se retrouveraient sans responsable.
    if (membership.member.role === 'owner' && coop.memberCount > 1) {
      throw gameError(
        'coop_forbidden',
        'As the leader, hand over the lead first with `/coop promote`.',
        { i18nKey: 'errors.coop.leader_must_transfer' },
      );
    }

    await socialRepo.leaveCoop(coop.id, player.id, tx);

    // Dernier membre : la coopérative disparaît réellement. Sa trésorerie est
    // rendue au partant — c'est nécessairement lui qui l'a majoritairement
    // constituée, et la laisser dans une ligne orpheline la retirerait de
    // l'économie sans la détruire ni la journaliser.
    const dissolved = coop.memberCount <= 1;
    if (dissolved) {
      if (coop.treasury > 0) {
        await socialRepo.withdrawTreasury(
          coop.id,
          player.id,
          coop.treasury,
          'withdraw',
          'Co-op dissolved',
          tx,
        );
        await economyService.pay(
          {
            userId: player.id,
            amount: coop.treasury,
            type: 'coop_payout',
            referenceType: 'coop',
            referenceId: coop.id,
          },
          tx,
        );
      }
      await socialRepo.dissolveCoop(coop.id, tx);
      log.info({ coopId: coop.id, name: coop.name }, 'co-op dissolved');
    }

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
    throw gameError('coop_forbidden', 'Only officers and the leader can kick.', {
      i18nKey: 'errors.coop.kick_forbidden',
    });
  }
  if (targetUserId === player.id) {
    throw gameError('target_invalid', 'Use `/coop leave` to go.', {
      i18nKey: 'errors.coop.use_leave_command',
    });
  }

  return withTransaction(async (tx) => {
    const target = await socialRepo.getMembership(targetUserId, tx);
    if (!target || target.member.guildId !== membership.coop.id) {
      throw gameError('coop_not_member', "That player is not in your co-op.", {
        i18nKey: 'errors.coop.target_not_member',
      });
    }
    if (!canActOn(actorRole, target.member.role as CoopRole)) {
      throw gameError('coop_forbidden', 'You cannot kick a member of equal or higher rank.', {
        i18nKey: 'errors.coop.cannot_kick_rank',
      });
    }
    await socialRepo.leaveCoop(membership.coop.id, targetUserId, tx);
    return { coopName: membership.coop.name };
  });
}

export async function promoteMember(
  player: PlayerContext,
  targetUserId: string,
  role: CoopRole,
): Promise<{ role: CoopRole }> {
  const membership = await requireMembership(player.id);
  if (membership.member.role !== 'owner') {
    throw gameError('coop_forbidden', 'Only the leader can change ranks.', {
      i18nKey: 'errors.coop.promote_forbidden',
    });
  }

  return withTransaction(async (tx) => {
    const target = await socialRepo.getMembership(targetUserId, tx);
    if (!target || target.member.guildId !== membership.coop.id) {
      throw gameError('coop_not_member', "That player is not in your co-op.", {
        i18nKey: 'errors.coop.target_not_member',
      });
    }

    await socialRepo.setMemberRole(membership.coop.id, targetUserId, role, tx);
    // Passer la direction : l'ancien chef devient officier, il n'y a jamais deux
    // chefs ni zéro chef.
    if (role === 'owner') {
      await socialRepo.setMemberRole(membership.coop.id, player.id, 'officer', tx);
    }
    return { role };
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
  if (amount <= 0) {
    throw gameError('quantity_invalid', 'The amount must be positive.', {
      i18nKey: 'errors.economy.amount_must_be_positive',
    });
  }
  const membership = await requireMembership(player.id);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const coop = await socialRepo.lockCoop(tx, membership.coop.id);
    if (!coop) throw gameError('coop_not_found', 'Co-op not found.', { i18nKey: 'errors.coop.not_found' });

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
      'Voluntary contribution',
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
  if (amount <= 0) {
    throw gameError('quantity_invalid', 'The amount must be positive.', {
      i18nKey: 'errors.economy.amount_must_be_positive',
    });
  }
  const membership = await requireMembership(player.id);
  if (!canWithdrawTreasury(membership.member.role as CoopRole, balance)) {
    throw gameError('coop_forbidden', 'Your rank does not allow withdrawing from the treasury.', {
      i18nKey: 'errors.coop.withdraw_forbidden',
    });
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const treasury = await socialRepo.withdrawTreasury(
      membership.coop.id,
      player.id,
      amount,
      'withdraw',
      'Withdrawal',
      tx,
    );
    if (treasury === null) {
      throw gameError('insufficient_funds', 'The treasury is insufficient.', {
        i18nKey: 'errors.coop.treasury_insufficient',
      });
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
 * `/coop objectives` en même temps obtiennent la même liste.
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

      // Pièces ET gemmes sont partagées. Les gemmes étaient versées EN ENTIER à
      // chaque membre : une coop de trente personnes produisait trente fois la
      // récompense prévue, sur la monnaie premium.
      const coinsPerMember = Math.floor(objective.rewardCoins / members.length);
      const gemsPerMember = Math.floor(objective.rewardGems / members.length);
      for (const member of members) {
        if (coinsPerMember > 0) {
          await economyService.pay(
            {
              userId: member.member.userId,
              amount: coinsPerMember,
              type: 'coop_payout',
              referenceType: 'coop_objective',
              referenceId: objective.id,
            },
            tx,
          );
        }
        if (gemsPerMember > 0) {
          await economyService.pay(
            {
              userId: member.member.userId,
              amount: gemsPerMember,
              currency: 'gems',
              type: 'coop_payout',
              referenceType: 'coop_objective',
              referenceId: objective.id,
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

  if (distributed > 0) log.info({ distributed }, 'objective rewards distributed');
  return distributed;
}

export async function weeklyReset(): Promise<void> {
  await socialRepo.resetWeeklyCoopScores();
  log.info('weekly co-op scores reset');
}
