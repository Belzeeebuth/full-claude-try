import { balance as getBalance, getConfig, reloadConfig } from '../config';
import { env } from '../config/env';
import { lockUserRow, withTransaction } from '../db/client';
import { checkPrestigeEligibility, planPrestige, prestigeBadge } from '../game/prestige';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { reloadCatalogs, translate } from '../i18n';
import * as animalRepo from '../repositories/animal.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as farmRepo from '../repositories/farm.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import * as socialRepo from '../repositories/social.repo';
import * as systemRepo from '../repositories/system.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { grantXp } from './player.service';
import { toSqlDate } from '../utils/time';
import type { PlayerContext } from '../types';

const log = moduleLogger('misc');

/**
 * Services transverses : classements, prestige, parrainage, votes, visites,
 * notifications et administration. Regroupés parce qu'ils sont tous courts et
 * qu'aucun ne justifie son propre fichier.
 */

// ---------------------------------------------------------------------------
// CLASSEMENTS
// ---------------------------------------------------------------------------

/** Les classements de joueurs, plus le classement de coopératives. */
export type LeaderboardType = socialRepo.LeaderboardType | 'coop_score';

/** Seuls les emoji sont figés ici : libellé et unité viennent du catalogue i18n. */
export const LEADERBOARD_EMOJI: Record<LeaderboardType, string> = {
  wealth: '🪙',
  level: '⭐',
  harvests: '🌾',
  animals: '🐄',
  crafts: '🛠️',
  coop_score: '🤝',
  weekly_xp: '📈',
  streak: '🔥',
};

/** Métadonnées d'un classement, dans la langue du spectateur. */
export function leaderboardMeta(
  type: LeaderboardType,
  locale: string,
): { label: string; emoji: string; unit: string } {
  return {
    label: translate(locale, `leaderboard.${type}`),
    emoji: LEADERBOARD_EMOJI[type],
    unit: translate(locale, `leaderboard.unit.${type}`),
  };
}

export async function getLeaderboard(
  type: LeaderboardType,
  options: {
    scope?: 'global' | 'discord' | 'coop';
    discordGuildId?: string;
    coopId?: string;
    limit?: number;
    /** Langue du spectateur : le champ `extra` est rendu tel quel dans l'image. */
    locale?: string;
  } = {},
) {
  const locale = options.locale ?? 'fr';
  if (type === 'coop_score') {
    const rows = await socialRepo.coopLeaderboard(options.limit ?? 10);
    return {
      kind: 'coop' as const,
      rows: rows.map((row, index) => ({
        rank: index + 1,
        name: `${row.emblem} ${row.name} [${row.tag}]`,
        score: row.weeklyScore,
        level: row.level,
        extra: translate(locale, 'leaderboard.entry_members', { count: row.memberCount }),
      })),
    };
  }

  const playerType = type as socialRepo.LeaderboardType;
  const rows = await socialRepo.leaderboard(playerType, {
    limit: options.limit ?? 10,
    ...(options.scope === 'discord' && options.discordGuildId
      ? { discordGuildId: options.discordGuildId }
      : {}),
    ...(options.scope === 'coop' && options.coopId ? { coopId: options.coopId } : {}),
  });

  return {
    kind: 'player' as const,
    rows: rows.map((row, index) => ({
      rank: index + 1,
      userId: row.userId,
      discordId: row.discordId,
      name: row.username,
      score: Number(row.score),
      level: row.level,
      prestige: row.prestige,
      extra: `${translate(locale, 'leaderboard.entry_level', { level: row.level })}${row.prestige > 0 ? ` ${prestigeBadge(row.prestige)}` : ''}`,
    })),
  };
}

export async function getUserRank(type: LeaderboardType, userId: string) {
  if (type === 'coop_score') return undefined;
  return socialRepo.userRank(type as socialRepo.LeaderboardType, userId);
}

