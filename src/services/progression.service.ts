import { balance as getBalance, getActiveSeasonPass, getConfig, type QuestConfig } from '../config';
import { lockUserRow, withTransaction, type Executor } from '../db/client';
import { dailyRng, liveRng } from '../game/rng';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as playerRepo from '../repositories/player.repo';
import * as progressionRepo from '../repositories/progression.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { grantXp } from './player.service';
import { getWorldState } from './world.service';
import {
  currentWeekStart,
  dailyCycleKey,
  nextMidnight,
  nextMondayMidnight,
  weeklyCycleKey,
} from '../utils/time';
import type { PlayerContext } from '../types';

const log = moduleLogger('progression');

/**
 * Quêtes, récompense quotidienne, succès et passe saisonnier.
 *
 * L'assignation des quêtes est PARESSEUSE : elle a lieu la première fois que le
 * joueur ouvre `/quests` dans un nouveau cycle, pas via un job qui parcourrait
 * 100 000 joueurs à minuit. Un joueur inactif ne coûte donc rien, et la charge
 * s'étale naturellement sur la journée.
 */

export interface QuestView {
  id: string;
  key: string;
  type: 'daily' | 'weekly' | 'story' | 'contract';
  title: string;
  description: string;
  progress: number;
  required: number;
  status: 'active' | 'completed' | 'claimed' | 'expired' | 'failed';
  rewards: { coins: number; gems: number; xp: number; items: Array<{ itemKey: string; quantity: number }> };
  expiresAt: Date | null;
  rerolled: boolean;
}

interface QuestSnapshotShape {
  title: string;
  description: string;
  objectiveType: string;
  objectiveTarget: Record<string, string>;
  rewardCoins: number;
  rewardGems: number;
  rewardXp: number;
  rewardPassXp: number;
  rewardItems: Array<{ itemKey: string; quantity: number }>;
  chainKey?: string;
  chainStep?: number;
}

/**
 * Met à l'échelle les récompenses selon le niveau du joueur.
 * Sans cela, une quête « récolter 10 unités » offrant 400 pièces serait
 * essentielle au niveau 2 et dérisoire au niveau 40 : le joueur cesserait de
 * faire ses quêtes, et l'on perdrait le principal levier de rétention quotidienne.
 */
function scaleReward(value: number, level: number): number {
  const balance = getBalance();
  return Math.round(value * (1 + balance.quests.rewardLevelScale * Math.max(0, level - 1)));
}

function scaleAmount(value: number, level: number): number {
  const balance = getBalance();
  return Math.max(1, Math.round(value * (1 + balance.quests.amountLevelScale * Math.max(0, level - 1))));
}

function buildSnapshot(quest: QuestConfig, level: number): QuestSnapshotShape {
  return {
    title: quest.title,
    description: quest.description,
    objectiveType: quest.objectiveType,
    objectiveTarget: Object.fromEntries(
      Object.entries(quest.objectiveTarget).filter(([, value]) => value !== undefined),
    ) as Record<string, string>,
    rewardCoins: scaleReward(quest.rewardCoins, level),
    rewardGems: quest.rewardGems,
    rewardXp: scaleReward(quest.rewardXp, level),
    rewardPassXp: quest.rewardPassXp,
    rewardItems: quest.rewardItems,
    ...(quest.chainKey ? { chainKey: quest.chainKey } : {}),
    ...(quest.chainStep ? { chainStep: quest.chainStep } : {}),
  };
}

/**
 * Assigne les quêtes manquantes du cycle courant.
 * Idempotent : l'index unique `(user, quest, cycle)` fait que deux appels
 * simultanés n'assignent jamais deux fois la même quête.
 */
