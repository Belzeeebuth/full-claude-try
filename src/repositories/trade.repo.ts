import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  auctionBids,
  auctionListings,
  itemsConfig,
  standingOrders,
  tradeItems,
  trades,
  users,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Hôtel des ventes et échanges directs entre joueurs. */

export type AuctionRow = typeof auctionListings.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type StandingOrderRow = typeof standingOrders.$inferSelect;

export async function createListing(
  values: Omit<typeof auctionListings.$inferInsert, 'id'>,
  executor: Executor,
): Promise<AuctionRow> {
  const [row] = await executor
    .insert(auctionListings)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function countActiveListings(
  sellerId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(auctionListings)
    .where(and(eq(auctionListings.sellerId, sellerId), eq(auctionListings.status, 'active')));
  return row?.count ?? 0;
}

export async function listActiveListings(
  options: { itemKey?: string; sellerId?: string; limit?: number; offset?: number } = {},
  executor: Executor = getDb(),
) {
  const conditions = [eq(auctionListings.status, 'active'), gte(auctionListings.expiresAt, new Date())];
  if (options.itemKey) conditions.push(eq(auctionListings.itemKey, options.itemKey));
  if (options.sellerId) conditions.push(eq(auctionListings.sellerId, options.sellerId));

  return executor
    .select({
      listing: auctionListings,
      itemName: itemsConfig.name,
      itemEmoji: itemsConfig.emoji,
      rarity: itemsConfig.rarity,
      sellerName: users.username,
      sellerDiscordId: users.discordId,
    })
    .from(auctionListings)
    .innerJoin(itemsConfig, eq(itemsConfig.key, auctionListings.itemKey))
    .innerJoin(users, eq(users.id, auctionListings.sellerId))
    .where(and(...conditions))
    .orderBy(asc(auctionListings.expiresAt))
    .limit(options.limit ?? 10)
    .offset(options.offset ?? 0);
}

export async function countActiveListingsTotal(
  itemKey: string | undefined,
  executor: Executor = getDb(),
): Promise<number> {
  const conditions = [eq(auctionListings.status, 'active'), gte(auctionListings.expiresAt, new Date())];
  if (itemKey) conditions.push(eq(auctionListings.itemKey, itemKey));
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(auctionListings)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export async function lockListing(tx: Executor, listingId: string): Promise<AuctionRow | undefined> {
  const [row] = await tx
    .select()
    .from(auctionListings)
    .where(eq(auctionListings.id, listingId))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Marque une annonce comme vendue, de façon atomique.
 * Le `WHERE status = 'active'` garantit qu'une annonce ne peut être vendue
 * qu'une seule fois même si deux acheteurs cliquent simultanément.
 */
export async function markSold(
  listingId: string,
  buyerId: string,
  soldPrice: number,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(auctionListings)
    .set({
      status: 'sold',
      buyerId,
      soldPrice,
      soldAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(auctionListings.id, listingId), eq(auctionListings.status, 'active')));
  return (result.rowCount ?? 0) > 0;
}

export async function cancelListing(
  listingId: string,
  sellerId: string,
  executor: Executor,
): Promise<AuctionRow | undefined> {
  const [row] = await executor
    .update(auctionListings)
    .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(auctionListings.id, listingId),
        eq(auctionListings.sellerId, sellerId),
        eq(auctionListings.status, 'active'),
        sql`${auctionListings.currentBid} IS NULL`,
      ),
    )
    .returning();
  return row;
}

export async function placeBid(
  listingId: string,
  bidderId: string,
  amount: number,
  minimum: number,
  executor: Executor,
): Promise<{ previousBidderId: string | null; previousBid: number | null } | null> {
  const [row] = await executor
    .update(auctionListings)
    .set({ currentBid: amount, currentBidderId: bidderId, updatedAt: new Date() })
    .where(
      and(
        eq(auctionListings.id, listingId),
        eq(auctionListings.status, 'active'),
        sql`(${auctionListings.currentBid} IS NULL AND ${amount} >= ${minimum}) OR ${amount} >= ${minimum}`,
        sql`${auctionListings.sellerId} <> ${bidderId}`,
      ),
    )
    .returning({
      previousBidderId: auctionListings.currentBidderId,
      previousBid: auctionListings.currentBid,
    });

  if (!row) return null;

  await executor
    .update(auctionBids)
    .set({ isWinning: false })
    .where(and(eq(auctionBids.listingId, listingId), eq(auctionBids.isWinning, true)));

  await executor.insert(auctionBids).values({ listingId, bidderId, amount, isWinning: true });

  return row;
}

export async function extendListing(
  listingId: string,
  minutes: number,
  executor: Executor,
): Promise<void> {
  await executor
    .update(auctionListings)
    .set({
      expiresAt: sql`${auctionListings.expiresAt} + (${minutes} || ' minutes')::interval`,
      updatedAt: new Date(),
    })
    .where(eq(auctionListings.id, listingId));
}

export async function findExpiredListings(now: Date, limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(auctionListings)
    .where(and(eq(auctionListings.status, 'active'), lte(auctionListings.expiresAt, now)))
    .limit(limit);
}

export async function markExpired(listingId: string, executor: Executor): Promise<boolean> {
  const result = await executor
    .update(auctionListings)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(auctionListings.id, listingId), eq(auctionListings.status, 'active')));
  return (result.rowCount ?? 0) > 0;
}