/** Capture les classements hebdomadaires (job du lundi). */
export async function snapshotLeaderboards(periodKey: string): Promise<number> {
  const types: LeaderboardType[] = ['wealth', 'level', 'harvests', 'weekly_xp'];
  let total = 0;

  for (const type of types) {
    const playerType = type as socialRepo.LeaderboardType;
  const rows = await socialRepo.leaderboard(playerType, { limit: 100 });
    await socialRepo.saveSnapshots(
      rows.map((row, index) => ({
        boardType: type,
        scope: 'global' as const,
        scopeId: 'global',
        period: 'weekly' as const,
        periodKey,
        userId: row.userId,
        rank: index + 1,
        score: Number(row.score),
      })),
    );
    total += rows.length;
  }

  log.info({ periodKey, total }, 'leaderboards frozen');
  return total;
}

// ---------------------------------------------------------------------------
// PRESTIGE
// ---------------------------------------------------------------------------

export async function previewPrestige(player: PlayerContext) {
  const balance = getBalance();
  const eligibility = checkPrestigeEligibility(player, balance);
  const unlockedPlots = await farmRepo.countUnlockedPlots(player.farmId);
  const plan = planPrestige(
    {
      level: player.level,
      xp: player.xp,
      coins: player.coins,
      prestige: player.prestige,
      unlockedPlots,
    },
    balance,
  );
  return { eligibility, plan, unlockedPlots };
}

/**
 * Exécute la renaissance. Action IRRÉVERSIBLE, donc :
 *  - elle est toujours précédée d'un aperçu et d'une double confirmation ;
 *  - elle est journalisée dans l'audit ;
 *  - elle se déroule dans une transaction unique : impossible de se retrouver
 *    avec un niveau remis à zéro mais les parcelles conservées.
 */
export async function doPrestige(player: PlayerContext): Promise<{
  newPrestige: number;
  multiplier: number;
  plotsKept: number;
  coinsKept: number;
  pointsGained: number;
}> {
  const balance = getBalance();
  const { eligibility, plan, unlockedPlots } = await previewPrestige(player);
  if (!eligibility.eligible) {
    throw gameError('level_too_low', eligibility.reason ?? 'Prestige unavailable.');
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const schema = await import('../db/schema');
    const { eq, sql, gt } = await import('drizzle-orm');

    // 1. Niveau, XP, énergie, prestige et points.
    await tx
      .update(schema.users)
      .set({
        level: 1,
        xp: 0,
        coins: plan.coinsKept + plan.startingCoins,
        prestige: plan.newPrestige,
        prestigePoints: sql`${schema.users.prestigePoints} + ${plan.pointsGained}`,
        energy: balance.energy.startingMax,
        energyUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, player.id));

    await economyRepo.recordGenesisLedger(
      {
        userId: player.id,
        type: 'prestige_reset',
        amount: plan.coinsKept + plan.startingCoins,
        balanceAfter: plan.coinsKept + plan.startingCoins,
        metadata: { prestige: plan.newPrestige, kept: plan.coinsKept },
      },
      tx,
    );

    // 2. Parcelles : on reverrouille au-delà de la moitié conservée.
    await tx
      .update(schema.plots)
      .set({ state: 'locked', unlockedAt: null, fertility: balance.fertility.start, weedLevel: 0 })
      .where(
        (await import('drizzle-orm')).and(
          eq(schema.plots.farmId, player.farmId),
          gt(schema.plots.slot, plan.plotsKept),
        ),
      );

    // 3. Cultures en cours : perdues.
    await tx.delete(schema.plantedCrops).where(eq(schema.plantedCrops.userId, player.id));
    await tx
      .update(schema.plots)
      .set({ state: 'empty' })
      .where(
        (await import('drizzle-orm')).and(
          eq(schema.plots.farmId, player.farmId),
          eq(schema.plots.state, 'planted'),
        ),
      );

    // 4. Animaux (non conservés par défaut).
    if (!plan.animalsKept) {
      await tx.delete(schema.ownedAnimals).where(eq(schema.ownedAnimals.userId, player.id));
    }

    // 5. Inventaire : seules les catégories listées survivent.
    await inventoryRepo.wipeInventoryExcept(player.id, plan.inventoryCategoriesKept, tx);
    await inventoryService.addItems(
      player.id,
      [
        { itemKey: 'seed_wheat', quantity: 15 },
        { itemKey: 'fertilizer_basic', quantity: 3 },
      ],
      tx,
      { allowOverflow: true },
    );

    await systemRepo.audit(
      {
        actorId: player.id,
        actorDiscordId: player.discordId,
        action: 'prestige',
        targetType: 'user',
        targetId: player.id,
        payload: { from: player.level, prestige: plan.newPrestige, unlockedPlots },
        severity: 'info',
      },
      tx,
    );

    log.info({ userId: player.id, prestige: plan.newPrestige }, 'rebirth completed');

    return {
      newPrestige: plan.newPrestige,
      multiplier: plan.newMultiplier,
      plotsKept: plan.plotsKept,
      coinsKept: plan.coinsKept,
      pointsGained: plan.pointsGained,
    };
  });
}