export async function ensureQuests(
  player: Pick<PlayerContext, 'id' | 'level'>,
  timezone = 'Europe/Paris',
  now: Date = new Date(),
): Promise<void> {
  const balance = getBalance();
  const dailyKey = dailyCycleKey(now, timezone);
  const weeklyKey = weeklyCycleKey(now, timezone);

  const existing = await progressionRepo.listUserQuests(player.id);
  const dailies = existing.filter((quest) => quest.type === 'daily' && quest.cycleKey === dailyKey);
  const weeklies = existing.filter((quest) => quest.type === 'weekly' && quest.cycleKey === weeklyKey);
  const contracts = existing.filter(
    (quest) => quest.type === 'contract' && quest.cycleKey === dailyKey,
  );
  const stories = existing.filter((quest) => quest.type === 'story');

  const toAssign: Array<Parameters<typeof progressionRepo.assignQuests>[0][number]> = [];

  // --- Journalières : tirage pondéré déterministe par jour et par joueur ---
  if (dailies.length < balance.quests.dailyCount) {
    const pool = await progressionRepo.listQuestPool('daily', player.level);
    const rng = dailyRng(`quests:${player.id}`, dailyKey);
    const picked = pickWeighted(pool, balance.quests.dailyCount - dailies.length, rng, new Set(dailies.map((q) => q.questKey)));
    picked.forEach((quest, index) => {
      toAssign.push({
        userId: player.id,
        questKey: quest.key,
        type: 'daily',
        progress: 0,
        required: scaleAmount(quest.requiredAmount, player.level),
        cycleKey: dailyKey,
        slotIndex: dailies.length + index,
        snapshot: buildSnapshot(toQuestConfig(quest), player.level),
        expiresAt: nextMidnight(now, timezone),
      });
    });
  }

  // --- Hebdomadaires ---
  if (weeklies.length < balance.quests.weeklyCount) {
    const pool = await progressionRepo.listQuestPool('weekly', player.level);
    const rng = dailyRng(`weeklies:${player.id}`, weeklyKey);
    const picked = pickWeighted(pool, balance.quests.weeklyCount - weeklies.length, rng, new Set(weeklies.map((q) => q.questKey)));
    picked.forEach((quest, index) => {
      toAssign.push({
        userId: player.id,
        questKey: quest.key,
        type: 'weekly',
        progress: 0,
        required: scaleAmount(quest.requiredAmount, player.level),
        cycleKey: weeklyKey,
        slotIndex: weeklies.length + index,
        snapshot: buildSnapshot(toQuestConfig(quest), player.level),
        expiresAt: nextMondayMidnight(now, timezone),
      });
    });
  }

  // --- Contrats du village ---
  if (contracts.length < balance.quests.contractCount) {
    const pool = await progressionRepo.listQuestPool('contract', player.level);
    const rng = dailyRng(`contracts:${player.id}`, dailyKey);
    const picked = pickWeighted(pool, balance.quests.contractCount - contracts.length, rng, new Set(contracts.map((q) => q.questKey)));
    picked.forEach((quest, index) => {
      toAssign.push({
        userId: player.id,
        questKey: quest.key,
        type: 'contract',
        progress: 0,
        required: quest.requiredAmount,
        cycleKey: dailyKey,
        slotIndex: contracts.length + index,
        snapshot: buildSnapshot(toQuestConfig(quest), player.level),
        expiresAt: nextMidnight(now, timezone),
      });
    });
  }

  // --- Chaîne narrative : une seule quête active à la fois ---
  const activeStory = stories.find((quest) => quest.status === 'active');
  if (!activeStory) {
    const step = (await progressionRepo.highestStoryStep(player.id, balance.quests.storyChainKey)) + 1;
    const next = await progressionRepo.nextStoryQuest(balance.quests.storyChainKey, step);
    if (next && next.requiredLevel <= player.level) {
      toAssign.push({
        userId: player.id,
        questKey: next.key,
        type: 'story',
        progress: 0,
        required: next.requiredAmount,
        cycleKey: `story-${step}`,
        slotIndex: step,
        snapshot: buildSnapshot(toQuestConfig(next), player.level),
        expiresAt: null,
      });
    }
  }

  if (toAssign.length > 0) {
    await progressionRepo.assignQuests(toAssign);
    log.debug({ userId: player.id, count: toAssign.length }, 'quests assigned');
  }
}