export async function findUnrefundedLosingBids(
  listingId: string,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(auctionBids)
    .where(
      and(
        eq(auctionBids.listingId, listingId),
        eq(auctionBids.refunded, false),
        eq(auctionBids.isWinning, false),
      ),
    );
}

export async function markBidsRefunded(bidIds: number[], executor: Executor): Promise<void> {
  if (bidIds.length === 0) return;
  await executor
    .update(auctionBids)
    .set({ refunded: true, refundedAt: new Date() })
    .where(inArray(auctionBids.id, bidIds));
}

// ---------------------------------------------------------------------------
// Ordres d'achat permanents
// ---------------------------------------------------------------------------

export async function createStandingOrder(
  values: Omit<typeof standingOrders.$inferInsert, 'id'>,
  executor: Executor,
): Promise<StandingOrderRow> {
  const [row] = await executor
    .insert(standingOrders)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function countActiveOrders(buyerId: string, executor: Executor = getDb()): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(standingOrders)
    .where(and(eq(standingOrders.buyerId, buyerId), eq(standingOrders.status, 'active')));
  return row?.count ?? 0;
}

export async function listOrders(buyerId: string, executor: Executor = getDb()) {
  return executor
    .select({
      order: standingOrders,
      itemName: itemsConfig.name,
      itemEmoji: itemsConfig.emoji,
    })
    .from(standingOrders)
    .innerJoin(itemsConfig, eq(itemsConfig.key, standingOrders.itemKey))
    .where(and(eq(standingOrders.buyerId, buyerId), eq(standingOrders.status, 'active')))
    .orderBy(desc(standingOrders.createdAt));
}

export async function cancelOrder(
  orderId: string,
  buyerId: string,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(standingOrders)
    .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(standingOrders.id, orderId),
        eq(standingOrders.buyerId, buyerId),
        eq(standingOrders.status, 'active'),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/** Ordres actifs et non expirés, les plus anciens d'abord — file d'attente équitable. */
export async function findMatchableOrders(limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(standingOrders)
    .where(and(eq(standingOrders.status, 'active'), gte(standingOrders.expiresAt, new Date())))
    .orderBy(asc(standingOrders.createdAt))
    .limit(limit);
}

/**
 * Annonces actives pouvant satisfaire un ordre : même objet (et qualité /
 * mutation si l'ordre les précise), achat immédiat activé, quantité totale de
 * l'annonce tenant dans ce qu'il reste à acheter, prix total dans le budget.
 * Comparaison en prix TOTAL (`buyoutPrice <= maxUnitPrice × quantity`), jamais
 * en prix unitaire, pour ne pas introduire d'arrondi de division entière.
 */
export async function findMatchingListings(
  order: { itemKey: string; quality: string | null; mutation: string | null; maxUnitPrice: number; remainingQuantity: number; buyerId: string },
  executor: Executor = getDb(),
) {
  const conditions = [
    eq(auctionListings.status, 'active'),
    gte(auctionListings.expiresAt, new Date()),
    eq(auctionListings.itemKey, order.itemKey),
    ne(auctionListings.sellerId, order.buyerId),
    sql`${auctionListings.buyoutPrice} IS NOT NULL`,
    sql`${auctionListings.quantity} <= ${order.remainingQuantity}`,
    sql`${auctionListings.buyoutPrice} <= ${order.maxUnitPrice} * ${auctionListings.quantity}`,
  ];
  if (order.quality) conditions.push(eq(auctionListings.quality, order.quality as typeof auctionListings.$inferSelect.quality));
  if (order.mutation) conditions.push(eq(auctionListings.mutation, order.mutation as typeof auctionListings.$inferSelect.mutation));

  return executor
    .select()
    .from(auctionListings)
    .where(and(...conditions))
    .orderBy(asc(auctionListings.buyoutPrice))
    .limit(5);
}

/**
 * Décrémente la quantité restante après un achat, et clôt l'ordre s'il est
 * épuisé. `WHERE status = 'active'` protège contre une double exécution.
 */
export async function fillOrder(
  orderId: string,
  quantity: number,
  executor: Executor,
): Promise<{ remainingQuantity: number; fulfilled: boolean } | undefined> {
  const [row] = await executor
    .update(standingOrders)
    .set({
      remainingQuantity: sql`${standingOrders.remainingQuantity} - ${quantity}`,
      updatedAt: new Date(),
    })
    .where(and(eq(standingOrders.id, orderId), eq(standingOrders.status, 'active')))
    .returning({ remainingQuantity: standingOrders.remainingQuantity });

  if (!row) return undefined;

  const fulfilled = row.remainingQuantity <= 0;
  if (fulfilled) {
    await executor
      .update(standingOrders)
      .set({ status: 'fulfilled', fulfilledAt: new Date() })
      .where(and(eq(standingOrders.id, orderId), eq(standingOrders.status, 'active')));
  }
  return { remainingQuantity: row.remainingQuantity, fulfilled };
}

export async function findExpiredOrders(now: Date, limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(standingOrders)
    .where(and(eq(standingOrders.status, 'active'), lte(standingOrders.expiresAt, now)))
    .limit(limit);
}

export async function markOrderExpired(orderId: string, executor: Executor): Promise<boolean> {
  const result = await executor
    .update(standingOrders)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(standingOrders.id, orderId), eq(standingOrders.status, 'active')));
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Échanges directs
// ---------------------------------------------------------------------------

