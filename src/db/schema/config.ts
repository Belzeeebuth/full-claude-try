import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  bigint,
} from 'drizzle-orm/pg-core';
import {
  buildingCategoryEnum,
  eventTypeEnum,
  itemCategoryEnum,
  questObjectiveEnum,
  questTypeEnum,
  rarityEnum,
} from './enums';

/**
 * ---------------------------------------------------------------------------
 * TABLES DE CONFIGURATION (« *_config »)
 * ---------------------------------------------------------------------------
 * Ces tables sont la projection en base des fichiers JSON de
 * `src/config/gameplay/`. Elles existent pour trois raisons :
 *  1. intégrité référentielle (une parcelle plantée référence une culture qui
 *     existe forcément) ;
 *  2. jointures et agrégats SQL (classements par rareté, valeur d'inventaire) ;
 *  3. rechargement à chaud : `/admin reload-config` relit le JSON et fait un
 *     UPSERT ligne à ligne, sans redéploiement.
 *
 * Clé primaire : clé métier `text` (« wheat », « cow », « cheese »).
 * Justification : ce sont des identifiants stables, lisibles dans les logs et
 * les custom_id Discord, et écrits à la main dans les fichiers de config.
 * Un UUID n'apporterait rien et rendrait les diffs de config illisibles.
 */

