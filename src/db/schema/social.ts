import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './core';
import { coopObjectiveStatusEnum, coopRoleEnum, treasuryOpEnum } from './enums';

/**
 * ---------------------------------------------------------------------------
 * COOPÉRATIVES
 * ---------------------------------------------------------------------------
 * ATTENTION AU VOCABULAIRE : dans ce schéma, la table `guilds` désigne les
 * COOPÉRATIVES du jeu (groupes de joueurs), pas les serveurs Discord. La
 * configuration par serveur Discord vit dans `guild_settings` (system.ts).
 * Les exports TypeScript sont nommés `coops`, `coopMembers`, … pour éviter
 * toute confusion dans le code applicatif, tandis que les noms de tables
 * SQL restent ceux du cahier des charges.
 */
export const coops = pgTable(
  'guilds',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 32 }).notNull(),
    /** Étiquette courte affichée devant le pseudo : `[BLÉ]`. */
    tag: varchar('tag', { length: 5 }).notNull(),
    description: text('description'),
    emblem: varchar('emblem', { length: 32 }).notNull().default('🌾'),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    level: integer('level').notNull().default(1),
    xp: bigint('xp', { mode: 'number' }).notNull().default(0),
    /** Trésorerie commune, alimentée par les contributions. */
    treasury: bigint('treasury', { mode: 'number' }).notNull().default(0),
    memberLimit: integer('member_limit').notNull().default(10),
    isPublic: boolean('is_public').notNull().default(true),
    joinRequirementLevel: integer('join_requirement_level').notNull().default(1),
    /** Bonus collectifs actifs : `{"growthSpeed":0.05,"sellBonus":0.03}`. */
    bonuses: jsonb('bonuses').notNull().default(sql`'{}'::jsonb`),
    weeklyScore: bigint('weekly_score', { mode: 'number' }).notNull().default(0),
    totalScore: bigint('total_score', { mode: 'number' }).notNull().default(0),
    memberCount: integer('member_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('guilds_name_uq').on(sql`lower(${t.name})`),
    uniqueIndex('guilds_tag_uq').on(sql`upper(${t.tag})`),
    index('guilds_weekly_score_idx').on(t.weeklyScore.desc()),
    index('guilds_level_idx').on(t.level.desc(), t.xp.desc()),
    index('guilds_public_idx').on(t.isPublic, t.memberCount),
    check('guilds_treasury_non_negative', sql`${t.treasury} >= 0`),
    check('guilds_level_range', sql`${t.level} BETWEEN 1 AND 30`),
    check('guilds_member_limit_range', sql`${t.memberLimit} BETWEEN 1 AND 50`),
    check('guilds_member_count_range', sql`${t.memberCount} >= 0 AND ${t.memberCount} <= ${t.memberLimit}`),
  ],
);

export const coopMembers = pgTable(
  'guild_members',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => coops.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: coopRoleEnum('role').notNull().default('member'),
    contributedCoins: bigint('contributed_coins', { mode: 'number' }).notNull().default(0),
    contributedItems: integer('contributed_items').notNull().default(0),
    weeklyContribution: bigint('weekly_contribution', { mode: 'number' }).notNull().default(0),
    weeklyScore: bigint('weekly_score', { mode: 'number' }).notNull().default(0),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastContributionAt: timestamp('last_contribution_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Source de vérité unique de l'appartenance : un joueur ne peut être que
    // dans une seule coopérative (contrainte d'unicité sur user_id seul).
    uniqueIndex('guild_members_user_uq').on(t.userId),
    index('guild_members_guild_idx').on(t.guildId, t.role),
    index('guild_members_weekly_idx').on(t.guildId, t.weeklyContribution.desc()),
    check(
      'guild_members_contributions_non_negative',
      sql`${t.contributedCoins} >= 0 AND ${t.contributedItems} >= 0 AND ${t.weeklyContribution} >= 0`,
    ),
  ],
);

export const coopObjectives = pgTable(
  'guild_objectives',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => coops.id, { onDelete: 'cascade' }),
    objectiveKey: varchar('objective_key', { length: 64 }).notNull(),
    title: varchar('title', { length: 128 }).notNull(),
    description: text('description').notNull(),
    target: bigint('target', { mode: 'number' }).notNull(),
    progress: bigint('progress', { mode: 'number' }).notNull().default(0),
    /** Lundi de la semaine ISO concernée. */
    weekStart: date('week_start').notNull(),
    status: coopObjectiveStatusEnum('status').notNull().default('active'),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardGems: bigint('reward_gems', { mode: 'number' }).notNull().default(0),
    rewardCoopXp: integer('reward_coop_xp').notNull().default(0),
    /** Récompenses déjà distribuées aux membres ? (idempotence du job) */
    distributed: boolean('distributed').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('guild_objectives_uq').on(t.guildId, t.objectiveKey, t.weekStart),
    index('guild_objectives_guild_status_idx').on(t.guildId, t.status),
    index('guild_objectives_week_idx').on(t.weekStart, t.status),
    check('guild_objectives_target_positive', sql`${t.target} > 0`),
    check('guild_objectives_progress_non_negative', sql`${t.progress} >= 0`),
  ],
);

export const coopTreasuryLog = pgTable(
  'guild_treasury_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => coops.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    operation: treasuryOpEnum('operation').notNull(),
    /** Signé : négatif pour un retrait ou une amélioration. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('guild_treasury_log_guild_idx').on(t.guildId, t.createdAt.desc()),
    index('guild_treasury_log_user_idx').on(t.userId),
    check('guild_treasury_log_amount_non_zero', sql`${t.amount} <> 0`),
    check('guild_treasury_log_balance_non_negative', sql`${t.balanceAfter} >= 0`),
  ],
);

/** Visites de ferme et coups de main entre joueurs (`/visiter`, `/aider`). */
export const farmVisits = pgTable(
  'farm_visits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    visitorId: uuid('visitor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hostId: uuid('host_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    helped: boolean('helped').notNull().default(false),
    /** Nombre de parcelles arrosées pour l'hôte. */
    plotsWatered: smallint('plots_watered').notNull().default(0),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardXp: integer('reward_xp').notNull().default(0),
    visitDate: date('visit_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un seul coup de main récompensé par jour et par couple de joueurs :
    // ferme la porte au farming d'XP entre deux comptes complices.
    uniqueIndex('farm_visits_daily_uq').on(t.visitorId, t.hostId, t.visitDate),
    index('farm_visits_host_idx').on(t.hostId, t.visitDate),
    check('farm_visits_no_self', sql`${t.visitorId} <> ${t.hostId}`),
  ],
);
