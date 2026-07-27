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
import { itemsConfig } from './config';
import { users } from './core';
import {
  auctionStatusEnum,
  currencyEnum,
  mutationEnum,
  qualityEnum,
  tradeStatusEnum,
  transactionTypeEnum,
} from './enums';

/**
 * Journal économique immuable — la « comptabilité » du bot.
 *
 * Toute variation de pièces ou de gemmes écrit exactement une ligne, dans la
 * MÊME transaction SQL que la mise à jour du solde. On peut donc recalculer
 * n'importe quel solde par `SUM(amount)` et détecter une incohérence
 * (`users.coins <> SUM`) : c'est le socle de l'anti-triche et du suivi de la
 * masse monétaire. `amount` est signé : négatif = puits, positif = source.
 * Aucun UPDATE/DELETE n'est autorisé (trigger `transactions_immutable`).
 */
export const transactions = pgTable(
  'transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: transactionTypeEnum('type').notNull(),
    currency: currencyEnum('currency').notNull().default('coins'),
    /** Montant signé. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Solde après opération : permet un audit ligne à ligne sans recalcul. */
    balanceAfter: bigint('balance_after', { mode: 'number' }).notNull(),
    itemKey: varchar('item_key', { length: 48 }),
    quantity: integer('quantity'),
    unitPrice: bigint('unit_price', { mode: 'number' }),
    /** Contrepartie : autre joueur, coopérative, PNJ… */
    counterpartyId: uuid('counterparty_id'),
    referenceType: varchar('reference_type', { length: 32 }),
    referenceId: varchar('reference_id', { length: 64 }),
    /** Serveur Discord d'origine (statistiques par serveur). */
    discordGuildId: varchar('discord_guild_id', { length: 20 }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('transactions_type_created_idx').on(t.type, t.createdAt.desc()),
    index('transactions_created_idx').on(t.createdAt.desc()),
    index('transactions_item_idx').on(t.itemKey),
    index('transactions_reference_idx').on(t.referenceType, t.referenceId),
    check('transactions_amount_non_zero', sql`${t.amount} <> 0`),
    check('transactions_balance_non_negative', sql`${t.balanceAfter} >= 0`),
  ],
);

/**
 * Prix courant du marché dynamique, une ligne par objet suivi.
 *
 * Modèle : `prix = basePrice × clamp(demandIndex, floor, ceil)` où
 * `demandIndex` dérive du volume vendu par les joueurs sur la fenêtre glissante
 * (offre) rapporté à un volume de référence (demande). Vendre massivement un
 * objet fait baisser son prix — c'est le principal frein aux fermes à blé
 * mono-culture et le premier régulateur anti-inflation.
 */
export const marketPrices = pgTable(
  'market_prices',
  {
    itemKey: varchar('item_key', { length: 48 })
      .primaryKey()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    basePrice: bigint('base_price', { mode: 'number' }).notNull(),
    currentPrice: bigint('current_price', { mode: 'number' }).notNull(),
    previousPrice: bigint('previous_price', { mode: 'number' }).notNull(),
    /** Variation relative depuis la dernière mise à jour (-1..+1). */
    trend: numeric('trend', { precision: 7, scale: 4 }).notNull().default('0.0000'),
    /** Indice de demande (1 = neutre, <1 = saturé, >1 = pénurie). */
    demandIndex: numeric('demand_index', { precision: 7, scale: 4 }).notNull().default('1.0000'),
    /** Volume vendu par les joueurs depuis la dernière mise à jour. */
    volumeWindow: bigint('volume_window', { mode: 'number' }).notNull().default(0),
    /** Volume de référence attendu par cycle, calibré au seed. */
    referenceVolume: bigint('reference_volume', { mode: 'number' }).notNull().default(100),
    /** Amplitude maximale de variation par cycle. */
    volatility: numeric('volatility', { precision: 5, scale: 4 }).notNull().default('0.0800'),
    priceFloorPct: numeric('price_floor_pct', { precision: 5, scale: 4 }).notNull().default('0.5500'),
    priceCeilPct: numeric('price_ceil_pct', { precision: 5, scale: 4 }).notNull().default('1.8000'),
    /** Objet vedette du jour : bonus de prix temporaire. */
    featured: boolean('featured').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    nextUpdateAt: timestamp('next_update_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('market_prices_trend_idx').on(t.trend.desc()),
    index('market_prices_next_update_idx').on(t.nextUpdateAt),
    check('market_prices_positive', sql`${t.currentPrice} > 0 AND ${t.basePrice} > 0`),
    check('market_prices_bounds', sql`${t.priceFloorPct} < ${t.priceCeilPct}`),
  ],
);

export const marketPriceHistory = pgTable(
  'market_price_history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    itemKey: varchar('item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    price: bigint('price', { mode: 'number' }).notNull(),
    demandIndex: numeric('demand_index', { precision: 7, scale: 4 }).notNull().default('1.0000'),
    volume: bigint('volume', { mode: 'number' }).notNull().default(0),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('market_history_item_time_idx').on(t.itemKey, t.recordedAt.desc()),
    index('market_history_time_idx').on(t.recordedAt),
    check('market_history_price_positive', sql`${t.price} > 0`),
  ],
);