function toQuestConfig(row: {
  key: string;
  title: string;
  description: string;
  objectiveType: string;
  objectiveTarget: unknown;
  requiredAmount: number;
  rewardCoins: number;
  rewardGems: number;
  rewardXp: number;
  rewardPassXp: number;
  rewardItems: unknown;
  chainKey: string | null;
  chainStep: number | null;
}): QuestConfig {
  return {
    key: row.key,
    type: 'daily',
    title: row.title,
    description: row.description,
    objectiveType: row.objectiveType as QuestConfig['objectiveType'],
    objectiveTarget: (row.objectiveTarget ?? {}) as QuestConfig['objectiveTarget'],
    requiredAmount: row.requiredAmount,
    rewardCoins: row.rewardCoins,
    rewardGems: row.rewardGems,
    rewardXp: row.rewardXp,
    rewardPassXp: row.rewardPassXp,
    rewardItems: (row.rewardItems ?? []) as QuestConfig['rewardItems'],
    requiredLevel: 1,
    weight: 10,
    enabled: true,
    ...(row.chainKey ? { chainKey: row.chainKey } : {}),
    ...(row.chainStep ? { chainStep: row.chainStep } : {}),
  };
}

function pickWeighted<T extends { key: string; weight: number }>(
  pool: T[],
  count: number,
  rng: ReturnType<typeof dailyRng>,
  exclude: Set<string>,
): T[] {
  const candidates = pool.filter((entry) => !exclude.has(entry.key));
  const picked: T[] = [];
  const remaining = [...candidates];

  for (let index = 0; index < count && remaining.length > 0; index += 1) {
    const chosen = rng.weighted(remaining.map((entry) => ({ value: entry, weight: entry.weight })));
    if (!chosen) break;
    picked.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return picked;
}

export async function listQuests(
  player: Pick<PlayerContext, 'id' | 'level'>,
  options: { type?: 'daily' | 'weekly' | 'story' | 'contract'; timezone?: string } = {},
): Promise<QuestView[]> {
  await ensureQuests(player, options.timezone);
  const rows = await progressionRepo.listUserQuests(player.id, { type: options.type });
  const now = Date.now();

  return rows
    .filter((row) => row.status !== 'expired')
    .filter((row) => !row.expiresAt || row.expiresAt.getTime() > now)
    .map((row) => {
      const snapshot = row.snapshot as QuestSnapshotShape;
      return {
        id: row.id,
        key: row.questKey,
        type: row.type,
        title: snapshot.title,
        description: snapshot.description,
        progress: row.progress,
        required: row.required,
        status: row.status,
        rewards: {
          coins: snapshot.rewardCoins,
          gems: snapshot.rewardGems,
          xp: snapshot.rewardXp,
          items: snapshot.rewardItems ?? [],
        },
        expiresAt: row.expiresAt,
        rerolled: row.rerolled,
      };
    });
}

export interface ClaimResult {
  title: string;
  coins: number;
  gems: number;
  xp: number;
  items: Array<{ itemKey: string; quantity: number }>;
  levelUp: { level: number; levelsGained: number } | null;
  passTier?: number;
}

/** Perçoit la récompense d'une quête terminée. Idempotent. */
export async function claimQuest(player: PlayerContext, questId: string): Promise<ClaimResult> {
  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const quest = await progressionRepo.lockQuest(tx, questId, player.id);
    if (!quest) throw gameError('not_found', 'Quest not found.');
    if (quest.status === 'claimed') {
      throw gameError('invalid_state', 'This reward was already claimed.');
    }
    if (quest.status !== 'completed' || quest.progress < quest.required) {
      throw gameError('invalid_state', "This quest is not complete.", {
        hint: `Progression : ${quest.progress}/${quest.required}.`,
      });
    }

    const claimed = await progressionRepo.markQuestClaimed(questId, new Date(), tx);
    if (!claimed) throw gameError('busy', 'Reward already being processed.');

    const snapshot = quest.snapshot as QuestSnapshotShape;
    if (snapshot.rewardCoins > 0) {
      await economyService.pay(
        {
          userId: player.id,
          amount: snapshot.rewardCoins,
          type: 'quest_reward',
          referenceType: 'quest',
          referenceId: quest.questKey,
        },
        tx,
      );
    }
    if (snapshot.rewardGems > 0) {
      await economyService.pay(
        {
          userId: player.id,
          amount: snapshot.rewardGems,
          currency: 'gems',
          type: 'quest_reward',
          referenceType: 'quest',
          referenceId: quest.questKey,
        },
        tx,
      );
    }
    if (snapshot.rewardItems?.length) {
      await inventoryService.addItems(player.id, snapshot.rewardItems, tx, { allowOverflow: true });
    }

    const xpResult =
      snapshot.rewardXp > 0 ? await grantXp(player.id, snapshot.rewardXp, tx) : null;
    const pass = snapshot.rewardPassXp > 0
      ? await (await import('./tracker.service')).grantPassXp(player.id, snapshot.rewardPassXp, tx)
      : undefined;

    // Une quête narrative terminée débloque immédiatement la suivante.
    if (quest.type === 'story') {
      await ensureQuests({ id: player.id, level: xpResult?.level ?? player.level });
    }

    return {
      title: snapshot.title,
      coins: snapshot.rewardCoins,
      gems: snapshot.rewardGems,
      xp: snapshot.rewardXp,
      items: snapshot.rewardItems ?? [],
      levelUp:
        xpResult && xpResult.levelsGained > 0
          ? { level: xpResult.level, levelsGained: xpResult.levelsGained }
          : null,
      passTier: pass?.tier,
    };
  });
}