// ---------------------------------------------------------------------------
// VISITES ET PARRAINAGE
// ---------------------------------------------------------------------------

export async function recordVisit(
  visitor: PlayerContext,
  host: { id: string; farmId: string },
  helped: boolean,
  plotsWatered: number,
): Promise<{ rewarded: boolean; coins: number; xp: number }> {
  const balance = getBalance();
  const today = toSqlDate(new Date());

  if (visitor.id === host.id) return { rewarded: false, coins: 0, xp: 0 };

  const helpsToday = await socialRepo.countHelpsToday(visitor.id, today);
  if (helped && helpsToday >= balance.social.maxHelpsPerDay) {
    throw gameError(
      'forbidden',
      `You have already helped ${balance.social.maxHelpsPerDay} farmers today.`,
    );
  }

  const coins = helped ? balance.social.helpRewardCoins : balance.social.visitRewardCoins;
  const xp = helped ? balance.social.helpRewardXp : balance.social.visitRewardXp;

  return withTransaction(async (tx) => {
    const rewarded = await socialRepo.recordVisit(
      {
        visitorId: visitor.id,
        hostId: host.id,
        helped,
        plotsWatered,
        rewardCoins: coins,
        rewardXp: xp,
        visitDate: today,
      },
      tx,
    );

    // Sans récompense (déjà visité aujourd'hui), la visite reste possible : on ne
    // bloque jamais la consultation, on ne paie simplement pas deux fois.
    if (!rewarded) return { rewarded: false, coins: 0, xp: 0 };

    await economyService.pay(
      { userId: visitor.id, amount: coins, type: 'quest_reward', counterpartyId: host.id },
      tx,
    );
    await grantXp(visitor.id, xp, tx);

    if (helped) {
      // L'hôte reçoit aussi une petite récompense : l'entraide profite aux deux,
      // sinon personne n'accepterait les visites.
      await economyService.pay(
        { userId: host.id, amount: Math.floor(coins / 2), type: 'quest_reward', counterpartyId: visitor.id },
        tx,
      );
      await tx
        .update((await import('../db/schema')).farms)
        .set({ helpsReceived: (await import('drizzle-orm')).sql`helps_received + 1` })
        .where((await import('drizzle-orm')).eq((await import('../db/schema')).farms.id, host.farmId));
    }

    await tx
      .update((await import('../db/schema')).farms)
      .set({ visitsCount: (await import('drizzle-orm')).sql`visits_count + 1` })
      .where((await import('drizzle-orm')).eq((await import('../db/schema')).farms.id, host.farmId));

    const { trackAction } = await import('./tracker.service');
    await trackAction(
      { userId: visitor.id, coopId: visitor.coopId, level: visitor.level },
      helped ? 'help_farmer' : 'visit_farm',
      1,
      {},
      tx,
    );

    return { rewarded: true, coins, xp };
  });
}