/** Boutique quotidienne : stock limité, rotation à minuit UTC. */
export const shopStock = pgTable(
  'shop_stock',
  {
    id: uuid('id').primaryKey(),
    itemKey: varchar('item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    rotationDate: date('rotation_date').notNull(),
    category: varchar('category', { length: 32 }).notNull().default('daily'),
    price: bigint('price', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull().default('coins'),
    discountPercent: smallint('discount_percent').notNull().default(0),
    stockTotal: integer('stock_total').notNull(),
    stockRemaining: integer('stock_remaining').notNull(),
    /** Limite d'achat par joueur (0 = illimité dans la limite du stock). */
    perUserLimit: integer('per_user_limit').notNull().default(0),
    requiredLevel: integer('required_level').notNull().default(1),
    featured: boolean('featured').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shop_stock_item_rotation_uq').on(t.itemKey, t.rotationDate, t.category),
    index('shop_stock_rotation_idx').on(t.rotationDate, t.category),
    check('shop_stock_price_positive', sql`${t.price} > 0`),
    check(
      'shop_stock_remaining_range',
      sql`${t.stockRemaining} >= 0 AND ${t.stockRemaining} <= ${t.stockTotal}`,
    ),
    check('shop_stock_discount_range', sql`${t.discountPercent} BETWEEN 0 AND 90`),
  ],
);

/** Hôtel des ventes : vente directe (buyout) et/ou enchères. */
export const auctionListings = pgTable(
  'auction_listings',
  {
    id: uuid('id').primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: varchar('item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    quality: qualityEnum('quality').notNull().default('normal'),
    mutation: mutationEnum('mutation').notNull().default('none'),
    quantity: integer('quantity').notNull(),
    /** Prix de départ des enchères (par lot, pas à l'unité). */
    startPrice: bigint('start_price', { mode: 'number' }).notNull(),
    /** Achat immédiat ; NULL = enchère pure. */
    buyoutPrice: bigint('buyout_price', { mode: 'number' }),
    currentBid: bigint('current_bid', { mode: 'number' }),
    currentBidderId: uuid('current_bidder_id').references(() => users.id, { onDelete: 'set null' }),
    /** Commission prélevée au vendeur à la vente (puits monétaire). */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 })
      .notNull()
      .default('0.0500'),
    /** Frais de mise en vente, non remboursables (anti-spam d'annonces). */
    listingFee: bigint('listing_fee', { mode: 'number' }).notNull().default(0),
    status: auctionStatusEnum('status').notNull().default('active'),
    buyerId: uuid('buyer_id').references(() => users.id, { onDelete: 'set null' }),
    soldPrice: bigint('sold_price', { mode: 'number' }),
    soldAt: timestamp('sold_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auction_active_item_idx').on(t.status, t.itemKey, t.expiresAt),
    index('auction_seller_idx').on(t.sellerId, t.status),
    index('auction_expires_idx').on(t.status, t.expiresAt),
    index('auction_bidder_idx').on(t.currentBidderId),
    check('auction_quantity_positive', sql`${t.quantity} > 0`),
    check('auction_prices_positive', sql`${t.startPrice} > 0 AND (${t.buyoutPrice} IS NULL OR ${t.buyoutPrice} >= ${t.startPrice})`),
    check('auction_bid_above_start', sql`${t.currentBid} IS NULL OR ${t.currentBid} >= ${t.startPrice}`),
    check('auction_no_self_purchase', sql`${t.buyerId} IS NULL OR ${t.buyerId} <> ${t.sellerId}`),
  ],
);

export const auctionBids = pgTable(
  'auction_bids',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => auctionListings.id, { onDelete: 'cascade' }),
    bidderId: uuid('bidder_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    isWinning: boolean('is_winning').notNull().default(true),
    /** Les mises perdantes sont remboursées par le job d'expiration. */
    refunded: boolean('refunded').notNull().default(false),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auction_bids_listing_idx').on(t.listingId, t.amount.desc()),
    index('auction_bids_bidder_idx').on(t.bidderId, t.createdAt.desc()),
    index('auction_bids_refund_idx').on(t.refunded, t.isWinning),
    check('auction_bids_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** Échange direct joueur-à-joueur, avec double confirmation. */
export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey(),
    initiatorId: uuid('initiator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    initiatorCoins: bigint('initiator_coins', { mode: 'number' }).notNull().default(0),
    partnerCoins: bigint('partner_coins', { mode: 'number' }).notNull().default(0),
    initiatorConfirmed: boolean('initiator_confirmed').notNull().default(false),
    partnerConfirmed: boolean('partner_confirmed').notNull().default(false),
    /** Toute modification invalide les confirmations : anti « swap » de dernière seconde. */
    revision: integer('revision').notNull().default(0),
    status: tradeStatusEnum('status').notNull().default('pending'),
    channelId: varchar('channel_id', { length: 20 }),
    messageId: varchar('message_id', { length: 20 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trades_initiator_idx').on(t.initiatorId, t.status),
    index('trades_partner_idx').on(t.partnerId, t.status),
    index('trades_status_expires_idx').on(t.status, t.expiresAt),
    check('trades_no_self', sql`${t.initiatorId} <> ${t.partnerId}`),
    check('trades_coins_non_negative', sql`${t.initiatorCoins} >= 0 AND ${t.partnerCoins} >= 0`),
  ],
);

export const tradeItems = pgTable(
  'trade_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'cascade' }),
    /** Propriétaire de l'objet offert (initiateur ou partenaire). */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: varchar('item_key', { length: 48 })
      .notNull()
      .references(() => itemsConfig.key, { onUpdate: 'cascade' }),
    quality: qualityEnum('quality').notNull().default('normal'),
    mutation: mutationEnum('mutation').notNull().default('none'),
    quantity: integer('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trade_items_uq').on(t.tradeId, t.userId, t.itemKey, t.quality, t.mutation),
    index('trade_items_trade_idx').on(t.tradeId),
    check('trade_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

/**
 * Instantané agrégé de l'économie, produit toutes les heures par le scheduler.
 * Sert au tableau de bord `/admin stats` et à la détection d'inflation
 * (masse monétaire en croissance > x %/jour ⇒ alerte).
 */
export const economySnapshots = pgTable(
  'economy_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    totalCoins: bigint('total_coins', { mode: 'number' }).notNull(),
    totalBankCoins: bigint('total_bank_coins', { mode: 'number' }).notNull(),
    totalGems: bigint('total_gems', { mode: 'number' }).notNull(),
    coinsCreated: bigint('coins_created', { mode: 'number' }).notNull().default(0),
    coinsDestroyed: bigint('coins_destroyed', { mode: 'number' }).notNull().default(0),
    activeUsers24h: integer('active_users_24h').notNull().default(0),
    totalUsers: integer('total_users').notNull().default(0),
    topItems: jsonb('top_items').notNull().default(sql`'[]'::jsonb`),
    /** Écarts solde/journal détectés par l'audit qui accompagne cet instantané. */
    ledgerMismatches: integer('ledger_mismatches').notNull().default(0),
    /** Joueurs au-dessus du seuil de suspicion « à revoir » au moment de l'instantané. */
    suspiciousUsers: integer('suspicious_users').notNull().default(0),
    notes: text('notes'),
  },
  (t) => [index('economy_snapshots_time_idx').on(t.capturedAt.desc())],
);
