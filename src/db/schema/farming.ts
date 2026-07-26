import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { animalsConfig, buildingsConfig, cropsConfig, itemsConfig, recipesConfig } from './config';
import { farms, plots, users } from './core';
import { mutationEnum, qualityEnum, seasonEnum, weatherEnum } from './enums';

/**
 * Culture en cours sur une parcelle.
 *
 * MODÈLE « CROISSANCE CALCULÉE À LA LECTURE »
 * Aucun job ne parcourt les cultures pour les faire pousser. On stocke
 * `planted_at` + `ready_at` (= planted_at + growthSeconds effectif) et l'état
 * visible est déduit à la lecture par `src/game/growth.ts`.
 *  - Coût O(1) par joueur qui joue, au lieu de O(n) parcelles toutes les minutes.
 *    À 100 000 fermes × 25 parcelles, un tick global écrirait 2,5 M de lignes/min :
 *    intenable. Ici, une ferme inactive coûte exactement zéro.
 *  - Pas de dérive : redémarrage, panne, retard du scheduler n'ont aucun effet
 *    sur la progression (le temps réel est la seule source de vérité).
 *  - Les seuls jobs restants sont ceux qui *modifient* le monde sans lecture
 *    joueur : apparition de nuisibles, flétrissement, notifications DM.
 */
