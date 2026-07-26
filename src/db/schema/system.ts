import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './core';
import {
  notificationChannelEnum,
  notificationTypeEnum,
  seasonEnum,
  taskStatusEnum,
  weatherEnum,
} from './enums';

/**
 * Météo du jour, tirée une fois par jour par le scheduler et partagée par tous
 * les joueurs (le monde est commun : c'est ce qui rend `/weather` social et les
 * événements « sécheresse » collectifs). Une ligne par jour, jamais recalculée :
 * la météo passée est ainsi auditable et rejouable.
 */
export const weather = pgTable(
  'weather',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    day: date('day').notNull(),
    weather: weatherEnum('weather').notNull(),
    season: seasonEnum('season').notNull(),
    temperature: smallint('temperature').notNull().default(18),
    /** Multiplicateur de rendement (1.10 = +10 %). */
    yieldModifier: numeric('yield_modifier', { precision: 5, scale: 3 }).notNull().default('1.000'),
    /** Multiplicateur de vitesse de pousse (>1 = plus rapide). */
    growthModifier: numeric('growth_modifier', { precision: 5, scale: 3 })
      .notNull()
      .default('1.000'),
    /** La pluie arrose gratuitement toutes les parcelles. */
    freeWatering: boolean('free_watering').notNull().default(false),
    /** Probabilité de dégâts sur une parcelle non protégée (orage, gel). */
    damageChance: numeric('damage_chance', { precision: 5, scale: 4 }).notNull().default('0.0000'),
    /** Probabilité d'apparition de nuisibles. */
    pestChance: numeric('pest_chance', { precision: 5, scale: 4 }).notNull().default('0.0500'),
    description: text('description').notNull(),
    emoji: varchar('emoji', { length: 16 }).notNull().default('☀️'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('weather_day_uq').on(t.day),
    index('weather_season_idx').on(t.season),
    check('weather_modifiers_positive', sql`${t.yieldModifier} > 0 AND ${t.growthModifier} > 0`),
  ],
);

/**
 * Calendrier des saisons. Une saison dure `SEASON_LENGTH_DAYS` jours réels
 * (14 par défaut) ; les lignes sont pré-générées par le scheduler sur un an,
 * ce qui permet à `/season` d'annoncer la suivante et aux tests de figer le temps.
 */
export const seasons = pgTable(
  'seasons',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: varchar('key', { length: 32 }).notNull(),
    season: seasonEnum('season').notNull(),
    /** Index de la saison dans l'année de jeu (0-3). */
    seasonIndex: smallint('season_index').notNull(),
    gameYear: integer('game_year').notNull().default(1),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('seasons_key_uq').on(t.key),
    index('seasons_window_idx').on(t.startsAt, t.endsAt),
    index('seasons_active_idx').on(t.active),
    check('seasons_window_valid', sql`${t.endsAt} > ${t.startsAt}`),
    check('seasons_index_range', sql`${t.seasonIndex} BETWEEN 0 AND 3`),
  ],
);

/**
 * File de notifications DM. Écrite par les jobs et les services, consommée par
 * le worker `notifications` qui respecte les rate limits Discord (5 DM/s) et
 * désactive automatiquement l'option d'un joueur qui a fermé ses MP (erreur 50007).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    channel: notificationChannelEnum('channel').notNull().default('dm'),
    title: varchar('title', { length: 128 }),
    body: text('body'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    deliverAt: timestamp('deliver_at', { withTimezone: true }).notNull().defaultNow(),
    delivered: boolean('delivered').notNull().default(false),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Clé d'idempotence : évite deux DM « culture prête » pour la même parcelle. */
    dedupeKey: varchar('dedupe_key', { length: 96 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_pending_idx').on(t.delivered, t.deliverAt),
    index('notifications_user_idx').on(t.userId, t.createdAt.desc()),
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey),
    check('notifications_attempts_range', sql`${t.attempts} BETWEEN 0 AND 10`),
  ],
);

/**
 * Tâches planifiées durables. BullMQ (Redis) porte l'exécution ; cette table est
 * le registre persistant : si Redis est purgé, `bootstrapScheduler()` reconstruit
 * les jobs depuis ici. `lockedBy` + `lockedAt` implémentent un verrou coopératif
 * pour qu'un seul shard traite une tâche donnée.
 */
