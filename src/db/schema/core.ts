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
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { pestTypeEnum, plotStateEnum, privacyEnum, referralStatusEnum, voteSiteEnum } from './enums';

/**
 * ---------------------------------------------------------------------------
 * CHOIX DES CLÉS PRIMAIRES
 * ---------------------------------------------------------------------------
 * - Entités de jeu (`users`, `farms`, `plots`, `owned_animals`…) : `UUID` v7
 *   généré côté application (`src/utils/uuid.ts`).
 *   • Pas d'énumération possible depuis un custom_id Discord exposé au client.
 *   • Génération sans aller-retour SQL : on peut construire un graphe d'objets
 *     complet (ferme + 9 parcelles + inventaire de départ) puis l'insérer en
 *     une seule transaction, sans RETURNING en cascade.
 *   • UUID v7 est préfixé par le timestamp : contrairement à v4 il conserve la
 *     localité d'insertion dans l'index B-tree (pas de fragmentation).
 *   • Shardable : deux process peuvent générer des IDs sans coordination.
 * - Tables append-only à fort volume (`transactions`, `audit_logs`,
 *   `market_price_history`, `notifications`…) : `BIGSERIAL`.
 *   • 8 octets contre 16, index deux fois plus petit, insertion strictement
 *     séquentielle, et l'ordre des IDs est l'ordre chronologique — pratique
 *     pour paginer un journal (`WHERE id < $cursor`).
 *   • Ces lignes ne sont jamais adressées depuis un custom_id public.
 * - Tables de configuration : clé métier `text` (voir config.ts).
 *
 * MONNAIE : toutes les colonnes monétaires sont `BIGINT` (jamais float/numeric).
 * Côté TypeScript on les manipule en `number` entier (mode: 'number'), borné à
 * 2^53-1 par le module `src/game/money.ts` qui refuse tout non-entier — un test
 * unitaire garantit l'invariant.
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** Snowflake Discord (18-20 chiffres). Identité globale du joueur. */
    discordId: varchar('discord_id', { length: 20 }).notNull(),
    username: varchar('username', { length: 32 }).notNull(),
    displayName: varchar('display_name', { length: 64 }),
    avatarHash: varchar('avatar_hash', { length: 64 }),

    // --- Économie ---------------------------------------------------------
    coins: bigint('coins', { mode: 'number' }).notNull().default(500),
    gems: bigint('gems', { mode: 'number' }).notNull().default(0),

    // --- Progression ------------------------------------------------------
    level: integer('level').notNull().default(1),
    /** XP dans le niveau courant. */
    xp: bigint('xp', { mode: 'number' }).notNull().default(0),
    /** XP cumulée depuis toujours (survit au prestige, sert au classement). */
    totalXp: bigint('total_xp', { mode: 'number' }).notNull().default(0),
    weeklyXp: bigint('weekly_xp', { mode: 'number' }).notNull().default(0),
    prestige: integer('prestige').notNull().default(0),
    prestigePoints: bigint('prestige_points', { mode: 'number' }).notNull().default(0),

    // --- Énergie (régénération calculée à la lecture) ---------------------
    energy: integer('energy').notNull().default(100),
    energyMax: integer('energy_max').notNull().default(100),
    energyUpdatedAt: timestamp('energy_updated_at', { withTimezone: true }).notNull().defaultNow(),

    // --- Cosmétique -------------------------------------------------------
    title: varchar('title', { length: 64 }),
    badges: text('badges').array().notNull().default(sql`ARRAY[]::text[]`),
    profileTheme: varchar('profile_theme', { length: 32 }).notNull().default('classic'),
    profileColor: varchar('profile_color', { length: 7 }).notNull().default('#4ca64c'),

    // --- Statistiques détaillées -----------------------------------------
    totalHarvests: bigint('total_harvests', { mode: 'number' }).notNull().default(0),
    totalPlanted: bigint('total_planted', { mode: 'number' }).notNull().default(0),
    totalCoinsEarned: bigint('total_coins_earned', { mode: 'number' }).notNull().default(0),
    totalCoinsSpent: bigint('total_coins_spent', { mode: 'number' }).notNull().default(0),
    totalAnimalsRaised: bigint('total_animals_raised', { mode: 'number' }).notNull().default(0),
    totalCrafts: bigint('total_crafts', { mode: 'number' }).notNull().default(0),
    totalWatered: bigint('total_watered', { mode: 'number' }).notNull().default(0),
    totalHelpGiven: bigint('total_help_given', { mode: 'number' }).notNull().default(0),
    bestHarvestValue: bigint('best_harvest_value', { mode: 'number' }).notNull().default(0),
    commandsUsed: bigint('commands_used', { mode: 'number' }).notNull().default(0),
    playtimeSeconds: bigint('playtime_seconds', { mode: 'number' }).notNull().default(0),

    // --- Social / modération ---------------------------------------------
    referralCode: varchar('referral_code', { length: 12 }).notNull(),
    referredBy: uuid('referred_by'),
    ecoBannedUntil: timestamp('eco_banned_until', { withTimezone: true }),
    ecoBanReason: text('eco_ban_reason'),
    isAdmin: boolean('is_admin').notNull().default(false),
    /** Score d'anomalie économique alimenté par l'anti-triche. */
    suspicionScore: integer('suspicion_score').notNull().default(0),

    locale: varchar('locale', { length: 5 }).notNull().default('fr'),
    /** Dernier serveur Discord d'où le joueur a joué (classements par serveur). */
    lastGuildId: varchar('last_guild_id', { length: 20 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete : RGPD « droit à l'oubli » sans casser les journaux liés. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Unicité limitée aux comptes vivants : `/admin reset` fait une suppression
    // logique, et un unique total empêchait la victime de refaire `/start`.
    uniqueIndex('users_discord_id_uq').on(t.discordId).where(sql`deleted_at IS NULL`),
    uniqueIndex('users_referral_code_uq').on(t.referralCode),
    index('users_coins_idx').on(t.coins.desc()),
    index('users_level_idx').on(t.level.desc(), t.totalXp.desc()),
    index('users_weekly_xp_idx').on(t.weeklyXp.desc()),
    index('users_harvests_idx').on(t.totalHarvests.desc()),
    index('users_last_seen_idx').on(t.lastSeenAt.desc()),
    index('users_last_guild_idx').on(t.lastGuildId),
    index('users_referred_by_idx').on(t.referredBy),
    // Interdit tout solde négatif au niveau du moteur : même un bug applicatif
    // ou un UPDATE manuel ne peut pas créer de monnaie négative.
    check('users_coins_non_negative', sql`${t.coins} >= 0`),
    check('users_gems_non_negative', sql`${t.gems} >= 0`),
    check('users_xp_non_negative', sql`${t.xp} >= 0 AND ${t.totalXp} >= 0`),
    check('users_level_range', sql`${t.level} BETWEEN 1 AND 120`),
    check('users_energy_range', sql`${t.energy} >= 0 AND ${t.energy} <= ${t.energyMax}`),
    check('users_prestige_range', sql`${t.prestige} BETWEEN 0 AND 20`),
  ],
);