/** Perçoit toutes les récompenses disponibles d'un coup. */
export async function claimAllQuests(player: PlayerContext): Promise<ClaimResult[]> {
  const quests = await progressionRepo.listUserQuests(player.id);
  const claimable = quests.filter((quest) => quest.status === 'completed');
  const results: ClaimResult[] = [];
  for (const quest of claimable) {
    try {
      results.push(await claimQuest(player, quest.id));
    } catch (error) {
      log.debug({ err: error, questId: quest.id }, 'claim skipped');
    }
  }
  if (results.length === 0) {
    throw gameError('invalid_state', 'No reward to claim.');
  }
  return results;
}

/**
 * Relance une quête journalière contre des pièces (coût croissant) ou un jeton.
 * Le coût croît géométriquement pour empêcher un joueur riche de « chercher » la
 * quête la plus rentable indéfiniment.
 */
export async function rerollQuest(
  player: PlayerContext,
  questId: string,
  timezone = 'Europe/Paris',
): Promise<{ cost: number; usedToken: boolean; newQuest: QuestView }> {
  const balance = getBalance();
  const now = new Date();
  const dailyKey = dailyCycleKey(now, timezone);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const quest = await progressionRepo.lockQuest(tx, questId, player.id);
    if (!quest) throw gameError('not_found', 'Quest not found.');
    if (quest.type !== 'daily') {
      throw gameError('forbidden', 'Only daily quests can be rerolled.');
    }
    if (quest.status !== 'active') {
      throw gameError('invalid_state', 'This quest can no longer be rerolled.');
    }

    const rerolls = await progressionRepo.countRerollsToday(player.id, dailyKey, tx);
    if (rerolls >= balance.quests.maxRerollsPerDay) {
      throw gameError(
        'forbidden',
        `Limite de ${balance.quests.maxRerollsPerDay} relances par jour atteinte.`,
      );
    }

    const usedToken = await inventoryService.has(player.id, 'quest_reroll_token', 1, tx);
    const cost = usedToken
      ? 0
      : Math.round(balance.quests.rerollCostCoins * balance.quests.rerollCostGrowth ** rerolls);

    if (usedToken) {
      await inventoryService.consume(player.id, 'quest_reroll_token', 1, tx);
    } else {
      await economyService.charge({ userId: player.id, amount: cost, type: 'reroll_cost' }, tx);
    }

    const pool = await progressionRepo.listQuestPool('daily', player.level, tx);
    const existing = await progressionRepo.listUserQuests(player.id, { type: 'daily', cycleKey: dailyKey }, tx);
    const excluded = new Set(existing.map((row) => row.questKey));
    const candidates = pool.filter((entry) => !excluded.has(entry.key));
    const rng = liveRng(`reroll:${questId}`);
    const chosen = rng.weighted(candidates.map((entry) => ({ value: entry, weight: entry.weight })));

    if (!chosen) throw gameError('not_found', 'No other quest available at your level.');

    const replacement = await progressionRepo.replaceQuest(
      questId,
      {
        userId: player.id,
        questKey: chosen.key,
        type: 'daily',
        progress: 0,
        required: scaleAmount(chosen.requiredAmount, player.level),
        cycleKey: dailyKey,
        slotIndex: quest.slotIndex,
        snapshot: buildSnapshot(toQuestConfig(chosen), player.level),
        expiresAt: nextMidnight(now, timezone),
      },
      tx,
    );

    if (!replacement) throw gameError('busy', 'Reroll failed, try again.');
    const snapshot = replacement.snapshot as QuestSnapshotShape;

    return {
      cost,
      usedToken,
      newQuest: {
        id: replacement.id,
        key: replacement.questKey,
        type: 'daily',
        title: snapshot.title,
        description: snapshot.description,
        progress: 0,
        required: replacement.required,
        status: 'active',
        rewards: {
          coins: snapshot.rewardCoins,
          gems: snapshot.rewardGems,
          xp: snapshot.rewardXp,
          items: snapshot.rewardItems ?? [],
        },
        expiresAt: replacement.expiresAt,
        rerolled: true,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// RÉCOMPENSE QUOTIDIENNE
// ---------------------------------------------------------------------------

export interface DailyResult {
  coins: number;
  gems: number;
  xp: number;
  items: Array<{ itemKey: string; quantity: number }>;
  streak: number;
  longestStreak: number;
  streakBroken: boolean;
  usedFreeze: boolean;
  nextClaimAt: Date;
}

/**
 * Récompense quotidienne avec série.
 *
 * La série est la mécanique de rétention la plus efficace du genre : la
 * récompense croît de 60 pièces par jour consécutif (plafonnée à +2 400), ce qui
 * rend une absence coûteuse SANS être punitif — la série ne casse qu'après 30 h
 * (`streakGraceHours`), donc jouer « à peu près chaque jour » suffit. Un jeton de
 * gel peut absorber une journée manquée.
 */
export async function claimDaily(
  player: PlayerContext,
  timezone = 'Europe/Paris',
  now: Date = new Date(),
): Promise<DailyResult> {
  const balance = getBalance();
  const world = await getWorldState(now);
  const today = dailyCycleKey(now, timezone);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const streakRow = await progressionRepo.lockStreak(tx, player.id);
    if (!streakRow) throw gameError('not_registered', 'Compte introuvable.');

    if (streakRow.lastClaimDate === today) {
      throw gameError('cooldown', 'You already claimed your reward today.', {
        hint: `Revenez ${nextMidnight(now, timezone).toLocaleString('fr-FR')}.`,
      });
    }

    // Calcul de la continuité de série.
    const yesterday = dailyCycleKey(new Date(now.getTime() - 86_400_000), timezone);
    let streak = streakRow.currentStreak;
    let streakBroken = false;
    let usedFreeze = false;
    let freezeTokens = streakRow.freezeTokens;

    if (!streakRow.lastClaimDate) {
      streak = 1;
    } else if (streakRow.lastClaimDate === yesterday) {
      streak += 1;
    } else if (freezeTokens > 0) {
      freezeTokens -= 1;
      usedFreeze = true;
      streak += 1;
    } else {
      streak = 1;
      streakBroken = true;
    }

    const eventMultiplier = world.eventModifiers.dailyRewardMultiplier;
    const coins = Math.round(
      (balance.daily.baseCoins +
        Math.min(
          balance.daily.maxStreakBonusCoins,
          balance.daily.coinsPerStreakDay * (streak - 1),
        )) *
        eventMultiplier,
    );
    const xp = balance.daily.baseXp + balance.daily.xpPerStreakDay * (streak - 1);
    const gems = streak % balance.daily.gemsEveryNDays === 0 ? balance.daily.gemsAmount : 0;

    // Objet bonus aléatoire : petite surprise qui rend la commande attrayante
    // même quand le montant en pièces devient marginal en fin de partie.
    const items: Array<{ itemKey: string; quantity: number }> = [];
    const rng = dailyRng(`daily:${player.id}`, today);
    if (rng.chance(balance.daily.itemRewardChance)) {
      const pool = ['fertilizer_basic', 'luck_ticket', 'xp_booster', 'pest_bait', 'energy_drink'];
      const picked = rng.pick(pool);
      if (picked) items.push({ itemKey: picked, quantity: 1 });
    }

    await progressionRepo.updateStreak(
      player.id,
      { currentStreak: streak, lastClaimDate: today, freezeTokens },
      tx,
    );

    await economyService.pay(
      { userId: player.id, amount: coins, type: 'daily_reward', metadata: { streak } },
      tx,
    );
    if (gems > 0) {
      await economyService.pay(
        { userId: player.id, amount: gems, currency: 'gems', type: 'daily_reward' },
        tx,
      );
    }
    if (items.length > 0) {
      await inventoryService.addItems(player.id, items, tx, { allowOverflow: true });
    }
    await grantXp(player.id, xp, tx);

    await progressionRepo.progressQuests(player.id, 'login_streak', 1, {}, tx);
    await progressionRepo.setAchievementProgress(player.id, 'login_streak', streak, tx);

    return {
      coins,
      gems,
      xp,
      items,
      streak,
      longestStreak: Math.max(streakRow.longestStreak, streak),
      streakBroken,
      usedFreeze,
      nextClaimAt: nextMidnight(now, timezone),
    };
  });
}

// ---------------------------------------------------------------------------
// SUCCÈS
// ---------------------------------------------------------------------------

export async function listAchievements(userId: string, category?: string) {
  return progressionRepo.listAchievements(userId, category);
}

export async function claimAchievement(
  player: PlayerContext,
  achievementKey: string,
): Promise<{ name: string; coins: number; gems: number; title: string | null; items: Array<{ itemKey: string; quantity: number }> }> {
  const config = getConfig();
  const achievement = config.achievements.get(achievementKey);
  if (!achievement) throw gameError('not_found', 'Unknown achievement.');

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const claimed = await progressionRepo.claimAchievement(player.id, achievementKey, tx);
    if (!claimed) {
      throw gameError('invalid_state', 'This achievement is not unlocked, or was already claimed.');
    }

    if (achievement.rewardCoins > 0) {
      await economyService.pay(
        {
          userId: player.id,
          amount: achievement.rewardCoins,
          type: 'achievement_reward',
          referenceType: 'achievement',
          referenceId: achievementKey,
        },
        tx,
      );
    }
    if (achievement.rewardGems > 0) {
      await economyService.pay(
        {
          userId: player.id,
          amount: achievement.rewardGems,
          currency: 'gems',
          type: 'achievement_reward',
        },
        tx,
      );
    }
    if (achievement.rewardItems.length > 0) {
      await inventoryService.addItems(player.id, achievement.rewardItems, tx, {
        allowOverflow: true,
      });
    }
    if (achievement.rewardXp > 0) {
      await grantXp(player.id, achievement.rewardXp, tx);
    }
    if (achievement.rewardTitle) {
      await tx
        .update((await import('../db/schema')).users)
        .set({ title: achievement.rewardTitle })
        .where((await import('drizzle-orm')).eq((await import('../db/schema')).users.id, player.id));
    }

    return {
      name: achievement.name,
      coins: achievement.rewardCoins,
      gems: achievement.rewardGems,
      title: achievement.rewardTitle ?? null,
      items: achievement.rewardItems,
    };
  });
}