export const cropsConfig = pgTable(
  'crops_config',
  {
    key: varchar('key', { length: 48 }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    rarity: rarityEnum('rarity').notNull().default('common'),
    /** Prix d'achat d'une graine, en pièces. */
    seedPrice: bigint('seed_price', { mode: 'number' }).notNull(),
    /** Durée de pousse de référence, avant modificateurs (saison, météo, outils). */
    growthSeconds: integer('growth_seconds').notNull(),
    /** Nombre d'unités récoltées avant modificateurs. */
    baseYield: integer('base_yield').notNull(),
    /** Prix de vente unitaire de référence (le marché fluctue autour). */
    sellPrice: bigint('sell_price', { mode: 'number' }).notNull(),
    requiredLevel: integer('required_level').notNull().default(1),
    /** Saisons favorables : `['spring','summer']`. Hors saison = malus. */
    seasons: text('seasons').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Multiplicateur appliqué au tirage de qualité (plus haut = meilleures qualités). */
    qualityMultiplier: numeric('quality_multiplier', { precision: 5, scale: 2 })
      .notNull()
      .default('1.00'),
    /** Nombre d'arrosages attendus sur le cycle complet. */
    waterRequired: smallint('water_required').notNull().default(1),
    /** Points de fertilité consommés par récolte. */
    fertilityCost: smallint('fertility_cost').notNull().default(3),
    xpReward: integer('xp_reward').notNull().default(1),
    /** Cultures repousseuses : nombre de cycles supplémentaires sans replanter. */
    regrowCycles: smallint('regrow_cycles').notNull().default(0),
    regrowSeconds: integer('regrow_seconds').notNull().default(0),
    /** Probabilité de base d'une mutation (0-1), modulée par la chance du joueur. */
    mutationChance: numeric('mutation_chance', { precision: 6, scale: 5 })
      .notNull()
      .default('0.01000'),
    /** Rendu : nom de base des sprites `crop_<key>_<stage>.png`. */
    sprite: varchar('sprite', { length: 64 }),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crops_config_level_idx').on(t.requiredLevel),
    index('crops_config_rarity_idx').on(t.rarity),
    index('crops_config_enabled_idx').on(t.enabled),
    check('crops_config_growth_positive', sql`${t.growthSeconds} > 0`),
    check('crops_config_yield_positive', sql`${t.baseYield} > 0`),
    check('crops_config_seed_price_non_negative', sql`${t.seedPrice} >= 0`),
    check('crops_config_sell_price_non_negative', sql`${t.sellPrice} >= 0`),
    check('crops_config_level_range', sql`${t.requiredLevel} BETWEEN 1 AND 120`),
    // Garde-fou anti-exploit : une graine ne doit jamais coûter plus que ce
    // qu'elle rapporte, ni rapporter plus de 40x son coût (cf. tests d'équilibrage).
    check(
      'crops_config_roi_sane',
      sql`${t.sellPrice} * ${t.baseYield} > ${t.seedPrice} AND ${t.sellPrice} * ${t.baseYield} <= ${t.seedPrice} * 40 + 100`,
    ),
  ],
);

export const animalsConfig = pgTable(
  'animals_config',
  {
    key: varchar('key', { length: 48 }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    rarity: rarityEnum('rarity').notNull().default('common'),
    price: bigint('price', { mode: 'number' }).notNull(),
    /** Certains animaux (dragonnet) ne s'achètent qu'en gemmes ou en événement. */
    priceGems: bigint('price_gems', { mode: 'number' }).notNull().default(0),
    /** Bâtiment requis pour l'héberger (`coop`, `barn`, `pen`, `apiary`…). */
    buildingKey: varchar('building_key', { length: 48 }).notNull(),
    /** Objet produit et quantité par cycle. */
    productItemKey: varchar('product_item_key', { length: 48 }).notNull(),
    productQuantity: smallint('product_quantity').notNull().default(1),
    productionSeconds: integer('production_seconds').notNull(),
    feedItemKey: varchar('feed_item_key', { length: 48 }).notNull(),
    feedPerCycle: smallint('feed_per_cycle').notNull().default(1),
    requiredLevel: integer('required_level').notNull().default(1),
    /** Espérance de vie en jours réels ; 0 = immortel. */
    lifespanDays: integer('lifespan_days').notNull().default(0),
    breedable: boolean('breedable').notNull().default(true),
    breedingCooldownSeconds: integer('breeding_cooldown_seconds').notNull().default(86_400),
    /** Points de faim perdus par heure (0-100). */
    hungerRate: numeric('hunger_rate', { precision: 5, scale: 2 }).notNull().default('4.00'),
    happinessRate: numeric('happiness_rate', { precision: 5, scale: 2 }).notNull().default('2.00'),
    /** Bonus passif accordé par l'animal, ex. `{"marketSellBonus":0.05}`. */
    passiveBonus: jsonb('passive_bonus').notNull().default(sql`'{}'::jsonb`),
    eventOnly: boolean('event_only').notNull().default(false),
    sprite: varchar('sprite', { length: 64 }),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('animals_config_level_idx').on(t.requiredLevel),
    index('animals_config_building_idx').on(t.buildingKey),
    check('animals_config_price_non_negative', sql`${t.price} >= 0 AND ${t.priceGems} >= 0`),
    check('animals_config_production_positive', sql`${t.productionSeconds} > 0`),
  ],
);

export const buildingsConfig = pgTable(
  'buildings_config',
  {
    key: varchar('key', { length: 48 }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    category: buildingCategoryEnum('category').notNull(),
    maxTier: smallint('max_tier').notNull().default(1),
    /**
     * Paliers d'amélioration, un objet par tier :
     * `[{ tier:1, cost:5000, requiredLevel:2, capacity:4, slots:1, speedMultiplier:1 }]`
     * Stocké en JSONB pour éviter une table `buildings_tiers` de 60 lignes que
     * personne ne requête indépendamment ; validé par Zod au chargement.
     */
    tiers: jsonb('tiers').notNull(),
    requiredLevel: integer('required_level').notNull().default(1),
    /** Recettes de transformation autorisées dans ce bâtiment. */
    unlocksRecipes: text('unlocks_recipes').array().notNull().default(sql`ARRAY[]::text[]`),
    sprite: varchar('sprite', { length: 64 }),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('buildings_config_category_idx').on(t.category),
    check('buildings_config_max_tier', sql`${t.maxTier} BETWEEN 1 AND 10`),
  ],
);

export const itemsConfig = pgTable(
  'items_config',
  {
    key: varchar('key', { length: 48 }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    category: itemCategoryEnum('category').notNull(),
    rarity: rarityEnum('rarity').notNull().default('common'),
    /** Prix d'achat en boutique (0 = non achetable). */
    basePrice: bigint('base_price', { mode: 'number' }).notNull().default(0),
    /** Prix de vente de référence (le marché fluctue autour de cette valeur). */
    sellPrice: bigint('sell_price', { mode: 'number' }).notNull().default(0),
    priceGems: bigint('price_gems', { mode: 'number' }).notNull().default(0),
    stackable: boolean('stackable').notNull().default(true),
    maxStack: integer('max_stack').notNull().default(9999),
    tradable: boolean('tradable').notNull().default(true),
    sellable: boolean('sellable').notNull().default(true),
    /** Le marché dynamique s'applique-t-il à cet objet ? */
    marketTracked: boolean('market_tracked').notNull().default(false),
    /** Effet si consommable : `{"type":"fertilizer","fertility":25}`. */
    effect: jsonb('effect'),
    requiredLevel: integer('required_level').notNull().default(1),
    /** Clé d'origine (culture, animal ou recette) pour la traçabilité. */
    sourceKey: varchar('source_key', { length: 48 }),
    /** Collection à compléter (`spring_set`, `rare_harvest`…). */
    collectionKey: varchar('collection_key', { length: 48 }),
    sprite: varchar('sprite', { length: 64 }),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('items_config_category_idx').on(t.category),
    index('items_config_rarity_idx').on(t.rarity),
    index('items_config_market_idx').on(t.marketTracked),
    index('items_config_collection_idx').on(t.collectionKey),
    check('items_config_prices_non_negative', sql`${t.basePrice} >= 0 AND ${t.sellPrice} >= 0`),
    check('items_config_max_stack_positive', sql`${t.maxStack} > 0`),
  ],
);

export const recipesConfig = pgTable(
  'recipes_config',
  {
    key: varchar('key', { length: 48 }).primaryKey(),
    name: varchar('name', { length: 64 }).notNull(),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    buildingKey: varchar('building_key', { length: 48 })
      .notNull()
      .references(() => buildingsConfig.key, { onUpdate: 'cascade' }),
    outputItemKey: varchar('output_item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    outputQuantity: smallint('output_quantity').notNull().default(1),
    /** `[{ "itemKey": "wheat", "quantity": 3 }]` — validé par Zod. */
    ingredients: jsonb('ingredients').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    requiredLevel: integer('required_level').notNull().default(1),
    xpReward: integer('xp_reward').notNull().default(1),
    category: varchar('category', { length: 32 }).notNull().default('general'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('recipes_config_building_idx').on(t.buildingKey),
    index('recipes_config_level_idx').on(t.requiredLevel),
    index('recipes_config_category_idx').on(t.category),
    check('recipes_config_duration_positive', sql`${t.durationSeconds} > 0`),
    check('recipes_config_output_positive', sql`${t.outputQuantity} > 0`),
  ],
);

export const questsConfig = pgTable(
  'quests_config',
  {
    key: varchar('key', { length: 64 }).primaryKey(),
    type: questTypeEnum('type').notNull(),
    title: varchar('title', { length: 128 }).notNull(),
    description: text('description').notNull(),
    objectiveType: questObjectiveEnum('objective_type').notNull(),
    /** Cible optionnelle : `{"cropKey":"wheat"}` ou `{"category":"harvest"}`. */
    objectiveTarget: jsonb('objective_target').notNull().default(sql`'{}'::jsonb`),
    requiredAmount: integer('required_amount').notNull().default(1),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardGems: bigint('reward_gems', { mode: 'number' }).notNull().default(0),
    rewardXp: integer('reward_xp').notNull().default(0),
    /** `[{ "itemKey":"fertilizer_basic", "quantity":2 }]` */
    rewardItems: jsonb('reward_items').notNull().default(sql`'[]'::jsonb`),
    rewardPassXp: integer('reward_pass_xp').notNull().default(0),
    requiredLevel: integer('required_level').notNull().default(1),
    /** Quêtes narratives : chaîne + rang dans la chaîne. */
    chainKey: varchar('chain_key', { length: 48 }),
    chainStep: integer('chain_step'),
    /** Poids de tirage aléatoire pour les quêtes journalières/hebdo. */
    weight: integer('weight').notNull().default(10),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('quests_config_type_idx').on(t.type),
    index('quests_config_chain_idx').on(t.chainKey, t.chainStep),
    index('quests_config_level_idx').on(t.requiredLevel),
    check('quests_config_amount_positive', sql`${t.requiredAmount} > 0`),
    check('quests_config_weight_positive', sql`${t.weight} > 0`),
    check(
      'quests_config_rewards_non_negative',
      sql`${t.rewardCoins} >= 0 AND ${t.rewardGems} >= 0 AND ${t.rewardXp} >= 0`,
    ),
  ],
);

export const achievementsConfig = pgTable(
  'achievements_config',
  {
    key: varchar('key', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description').notNull(),
    category: varchar('category', { length: 32 }).notNull().default('general'),
    icon: varchar('icon', { length: 32 }).notNull().default('🏆'),
    tier: smallint('tier').notNull().default(1),
    /** Réutilise les mêmes types d'objectifs que les quêtes, en cumulatif. */
    conditionType: questObjectiveEnum('condition_type').notNull(),
    conditionTarget: jsonb('condition_target').notNull().default(sql`'{}'::jsonb`),
    conditionAmount: bigint('condition_amount', { mode: 'number' }).notNull().default(1),
    rewardCoins: bigint('reward_coins', { mode: 'number' }).notNull().default(0),
    rewardGems: bigint('reward_gems', { mode: 'number' }).notNull().default(0),
    rewardItems: jsonb('reward_items').notNull().default(sql`'[]'::jsonb`),
    rewardTitle: varchar('reward_title', { length: 64 }),
    rewardBadge: varchar('reward_badge', { length: 64 }),
    hidden: boolean('hidden').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('achievements_config_category_idx').on(t.category),
    index('achievements_config_condition_idx').on(t.conditionType),
    check('achievements_config_amount_positive', sql`${t.conditionAmount} > 0`),
  ],
);

export const eventsConfig = pgTable(
  'events_config',
  {
    key: varchar('key', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description').notNull(),
    type: eventTypeEnum('type').notNull().default('seasonal'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Cron de réactivation annuelle (`0 0 1 10 *` = 1er octobre). */
    recurringCron: varchar('recurring_cron', { length: 64 }),
    banner: varchar('banner', { length: 96 }),
    /** Modificateurs appliqués tant que l'événement est actif. */
    modifiers: jsonb('modifiers').notNull().default(sql`'{}'::jsonb`),
    /** Paliers de points → récompenses. */
    rewardTiers: jsonb('reward_tiers').notNull().default(sql`'[]'::jsonb`),
    /** Boutique spéciale de l'événement. */
    shopItems: jsonb('shop_items').notNull().default(sql`'[]'::jsonb`),
    /** Monnaie d'événement (clé d'objet) le cas échéant. */
    currencyItemKey: varchar('currency_item_key', { length: 48 }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_config_window_idx').on(t.startsAt, t.endsAt),
    index('events_config_enabled_idx').on(t.enabled),
  ],
);

export const seasonPass = pgTable(
  'season_pass',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    seasonKey: varchar('season_key', { length: 48 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    maxTier: integer('max_tier').notNull().default(30),
    xpPerTier: integer('xp_per_tier').notNull().default(500),
    /** `[{ "tier":1, "free":{...}, "premium":{...} }]` */
    tiers: jsonb('tiers').notNull(),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('season_pass_season_key_uq').on(t.seasonKey),
    index('season_pass_active_idx').on(t.active),
    check('season_pass_window_valid', sql`${t.endsAt} > ${t.startsAt}`),
    check('season_pass_tier_positive', sql`${t.maxTier} > 0 AND ${t.xpPerTier} > 0`),
  ],
);