export async function referralStatus(userId: string) {
  const user = await playerRepo.findUserById(userId);
  const balance = getBalance();
  return {
    code: user?.referralCode ?? '',
    rewardCoins: balance.social.referralRewardCoins,
    rewardGems: balance.social.referralRewardGems,
    qualifyLevel: balance.social.referralQualifyLevel,
    referredBy: user?.referredBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// VOTES
// ---------------------------------------------------------------------------

export function voteInfo() {
  const balance = getBalance();
  return {
    url: env.TOPGG_VOTE_URL ?? 'https://top.gg',
    rewardGems: balance.vote.rewardGems,
    rewardCoins: balance.vote.rewardCoins,
    weekendMultiplier: balance.vote.weekendMultiplier,
    cooldownHours: balance.vote.cooldownHours,
  };
}

// ---------------------------------------------------------------------------
// ADMINISTRATION
// ---------------------------------------------------------------------------

export interface AdminGrantInput {
  actor: PlayerContext;
  targetDiscordId: string;
  resource: 'coins' | 'gems' | 'xp' | 'item' | 'energy';
  amount: number;
  itemKey?: string;
  reason?: string;
}

/**
 * Attribution ou retrait de ressources par un administrateur.
 * TOUT passe par le journal comptable et l'audit : une commande admin est la
 * seule façon de créer de la monnaie hors gameplay, elle doit donc être la plus
 * traçable du système.
 */
export async function adminGrant(
  input: AdminGrantInput,
  remove = false,
): Promise<{ targetId: string; applied: number }> {
  const target = await playerRepo.findUserByDiscordId(input.targetDiscordId);
  if (!target) throw gameError('not_found', 'Player not found.');
  const amount = Math.abs(Math.floor(input.amount));

  return withTransaction(async (tx) => {
    await lockUserRow(tx, target.id);

    switch (input.resource) {
      case 'coins':
      case 'gems': {
        const currency = input.resource;
        if (remove) {
          await economyService.charge(
            {
              userId: target.id,
              amount,
              currency,
              type: 'admin_remove',
              metadata: { actor: input.actor.discordId, reason: input.reason },
            },
            tx,
          );
        } else {
          await economyService.pay(
            {
              userId: target.id,
              amount,
              currency,
              type: 'admin_grant',
              metadata: { actor: input.actor.discordId, reason: input.reason },
            },
            tx,
          );
        }
        break;
      }
      case 'xp':
        await grantXp(target.id, remove ? 0 : amount, tx);
        break;
      case 'energy':
        await playerRepo.setEnergy(
          target.id,
          {
            energy: Math.min(target.energyMax, Math.max(0, target.energy + (remove ? -amount : amount))),
            energyUpdatedAt: new Date(),
          },
          tx,
        );
        break;
      case 'item': {
        if (!input.itemKey) throw gameError('item_unknown', 'Specify the item key.');
        if (remove) {
          await inventoryService.consume(target.id, input.itemKey, amount, tx);
        } else {
          await inventoryService.addItems(
            target.id,
            [{ itemKey: input.itemKey, quantity: amount }],
            tx,
            { allowOverflow: true },
          );
        }
        break;
      }
      default:
        throw gameError('target_invalid', 'Unknown resource.');
    }

    await systemRepo.audit(
      {
        actorId: input.actor.id,
        actorDiscordId: input.actor.discordId,
        action: remove ? 'admin_remove' : 'admin_grant',
        targetType: 'user',
        targetId: target.id,
        targetDiscordId: target.discordId,
        reason: input.reason ?? null,
        payload: { resource: input.resource, amount, itemKey: input.itemKey },
        severity: 'warn',
      },
      tx,
    );

    return { targetId: target.id, applied: amount };
  });
}

export async function adminEcoBan(
  actor: PlayerContext,
  targetDiscordId: string,
  durationHours: number,
  reason: string,
): Promise<{ until: Date }> {
  const target = await playerRepo.findUserByDiscordId(targetDiscordId);
  if (!target) throw gameError('not_found', 'Player not found.');
  const until = new Date(Date.now() + Math.max(1, durationHours) * 3_600_000);

  await playerRepo.setEcoBan(target.id, until, reason);
  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_eco_ban',
    targetType: 'user',
    targetId: target.id,
    targetDiscordId: target.discordId,
    reason,
    payload: { until: until.toISOString(), durationHours },
    severity: 'warn',
  });

  return { until };
}

