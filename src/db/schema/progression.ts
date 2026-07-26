import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { achievementsConfig, eventsConfig, questsConfig, seasonPass } from './config';
import { users } from './core';
import {
  leaderboardPeriodEnum,
  leaderboardScopeEnum,
  leaderboardTypeEnum,
  questStatusEnum,
  questTypeEnum,
} from './enums';

/**
 * Quête assignée à un joueur.
 *
 * `snapshot` fige titre / description / récompenses au moment de l'assignation :
 * si l'équilibrage change en cours de journée (`/admin reload-config`), le
 * joueur reçoit ce qui lui a été promis, pas la nouvelle valeur.
 */
export const userQuests = pgTable(
  'user_quests',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questKey: varchar('quest_key', { length: 64 })
      .notNull()
      .references(() => questsConfig.key, { onUpdate: 'cascade' }),
    type: questTypeEnum('type').notNull(),
    progress: integer('progress').notNull().default(0),
    required: integer('required').notNull(),
    status: questStatusEnum('status').notNull().default('active'),
    /** Cycle d'assignation : `2026-07-26` (daily) ou `2026-W30` (weekly). */
    cycleKey: varchar('cycle_key', { length: 16 }).notNull(),
    slotIndex: smallint('slot_index').notNull().default(0),
    rerolled: boolean('rerolled').notNull().default(false),
    snapshot: jsonb('snapshot').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Une quête donnée n'est assignée qu'une fois par cycle et par joueur.
    uniqueIndex('user_quests_cycle_uq').on(t.userId, t.questKey, t.cycleKey),
    index('user_quests_user_status_idx').on(t.userId, t.status),
    index('user_quests_type_cycle_idx').on(t.userId, t.type, t.cycleKey),
    index('user_quests_expires_idx').on(t.status, t.expiresAt),
    check('user_quests_progress_non_negative', sql`${t.progress} >= 0`),
    check('user_quests_required_positive', sql`${t.required} > 0`),
  ],
);

export const userAchievements = pgTable(
  'user_achievements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    achievementKey: varchar('achievement_key', { length: 64 })
      .notNull()
      .references(() => achievementsConfig.key, { onUpdate: 'cascade' }),
    progress: bigint('progress', { mode: 'number' }).notNull().default(0),
    unlocked: boolean('unlocked').notNull().default(false),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
    claimed: boolean('claimed').notNull().default(false),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_achievements_uq').on(t.userId, t.achievementKey),
    index('user_achievements_user_idx').on(t.userId, t.unlocked),
    check('user_achievements_progress_non_negative', sql`${t.progress} >= 0`),
    check(
      'user_achievements_claim_requires_unlock',
      sql`NOT ${t.claimed} OR ${t.unlocked}`,
    ),
  ],
);

export const userSeasonPass = pgTable(
  'user_season_pass',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    seasonPassId: varchar('season_pass_id', { length: 48 })
      .notNull()
      .references(() => seasonPass.id, { onUpdate: 'cascade', onDelete: 'cascade' }),
    passXp: bigint('pass_xp', { mode: 'number' }).notNull().default(0),
    tier: integer('tier').notNull().default(0),
    /** Paliers déjà réclamés (gratuits). */
    claimedTiers: integer('claimed_tiers').array().notNull().default(sql`ARRAY[]::integer[]`),
    /** Paliers premium réclamés (débloqués par vote/boost, jamais par argent réel). */
    claimedPremiumTiers: integer('claimed_premium_tiers')
      .array()
      .notNull()
      .default(sql`ARRAY[]::integer[]`),
    premium: boolean('premium').notNull().default(false),
    premiumGrantedAt: timestamp('premium_granted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_season_pass_uq').on(t.userId, t.seasonPassId),
    index('user_season_pass_tier_idx').on(t.seasonPassId, t.tier.desc()),
    check('user_season_pass_non_negative', sql`${t.passXp} >= 0 AND ${t.tier} >= 0`),
  ],
);

export const userEvents = pgTable(
  'user_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventKey: varchar('event_key', { length: 64 })
      .notNull()
      .references(() => eventsConfig.key, { onUpdate: 'cascade' }),
    points: bigint('points', { mode: 'number' }).notNull().default(0),
    tier: integer('tier').notNull().default(0),
    claimedTiers: integer('claimed_tiers').array().notNull().default(sql`ARRAY[]::integer[]`),
    /** Compteurs libres propres à l'événement. */
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_events_uq').on(t.userId, t.eventKey),
    index('user_events_points_idx').on(t.eventKey, t.points.desc()),
    check('user_events_points_non_negative', sql`${t.points} >= 0`),
  ],
);

/**
 * Instantanés de classement.
 *
 * Les classements « live » sont servis par Redis (ZSET, O(log n)) ; cette table
 * conserve l'historique figé à chaque clôture (fin de semaine, fin de saison)
 * pour pouvoir afficher « votre rang la semaine dernière » et distribuer les
 * récompenses hebdomadaires de façon reproductible et auditable.
 */
export const leaderboardSnapshots = pgTable(
  'leaderboard_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardType: leaderboardTypeEnum('board_type').notNull(),
    scope: leaderboardScopeEnum('scope').notNull().default('global'),
    /** ID de serveur Discord ou de coopérative selon `scope` ; 'global' sinon. */
    scopeId: varchar('scope_id', { length: 40 }).notNull().default('global'),
    period: leaderboardPeriodEnum('period').notNull().default('alltime'),
    /** Clé de période : `2026-W30`, `spring_2026`, `alltime`. */
    periodKey: varchar('period_key', { length: 24 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    score: bigint('score', { mode: 'number' }).notNull(),
    rewardClaimed: boolean('reward_claimed').notNull().default(false),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leaderboard_snapshot_uq').on(
      t.boardType,
      t.scope,
      t.scopeId,
      t.period,
      t.periodKey,
      t.userId,
    ),
    index('leaderboard_snapshot_lookup_idx').on(
      t.boardType,
      t.scope,
      t.scopeId,
      t.periodKey,
      t.rank,
    ),
    index('leaderboard_snapshot_user_idx').on(t.userId, t.capturedAt.desc()),
    check('leaderboard_rank_positive', sql`${t.rank} > 0`),
  ],
);