// ---------------------------------------------------------------------------
// PASSE SAISONNIER
// ---------------------------------------------------------------------------

export interface SeasonPassView {
  id: string;
  name: string;
  endsAt: Date;
  tier: number;
  maxTier: number;
  passXp: number;
  xpPerTier: number;
  premium: boolean;
  claimedTiers: number[];
  claimedPremiumTiers: number[];
  tiers: Array<{ tier: number; free: unknown; premium: unknown }>;
}

export async function getSeasonPass(userId: string): Promise<SeasonPassView | null> {
  const pass = getActiveSeasonPass();
  if (!pass) return null;
  const progress = await progressionRepo.getUserPass(userId, pass.id);

  return {
    id: pass.id,
    name: pass.name,
    endsAt: new Date(pass.endsAt),
    tier: progress?.tier ?? 0,
    maxTier: pass.maxTier,
    passXp: progress?.passXp ?? 0,
    xpPerTier: pass.xpPerTier,
    premium: progress?.premium ?? false,
    claimedTiers: progress?.claimedTiers ?? [],
    claimedPremiumTiers: progress?.claimedPremiumTiers ?? [],
    tiers: pass.tiers,
  };
}

export async function claimPassTier(
  player: PlayerContext,
  tier: number,
  premium: boolean,
): Promise<{ coins: number; gems: number; items: Array<{ itemKey: string; quantity: number }>; title?: string }> {
  const pass = getActiveSeasonPass();
  if (!pass) throw gameError('not_found', 'Aucun passe saisonnier actif.');
  const tierConfig = pass.tiers.find((entry) => entry.tier === tier);
  if (!tierConfig) throw gameError('not_found', `Palier ${tier} inexistant.`);
  const rewards = premium ? tierConfig.premium : tierConfig.free;

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    const claimed = await progressionRepo.claimPassTier(player.id, pass.id, tier, premium, tx);
    if (!claimed) {
      throw gameError(
        'invalid_state',
        premium
          ? 'Premium tier not unlocked (vote for the bot), or already claimed.'
          : 'Tier not reached, or already claimed.',
      );
    }

    if (rewards.coins) {
      await economyService.pay(
        { userId: player.id, amount: rewards.coins, type: 'season_pass_reward' },
        tx,
      );
    }
    if (rewards.gems) {
      await economyService.pay(
        { userId: player.id, amount: rewards.gems, currency: 'gems', type: 'season_pass_reward' },
        tx,
      );
    }
    if (rewards.items?.length) {
      await inventoryService.addItems(player.id, rewards.items, tx, { allowOverflow: true });
    }
    if (rewards.xp) {
      await grantXp(player.id, rewards.xp, tx);
    }

    return {
      coins: rewards.coins ?? 0,
      gems: rewards.gems ?? 0,
      items: rewards.items ?? [],
      ...(rewards.title ? { title: rewards.title } : {}),
    };
  });
}