export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    taskKey: varchar('task_key', { length: 96 }).notNull(),
    kind: varchar('kind', { length: 48 }).notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    /** Cron pour les tâches récurrentes ; NULL pour un one-shot. */
    cron: varchar('cron', { length: 64 }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: taskStatusEnum('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    lockedBy: varchar('locked_by', { length: 64 }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scheduled_tasks_key_uq').on(t.taskKey),
    index('scheduled_tasks_due_idx').on(t.status, t.runAt),
    index('scheduled_tasks_kind_idx').on(t.kind),
  ],
);

/**
 * Journal d'audit immuable de toutes les actions sensibles (commandes admin,
 * détections anti-triche, opérations économiques hors norme). Aucun UPDATE ni
 * DELETE n'est possible : un trigger `audit_logs_immutable` les rejette, y
 * compris pour le propriétaire de la base.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Auteur de l'action (NULL = système). */
    actorId: uuid('actor_id'),
    actorDiscordId: varchar('actor_discord_id', { length: 20 }),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: varchar('target_id', { length: 64 }),
    targetDiscordId: varchar('target_discord_id', { length: 20 }),
    discordGuildId: varchar('discord_guild_id', { length: 20 }),
    reason: text('reason'),
    /** Différentiel avant/après, sérialisé. */
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    severity: varchar('severity', { length: 16 }).notNull().default('info'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt.desc()),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
    index('audit_logs_target_discord_idx').on(t.targetDiscordId, t.createdAt.desc()),
    index('audit_logs_action_idx').on(t.action, t.createdAt.desc()),
    index('audit_logs_severity_idx').on(t.severity, t.createdAt.desc()),
  ],
);

/**
 * Configuration par SERVEUR DISCORD (à ne pas confondre avec `guilds` =
 * coopératives). La ferme d'un joueur est globale (voir docs/01) : ce qui est
 * propre au serveur, c'est l'intégration — salons autorisés, langue par défaut,
 * commandes désactivées, rôles admin, classement local.
 */
export const guildSettings = pgTable(
  'guild_settings',
  {
    id: uuid('id').primaryKey(),
    discordGuildId: varchar('discord_guild_id', { length: 20 }).notNull(),
    name: varchar('name', { length: 100 }),
    locale: varchar('locale', { length: 5 }).notNull().default('fr'),
    announcementChannelId: varchar('announcement_channel_id', { length: 20 }),
    marketChannelId: varchar('market_channel_id', { length: 20 }),
    eventChannelId: varchar('event_channel_id', { length: 20 }),
    /** Si non vide, les commandes de jeu ne répondent que dans ces salons. */
    allowedChannelIds: text('allowed_channel_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    disabledCommands: text('disabled_commands').array().notNull().default(sql`ARRAY[]::text[]`),
    adminRoleIds: text('admin_role_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Bonus d'XP local (boost de serveur, partenariat). Plafonné à 2.0. */
    xpMultiplier: numeric('xp_multiplier', { precision: 4, scale: 2 }).notNull().default('1.00'),
    leaderboardEnabled: boolean('leaderboard_enabled').notNull().default(true),
    premiumUntil: timestamp('premium_until', { withTimezone: true }),
    memberCount: integer('member_count'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('guild_settings_discord_id_uq').on(t.discordGuildId),
    index('guild_settings_left_idx').on(t.leftAt),
    check('guild_settings_xp_multiplier_range', sql`${t.xpMultiplier} BETWEEN 0.1 AND 2.0`),
  ],
);

/**
 * Registre des migrations appliquées, écrit par notre runner
 * (`src/scripts/migrate.ts`). On garde notre propre table plutôt que la table
 * interne de drizzle-kit pour y stocker le hash du fichier : si un fichier de
 * migration déjà appliqué est modifié, le runner refuse de démarrer au lieu de
 * laisser deux environnements divergents.
 */
export const migrations = pgTable(
  'migrations',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    hash: varchar('hash', { length: 64 }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    executionMs: integer('execution_ms').notNull().default(0),
    appliedBy: varchar('applied_by', { length: 64 }),
  },
  (t) => [uniqueIndex('migrations_name_uq').on(t.name)],
);