export const settings = pgTable(
  'settings',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dmNotifications: boolean('dm_notifications').notNull().default(false),
    notifyCrops: boolean('notify_crops').notNull().default(true),
    notifyAnimals: boolean('notify_animals').notNull().default(true),
    notifyEnergy: boolean('notify_energy').notNull().default(false),
    notifyMarket: boolean('notify_market').notNull().default(false),
    notifyCoop: boolean('notify_coop').notNull().default(true),
    dailyReminder: boolean('daily_reminder').notNull().default(false),
    locale: varchar('locale', { length: 5 }).notNull().default('fr'),
    timezone: varchar('timezone', { length: 48 }).notNull().default('Europe/Paris'),
    theme: varchar('theme', { length: 32 }).notNull().default('classic'),
    privacy: privacyEnum('privacy').notNull().default('public'),
    /** Embeds compacts, sans image générée (utile en connexion lente). */
    compactMode: boolean('compact_mode').notNull().default(false),
    confirmDestructive: boolean('confirm_destructive').notNull().default(true),
    allowVisits: boolean('allow_visits').notNull().default(true),
    allowTrades: boolean('allow_trades').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('settings_user_id_uq').on(t.userId)],
);

export const farms = pgTable(
  'farms',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 48 }).notNull().default('My farm'),
    /** Taille de la grille débloquée : 3x3 au départ, 8x8 au maximum. */
    gridWidth: smallint('grid_width').notNull().default(3),
    gridHeight: smallint('grid_height').notNull().default(3),
    /** Bonus de fertilité permanent (bâtiments, prestige). */
    fertilityBonus: smallint('fertility_bonus').notNull().default(0),
    /** Puits / arrosage automatique débloqué. */
    autoWater: boolean('auto_water').notNull().default(false),
    autoWaterUntil: timestamp('auto_water_until', { withTimezone: true }),
    /** Capacité de l'entrepôt (somme des quantités d'inventaire). */
    warehouseCapacity: integer('warehouse_capacity').notNull().default(300),
    /** Emplacements de production simultanés (bâtiments d'artisanat). */
    craftingSlots: smallint('crafting_slots').notNull().default(1),
    /** Serre : ignore les malus de saison. */
    greenhouse: boolean('greenhouse').notNull().default(false),
    theme: varchar('theme', { length: 32 }).notNull().default('classic'),
    bannerColor: varchar('banner_color', { length: 7 }).notNull().default('#7ec850'),
    visitsCount: integer('visits_count').notNull().default(0),
    helpsReceived: integer('helps_received').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('farms_user_id_uq').on(t.userId),
    check('farms_grid_range', sql`${t.gridWidth} BETWEEN 1 AND 8 AND ${t.gridHeight} BETWEEN 1 AND 8`),
    check('farms_capacity_positive', sql`${t.warehouseCapacity} > 0`),
    check('farms_slots_range', sql`${t.craftingSlots} BETWEEN 1 AND 12`),
    check('farms_fertility_bonus_range', sql`${t.fertilityBonus} BETWEEN 0 AND 50`),
  ],
);