/** Progression des livraisons (`deliver_items`) : consomme les objets demandés. */
export async function deliverItems(
  player: PlayerContext,
  input: { questId: string; itemKey: string; quantity: number },
): Promise<{ delivered: number; progress: number; required: number; completed: boolean }> {
  return withTransaction(async (tx) => {
    const quest = await progressionRepo.lockQuest(tx, input.questId, player.id);
    if (!quest) throw gameError('not_found', 'Contrat introuvable.');
    if (quest.status !== 'active') throw gameError('invalid_state', 'Ce contrat est clos.');

    const snapshot = quest.snapshot as QuestSnapshotShape;
    if (snapshot.objectiveTarget.itemKey !== input.itemKey) {
      throw gameError('target_invalid', 'Cet objet ne correspond pas au contrat.');
    }

    const missing = quest.required - quest.progress;
    const delivered = Math.min(missing, Math.max(1, input.quantity));
    await inventoryService.consume(player.id, input.itemKey, delivered, tx);

    const completed = await progressionRepo.progressQuests(
      player.id,
      'deliver_items',
      delivered,
      { itemKey: input.itemKey },
      tx,
    );

    return {
      delivered,
      progress: quest.progress + delivered,
      required: quest.required,
      completed: completed.length > 0,
    };
  });
}

/** Prochaine réinitialisation des quêtes, pour l'affichage. */
export function questResetTimes(timezone = 'Europe/Paris', now: Date = new Date()) {
  return {
    daily: nextMidnight(now, timezone),
    weekly: nextMondayMidnight(now, timezone),
    weekStart: currentWeekStart(now, timezone),
  };
}

/** Réinitialisations hebdomadaires (job du lundi). */
export async function weeklyReset(): Promise<{ xpReset: number }> {
  const xpReset = await playerRepo.resetWeeklyXp();
  log.info({ xpReset }, 'weekly XP reset');
  return { xpReset };
}

export async function expireQuests(now: Date = new Date(), executor?: Executor): Promise<number> {
  return progressionRepo.expireQuests(now, executor);
}
