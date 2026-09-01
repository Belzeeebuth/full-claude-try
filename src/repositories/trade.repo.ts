import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  auctionBids,
  auctionListings,
  itemsConfig,
  tradeItems,
  trades,
  users,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Hôtel des ventes et échanges directs entre joueurs. */

export type AuctionRow = typeof auctionListings.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;

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

export interface OutbidRow {
  id: number;
  bidderId: string;
  amount: number;
  refunded: boolean;
}

/**
 * Enregistre une mise sur une annonce DÉJÀ verrouillée par `lockListing`.
 *
 * ⚠ Ne JAMAIS lire l'ancienne mise dans le `RETURNING` de cet `UPDATE` :
 * PostgreSQL y renvoie les valeurs NOUVELLES, pas les anciennes. Une version
 * précédente s'y fiait et remboursait donc à chaque enchérisseur sa propre mise
 * — les enchères étaient gratuites. L'ancienne valeur est celle que l'appelant a
 * lue sous verrou ; la source de vérité du séquestre reste `auction_bids`.
 *
 * Renvoie les mises détrônées pour que l'appelant les rembourse ET les marque
 * `refunded` dans la même transaction : rembourser sans marquer laisserait le
 * job d'expiration rembourser une seconde fois.
 */
export async function placeBid(
  listingId: string,
  bidderId: string,
  amount: number,
  executor: Executor,
): Promise<{ outbid: OutbidRow[] } | null> {
  const result = await executor
    .update(auctionListings)
    .set({ currentBid: amount, currentBidderId: bidderId, updatedAt: new Date() })
    .where(
      and(
        eq(auctionListings.id, listingId),
        eq(auctionListings.status, 'active'),
        ne(auctionListings.sellerId, bidderId),
        // Garde réelle : la mise doit battre celle en place. L'ancienne écriture
        // se réduisait à `amount >= minimum`, toujours vraie ici.
        sql`(${auctionListings.currentBid} IS NULL OR ${auctionListings.currentBid} < ${amount})`,
      ),
    );

  if ((result.rowCount ?? 0) === 0) return null;

  const outbid = await executor
    .update(auctionBids)
    .set({ isWinning: false })
    .where(and(eq(auctionBids.listingId, listingId), eq(auctionBids.isWinning, true)))
    .returning({
      id: auctionBids.id,
      bidderId: auctionBids.bidderId,
      amount: auctionBids.amount,
      refunded: auctionBids.refunded,
    });

  await executor.insert(auctionBids).values({ listingId, bidderId, amount, isWinning: true });

  return { outbid };
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

/**
 * Mises encore en séquestre pour une annonce.
 *
 * `includeWinning` distingue les deux clôtures possibles :
 *  - expiration AVEC gagnant : la mise gagnante finance le vendeur, seules les
 *    perdantes sont rendues (`includeWinning = false`) ;
 *  - achat immédiat : l'acheteur évince TOUT LE MONDE, y compris l'enchérisseur
 *    en tête, qui doit donc être remboursé lui aussi (`includeWinning = true`).
 */
export async function findUnrefundedBids(
  listingId: string,
  executor: Executor = getDb(),
  includeWinning = false,
) {
  return executor
    .select()
    .from(auctionBids)
    .where(
      and(
        eq(auctionBids.listingId, listingId),
        eq(auctionBids.refunded, false),
        ...(includeWinning ? [] : [eq(auctionBids.isWinning, false)]),
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

  // Contrôle d'appartenance. Sans lui, `isInitiator` valant faux pour un tiers,
  // celui-ci confirmait À LA PLACE du partenaire. Les boutons portent bien un
  // `ownerId`, ce qui rendait la faille inatteignable depuis l'interface — mais
  // c'était la seule barrière, et elle n'est pas du ressort de cette couche.
  if (trade.initiatorId !== userId && trade.partnerId !== userId) return undefined;

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

/**
 * Change le statut d'un échange.
 *
 * Quand `by` est renseigné (annulation par un joueur), l'auteur doit être partie
 * à l'échange : autrement, connaître un identifiant suffisait à annuler
 * l'échange de deux inconnus.
 */
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
    .where(
      and(
        eq(trades.id, tradeId),
        eq(trades.status, 'pending'),
        ...(by ? [or(eq(trades.initiatorId, by), eq(trades.partnerId, by))!] : []),
      ),
    );
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