export const plantedCrops = pgTable(
  'planted_crops',
  {
    id: uuid('id').primaryKey(),
    plotId: uuid('plot_id')
      .notNull()
      .references(() => plots.id, { onDelete: 'cascade' }),
    /** Dénormalisé : évite un double join pour « toutes mes cultures prêtes ». */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cropKey: varchar('crop_key', { length: 48 })
      .notNull()
      .references(() => cropsConfig.key, { onUpdate: 'cascade' }),
    plantedAt: timestamp('planted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Instant de maturité, modificateurs déjà appliqués. */
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
    /** Durée effective retenue (traçabilité : permet d'auditer un boost). */
    growthSeconds: integer('growth_seconds').notNull(),
    /** Instant au-delà duquel la culture fane si non récoltée. */
    withersAt: timestamp('withers_at', { withTimezone: true }),
    waterNeeded: smallint('water_needed').notNull().default(1),
    waterGiven: smallint('water_given').notNull().default(0),
    lastWateredAt: timestamp('last_watered_at', { withTimezone: true }),
    /** Prochain arrosage attendu ; au-delà, malus de rendement cumulatif. */
    nextWaterAt: timestamp('next_water_at', { withTimezone: true }),
    missedWaterings: smallint('missed_waterings').notNull().default(0),
    fertilizerKey: varchar('fertilizer_key', { length: 48 }),
    /** Bonus multiplicatif de rendement apporté par l'engrais (0.25 = +25 %). */
    fertilizerBoost: numeric('fertilizer_boost', { precision: 5, scale: 3 })
      .notNull()
      .default('0.000'),
    /** Bonus de qualité apporté par l'engrais. */
    qualityBoost: numeric('quality_boost', { precision: 5, scale: 3 }).notNull().default('0.000'),
    /** Saison et météo au moment de la plantation (audit + affichage). */
    seasonPlanted: seasonEnum('season_planted'),
    weatherPlanted: weatherEnum('weather_planted'),
    /** Malus cumulé (0-1) infligé par les orages, le gel, les nuisibles. */
    damagePenalty: numeric('damage_penalty', { precision: 5, scale: 3 }).notNull().default('0.000'),
    /** Mutation tirée à la plantation, révélée à la récolte. */
    mutation: mutationEnum('mutation').notNull().default('none'),
    /** Cycles de repousse restants (0 = à replanter après récolte). */
    regrowRemaining: smallint('regrow_remaining').notNull().default(0),
    harvestCount: smallint('harvest_count').notNull().default(0),
    withered: boolean('withered').notNull().default(false),
    /** Aide reçue d'autres joueurs (`/assist`) : bonus de rendement partagé. */
    helpedBy: uuid('helped_by').array().notNull().default(sql`ARRAY[]::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Une seule culture active par parcelle.
    uniqueIndex('planted_crops_plot_uq').on(t.plotId),
    index('planted_crops_user_ready_idx').on(t.userId, t.readyAt),
    index('planted_crops_ready_at_idx').on(t.readyAt),
    index('planted_crops_withers_idx').on(t.withersAt),
    index('planted_crops_next_water_idx').on(t.nextWaterAt),
    index('planted_crops_crop_idx').on(t.cropKey),
    check('planted_crops_ready_after_planted', sql`${t.readyAt} >= ${t.plantedAt}`),
    check('planted_crops_growth_positive', sql`${t.growthSeconds} > 0`),
    check(
      'planted_crops_water_range',
      sql`${t.waterGiven} >= 0 AND ${t.waterNeeded} >= 0 AND ${t.waterGiven} <= ${t.waterNeeded} + 8`,
    ),
    check('planted_crops_damage_range', sql`${t.damagePenalty} BETWEEN 0 AND 1`),
  ],
);

export const ownedBuildings = pgTable(
  'owned_buildings',
  {
    id: uuid('id').primaryKey(),
    farmId: uuid('farm_id')
      .notNull()
      .references(() => farms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    buildingKey: varchar('building_key', { length: 48 })
      .notNull()
      .references(() => buildingsConfig.key, { onUpdate: 'cascade' }),
    tier: smallint('tier').notNull().default(1),
    /** Valeurs effectives du tier courant, copiées à la construction. */
    capacity: integer('capacity').notNull().default(0),
    slots: smallint('slots').notNull().default(0),
    speedMultiplier: numeric('speed_multiplier', { precision: 5, scale: 3 })
      .notNull()
      .default('1.000'),
    /** Usure : sous 30 %, la production ralentit ; réparable contre pièces. */
    condition: smallint('condition').notNull().default(100),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
    upgradedAt: timestamp('upgraded_at', { withTimezone: true }),
    totalInvested: bigint('total_invested', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un seul exemplaire de chaque bâtiment par ferme (on améliore, on n'empile pas).
    uniqueIndex('owned_buildings_farm_key_uq').on(t.farmId, t.buildingKey),
    index('owned_buildings_user_idx').on(t.userId),
    check('owned_buildings_tier_range', sql`${t.tier} BETWEEN 1 AND 10`),
    check('owned_buildings_condition_range', sql`${t.condition} BETWEEN 0 AND 100`),
  ],
);

export const ownedAnimals = pgTable(
  'owned_animals',
  {
    id: uuid('id').primaryKey(),
    farmId: uuid('farm_id')
      .notNull()
      .references(() => farms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    animalKey: varchar('animal_key', { length: 48 })
      .notNull()
      .references(() => animalsConfig.key, { onUpdate: 'cascade' }),
    buildingId: uuid('building_id').references(() => ownedBuildings.id, { onDelete: 'set null' }),
    nickname: varchar('nickname', { length: 32 }),
    /**
     * Jauges 0-100 (100 = repu / heureux / en pleine santé).
     * Comme la croissance des cultures, la décroissance est calculée à la
     * lecture depuis `statsUpdatedAt` ; le job nocturne ne matérialise les
     * valeurs que pour déclencher maladie/mort et notifications.
     */
    hunger: smallint('hunger').notNull().default(100),
    happiness: smallint('happiness').notNull().default(80),
    health: smallint('health').notNull().default(100),
    statsUpdatedAt: timestamp('stats_updated_at', { withTimezone: true }).notNull().defaultNow(),
    bornAt: timestamp('born_at', { withTimezone: true }).notNull().defaultNow(),
    lastFedAt: timestamp('last_fed_at', { withTimezone: true }),
    lastPettedAt: timestamp('last_petted_at', { withTimezone: true }),
    lastCollectedAt: timestamp('last_collected_at', { withTimezone: true }),
    lastTreatedAt: timestamp('last_treated_at', { withTimezone: true }),
    lastBredAt: timestamp('last_bred_at', { withTimezone: true }),
    /** Prochaine production disponible. */
    productionReadyAt: timestamp('production_ready_at', { withTimezone: true }),
    /** Productions accumulées non collectées (plafonnées). */
    pendingProduction: smallint('pending_production').notNull().default(0),
    totalProduced: integer('total_produced').notNull().default(0),
    /** Multiplicateur de production hérité de la génétique (élevage sélectif). */
    qualityMultiplier: numeric('quality_multiplier', { precision: 5, scale: 3 })
      .notNull()
      .default('1.000'),
    generation: smallint('generation').notNull().default(1),
    parentAId: uuid('parent_a_id'),
    parentBId: uuid('parent_b_id'),
    isSick: boolean('is_sick').notNull().default(false),
    isAlive: boolean('is_alive').notNull().default(true),
    diedAt: timestamp('died_at', { withTimezone: true }),
    deathReason: varchar('death_reason', { length: 32 }),
    purchasePrice: bigint('purchase_price', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('owned_animals_farm_alive_idx').on(t.farmId, t.isAlive),
    index('owned_animals_user_idx').on(t.userId),
    index('owned_animals_production_idx').on(t.productionReadyAt),
    index('owned_animals_building_idx').on(t.buildingId),
    index('owned_animals_stats_updated_idx').on(t.statsUpdatedAt),
    check('owned_animals_hunger_range', sql`${t.hunger} BETWEEN 0 AND 100`),
    check('owned_animals_happiness_range', sql`${t.happiness} BETWEEN 0 AND 100`),
    check('owned_animals_health_range', sql`${t.health} BETWEEN 0 AND 100`),
    check('owned_animals_pending_range', sql`${t.pendingProduction} BETWEEN 0 AND 200`),
    check(
      'owned_animals_death_consistency',
      sql`(${t.isAlive} AND ${t.diedAt} IS NULL) OR (NOT ${t.isAlive} AND ${t.diedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Inventaire. Une ligne par (joueur, objet, qualité, mutation) : un blé doré ne
 * se mélange pas à un blé normal puisqu'ils n'ont pas la même valeur.
 * `mutation` est NOT NULL avec la valeur 'none' plutôt que NULL, sinon la
 * contrainte d'unicité serait inopérante (NULL ≠ NULL en SQL).
 */
export const inventory = pgTable(
  'inventory',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: varchar('item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    quantity: integer('quantity').notNull().default(0),
    quality: qualityEnum('quality').notNull().default('normal'),
    mutation: mutationEnum('mutation').notNull().default('none'),
    /** Objet verrouillé : exclu des ventes de masse et des échanges. */
    locked: boolean('locked').notNull().default(false),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_stack_uq').on(t.userId, t.itemKey, t.quality, t.mutation),
    index('inventory_user_idx').on(t.userId),
    index('inventory_item_idx').on(t.itemKey),
    // Jamais de quantité négative : le retrait se fait via
    // `UPDATE ... SET quantity = quantity - n WHERE quantity >= n` et cette
    // contrainte est la seconde barrière.
    check('inventory_quantity_non_negative', sql`${t.quantity} >= 0`),
  ],
);

export const craftingQueue = pgTable(
  'crafting_queue',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => ownedBuildings.id, { onDelete: 'cascade' }),
    recipeKey: varchar('recipe_key', { length: 48 })
      .notNull()
      .references(() => recipesConfig.key, { onUpdate: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    slotIndex: smallint('slot_index').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishAt: timestamp('finish_at', { withTimezone: true }).notNull(),
    collected: boolean('collected').notNull().default(false),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
    /** Ingrédients réellement consommés (remboursement en cas d'annulation). */
    consumed: jsonb('consumed').notNull().default(sql`'[]'::jsonb`),
    outputQuality: qualityEnum('output_quality').notNull().default('normal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un emplacement de bâtiment ne peut porter qu'une production non collectée.
    uniqueIndex('crafting_queue_slot_uq')
      .on(t.buildingId, t.slotIndex)
      .where(sql`collected = false`),
    index('crafting_queue_user_idx').on(t.userId, t.collected),
    index('crafting_queue_finish_idx').on(t.finishAt),
    check('crafting_queue_quantity_positive', sql`${t.quantity} > 0`),
    check('crafting_queue_finish_after_start', sql`${t.finishAt} >= ${t.startedAt}`),
  ],
);