export const plots = pgTable(
  'plots',
  {
    id: uuid('id').primaryKey(),
    farmId: uuid('farm_id')
      .notNull()
      .references(() => farms.id, { onDelete: 'cascade' }),
    /** Coordonnées dans la grille, 0-indexées, coin haut-gauche = (0,0). */
    x: smallint('x').notNull(),
    y: smallint('y').notNull(),
    /** Index affiché au joueur (1..64), stable et indépendant de la grille. */
    slot: smallint('slot').notNull(),
    state: plotStateEnum('state').notNull().default('locked'),
    /** Fertilité 0-100 : -fertilityCost par récolte, +engrais, +jachère. */
    fertility: smallint('fertility').notNull().default(70),
    /** Niveau de mauvaises herbes : réduit le rendement au-delà de 30. */
    weedLevel: smallint('weed_level').notNull().default(0),
    pestType: pestTypeEnum('pest_type'),
    pestAppearedAt: timestamp('pest_appeared_at', { withTimezone: true }),
    /** Délai avant que le nuisible détruise la récolte. */
    pestDeadlineAt: timestamp('pest_deadline_at', { withTimezone: true }),
    lastWateredAt: timestamp('last_watered_at', { withTimezone: true }),
    lastHarvestAt: timestamp('last_harvest_at', { withTimezone: true }),
    /**
     * Ancre du calcul des mauvaises herbes, au même titre que `lastHarvestAt`.
     * Sans elle, désherber remettait `weed_level` à zéro sans déplacer l'origine
     * du temps écoulé : la pénalité revenait intégralement à la lecture suivante.
     */
    lastWeededAt: timestamp('last_weeded_at', { withTimezone: true }),
    /** Date de mise en jachère volontaire (restaure la fertilité). */
    fallowUntil: timestamp('fallow_until', { withTimezone: true }),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
    unlockCost: bigint('unlock_cost', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plots_farm_coords_uq').on(t.farmId, t.x, t.y),
    uniqueIndex('plots_farm_slot_uq').on(t.farmId, t.slot),
    index('plots_farm_state_idx').on(t.farmId, t.state),
    index('plots_pest_deadline_idx').on(t.pestDeadlineAt),
    check('plots_fertility_range', sql`${t.fertility} BETWEEN 0 AND 100`),
    check('plots_weed_range', sql`${t.weedLevel} BETWEEN 0 AND 100`),
    check('plots_coords_range', sql`${t.x} BETWEEN 0 AND 7 AND ${t.y} BETWEEN 0 AND 7`),
    check('plots_slot_range', sql`${t.slot} BETWEEN 1 AND 64`),
    check(
      'plots_pest_consistency',
      sql`(${t.pestType} IS NULL AND ${t.pestDeadlineAt} IS NULL) OR (${t.pestType} IS NOT NULL AND ${t.pestDeadlineAt} IS NOT NULL)`,
    ),
  ],
);

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
    /** Taux journalier, ex. 0.0050 = 0,5 %/jour, plafonné par `interestCap`. */
    interestRate: numeric('interest_rate', { precision: 6, scale: 4 }).notNull().default('0.0050'),
    interestCap: bigint('interest_cap', { mode: 'number' }).notNull().default(5_000),
    lastInterestAt: timestamp('last_interest_at', { withTimezone: true }).notNull().defaultNow(),
    tier: smallint('tier').notNull().default(1),
    capacity: bigint('capacity', { mode: 'number' }).notNull().default(50_000),
    totalDeposited: bigint('total_deposited', { mode: 'number' }).notNull().default(0),
    totalWithdrawn: bigint('total_withdrawn', { mode: 'number' }).notNull().default(0),
    totalInterest: bigint('total_interest', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_accounts_user_id_uq').on(t.userId),
    check('bank_accounts_balance_non_negative', sql`${t.balance} >= 0`),
    check('bank_accounts_within_capacity', sql`${t.balance} <= ${t.capacity}`),
    check('bank_accounts_tier_range', sql`${t.tier} BETWEEN 1 AND 6`),
  ],
);