export async function createTrade(
  values: Omit<typeof trades.$inferInsert, 'id'>,
  executor: Executor,
): Promise<TradeRow> {
  const [row] = await executor
    .insert(trades)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function findTrade(tradeId: string, executor: Executor = getDb()) {
  const [row] = await executor.select().from(trades).where(eq(trades.id, tradeId)).limit(1);
  return row;
}

export async function lockTrade(tx: Executor, tradeId: string): Promise<TradeRow | undefined> {
  const [row] = await tx.select().from(trades).where(eq(trades.id, tradeId)).limit(1).for('update');
  return row;
}

export async function findPendingTradeBetween(
  userA: string,
  userB: string,
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.status, 'pending'),
        sql`(${trades.initiatorId} = ${userA} AND ${trades.partnerId} = ${userB})
             OR (${trades.initiatorId} = ${userB} AND ${trades.partnerId} = ${userA})`,
      ),
    )
    .limit(1);
  return row;
}

export async function listTradeItems(tradeId: string, executor: Executor = getDb()) {
  return executor
    .select({
      item: tradeItems,
      name: itemsConfig.name,
      emoji: itemsConfig.emoji,
      sellPrice: itemsConfig.sellPrice,
    })
    .from(tradeItems)
    .innerJoin(itemsConfig, eq(itemsConfig.key, tradeItems.itemKey))
    .where(eq(tradeItems.tradeId, tradeId))
    .orderBy(asc(tradeItems.id));
}

export async function upsertTradeItem(
  values: Omit<typeof tradeItems.$inferInsert, 'id'>,
  executor: Executor,
): Promise<void> {
  await executor
    .insert(tradeItems)
    .values(values)
    .onConflictDoUpdate({
      target: [
        tradeItems.tradeId,
        tradeItems.userId,
        tradeItems.itemKey,
        tradeItems.quality,
        tradeItems.mutation,
      ],
      set: { quantity: values.quantity },
    });
}

/**
 * Toute modification d'un échange invalide les deux confirmations et incrémente
 * la révision. C'est la protection contre le « swap » : impossible de faire
 * accepter une offre puis de la remplacer avant validation.
 */
export async function bumpTradeRevision(tradeId: string, executor: Executor): Promise<number> {
  const [row] = await executor
    .update(trades)
    .set({
      revision: sql`${trades.revision} + 1`,
      initiatorConfirmed: false,
      partnerConfirmed: false,
      updatedAt: new Date(),
    })
    .where(eq(trades.id, tradeId))
    .returning({ revision: trades.revision });
  return row?.revision ?? 0;
}

export async function confirmTrade(
  tradeId: string,
  userId: string,
  revision: number,
  executor: Executor,
): Promise<TradeRow | undefined> {
  const [trade] = await executor
    .select()
    .from(trades)
    .where(eq(trades.id, tradeId))
    .limit(1)
    .for('update');
  if (!trade || trade.revision !== revision || trade.status !== 'pending') return undefined;

  const isInitiator = trade.initiatorId === userId;
  const [row] = await executor
    .update(trades)
    .set({
      ...(isInitiator ? { initiatorConfirmed: true } : { partnerConfirmed: true }),
      updatedAt: new Date(),
    })
    .where(and(eq(trades.id, tradeId), eq(trades.revision, revision)))
    .returning();
  return row;
}

export async function setTradeStatus(
  tradeId: string,
  status: 'completed' | 'cancelled' | 'expired',
  by: string | null,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(trades)
    .set({
      status,
      ...(status === 'completed' ? { completedAt: new Date() } : {}),
      ...(status === 'cancelled' ? { cancelledAt: new Date(), cancelledBy: by } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(trades.id, tradeId), eq(trades.status, 'pending')));
  return (result.rowCount ?? 0) > 0;
}

export async function findExpiredTrades(now: Date, limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(trades)
    .where(and(eq(trades.status, 'pending'), lte(trades.expiresAt, now)))
    .limit(limit);
}

/** Historique de ventes d'un joueur, pour `/auction my-listings`. */
export async function listSellerHistory(
  sellerId: string,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      listing: auctionListings,
      itemName: itemsConfig.name,
      itemEmoji: itemsConfig.emoji,
    })
    .from(auctionListings)
    .innerJoin(itemsConfig, eq(itemsConfig.key, auctionListings.itemKey))
    .where(eq(auctionListings.sellerId, sellerId))
    .orderBy(desc(auctionListings.createdAt))
    .limit(limit);
}