export async function adminResetPlayer(
  actor: PlayerContext,
  targetDiscordId: string,
  reason: string,
): Promise<void> {
  const target = await playerRepo.findUserByDiscordId(targetDiscordId);
  if (!target) throw gameError('not_found', 'Player not found.');

  await withTransaction(async (tx) => {
    const schema = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    // Soft delete : le joueur disparaît du jeu mais son journal comptable reste
    // consultable pour l'audit. Un `/start` recréera un compte neuf.
    await tx
      .update(schema.users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.users.id, target.id));

    await systemRepo.audit(
      {
        actorId: actor.id,
        actorDiscordId: actor.discordId,
        action: 'admin_reset',
        targetType: 'user',
        targetId: target.id,
        targetDiscordId: target.discordId,
        reason,
        payload: { level: target.level, coins: target.coins },
        severity: 'error',
      },
      tx,
    );
  });
}

/** Recharge la configuration de gameplay et les traductions à chaud. */
export async function adminReloadConfig(actor: PlayerContext): Promise<{
  crops: number;
  items: number;
  recipes: number;
  quests: number;
  loadedAt: Date;
}> {
  const config = reloadConfig();
  reloadCatalogs();

  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_reload_config',
    payload: { loadedAt: config.loadedAt.toISOString() },
    severity: 'warn',
  });

  return {
    crops: config.cropList.length,
    items: config.itemList.length,
    recipes: config.recipeList.length,
    quests: config.questList.length,
    loadedAt: config.loadedAt,
  };
}

export async function adminStats() {
  const [counts, economy, tasks] = await Promise.all([
    systemRepo.globalCounts(),
    economyService.economyDashboard(),
    systemRepo.listTasks(),
  ]);
  const config = getConfig();

  return {
    counts,
    economy,
    tasks: tasks.slice(0, 12),
    config: {
      loadedAt: config.loadedAt,
      crops: config.cropList.length,
      items: config.itemList.length,
      recipes: config.recipeList.length,
    },
  };
}

export async function adminLookup(targetDiscordId: string, limit = 15) {
  const [target, logs] = await Promise.all([
    playerRepo.findUserByDiscordId(targetDiscordId),
    systemRepo.listAuditForTarget(targetDiscordId, limit),
  ]);
  if (!target) throw gameError('not_found', 'Player not found.');
  const transactions = await economyRepo.listTransactions(target.id, limit);
  return { target, logs, transactions };
}

// ---------------------------------------------------------------------------
// MAINTENANCE
// ---------------------------------------------------------------------------

let maintenanceState = { enabled: env.MAINTENANCE_MODE, message: env.MAINTENANCE_MESSAGE };

export function getMaintenance(): { enabled: boolean; message: string } {
  return { ...maintenanceState };
}

export async function setMaintenance(
  actor: PlayerContext,
  enabled: boolean,
  message?: string,
): Promise<void> {
  maintenanceState = {
    enabled,
    message: message ?? maintenanceState.message,
  };
  await systemRepo.audit({
    actorId: actor.id,
    actorDiscordId: actor.discordId,
    action: 'admin_maintenance',
    payload: { enabled, message: maintenanceState.message },
    severity: 'warn',
  });
  log.warn({ enabled }, 'maintenance mode changed');
}

/** Statistiques d'un joueur pour `/stats`. */
export async function playerStats(discordId: string) {
  const user = await playerRepo.findUserByDiscordId(discordId);
  if (!user) return null;
  const [farm, animals, inventoryTotal, streak, ranks] = await Promise.all([
    playerRepo.getFarmByUserId(user.id),
    animalRepo.listAnimals((await playerRepo.getFarmByUserId(user.id))?.id ?? '', { includeDead: true }),
    inventoryRepo.totalQuantity(user.id),
    playerRepo.getDailyStreak(user.id),
    Promise.all([
      socialRepo.userRank('wealth', user.id),
      socialRepo.userRank('level', user.id),
      socialRepo.userRank('harvests', user.id),
    ]),
  ]);

  return {
    user,
    farm,
    animalsTotal: animals.length,
    animalsAlive: animals.filter((entry) => entry.animal.isAlive).length,
    inventoryTotal,
    streak: streak?.currentStreak ?? 0,
    longestStreak: streak?.longestStreak ?? 0,
    ranks: { wealth: ranks[0], level: ranks[1], harvests: ranks[2] },
  };
}