export const dailyStreaks = pgTable(
  'daily_streaks',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentStreak: integer('current_streak').notNull().default(0),
    longestStreak: integer('longest_streak').notNull().default(0),
    /** Date locale du joueur (fuseau des settings) — évite le double-claim. */
    lastClaimDate: date('last_claim_date'),
    totalClaims: integer('total_claims').notNull().default(0),
    /** Jetons « gel de série » consommés automatiquement en cas d'absence. */
    freezeTokens: smallint('freeze_tokens').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('daily_streaks_user_id_uq').on(t.userId),
    index('daily_streaks_current_idx').on(t.currentStreak.desc()),
    check(
      'daily_streaks_non_negative',
      sql`${t.currentStreak} >= 0 AND ${t.longestStreak} >= ${t.currentStreak}`,
    ),
  ],
);

export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey(),
    referrerId: uuid('referrer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referredId: uuid('referred_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 12 }).notNull(),
    status: referralStatusEnum('status').notNull().default('pending'),
    /** Le filleul doit atteindre ce niveau pour valider le parrainage. */
    qualifyLevel: integer('qualify_level').notNull().default(10),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardGems: bigint('reward_gems', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un joueur ne peut être parrainé qu'une seule fois, à vie.
    uniqueIndex('referrals_referred_uq').on(t.referredId),
    index('referrals_referrer_idx').on(t.referrerId),
    index('referrals_status_idx').on(t.status),
    check('referrals_no_self', sql`${t.referrerId} <> ${t.referredId}`),
  ],
);

export const votes = pgTable(
  'votes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    site: voteSiteEnum('site').notNull().default('topgg'),
    votedAt: timestamp('voted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Fenêtre de vote suivante (12 h sur top.gg). */
    nextVoteAt: timestamp('next_vote_at', { withTimezone: true }).notNull(),
    streak: integer('streak').notNull().default(1),
    isWeekend: boolean('is_weekend').notNull().default(false),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardGems: bigint('reward_gems', { mode: 'number' }).notNull().default(0),
    claimed: boolean('claimed').notNull().default(false),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** ID d'événement fourni par le webhook, pour l'idempotence. */
    externalId: varchar('external_id', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('votes_user_idx').on(t.userId, t.votedAt.desc()),
    index('votes_unclaimed_idx').on(t.userId, t.claimed),
    uniqueIndex('votes_external_id_uq').on(t.externalId),
  ],
);

/**
 * Cooldowns durables. Redis reste la source de vérité chaude (TTL natif, aucun
 * I/O disque) ; cette table sert de filet : au redémarrage d'un Redis non
 * persistant, les cooldowns longs (daily, vote, prestige) survivent.
 * Les cooldowns courts (< 60 s) ne sont jamais écrits ici.
 */
export const cooldowns = pgTable(
  'cooldowns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    uses: integer('uses').notNull().default(1),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cooldowns_user_key_uq').on(t.userId, t.key),
    index('cooldowns_expires_idx').on(t.expiresAt),
  ],
);
