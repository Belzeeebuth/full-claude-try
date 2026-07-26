import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  bankAccounts,
  economySnapshots,
  itemsConfig,
  marketPriceHistory,
  marketPrices,
  shopStock,
  transactions,
  users,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Monnaie, journal comptable, marché et boutique.
 *
 * RÈGLE ABSOLUE : toute variation de solde passe par `creditCoins` /
 * `debitCoins` (ou leurs équivalents gemmes), qui écrivent la ligne de journal
 * dans la MÊME requête SQL que la mise à jour du solde. Il est donc impossible
 * de créer de la monnaie sans trace, et `SUM(transactions.amount)` doit toujours
 * égaler le solde — c'est vérifié par le job d'audit économique.
 */

export type TransactionType = (typeof transactions.$inferSelect)['type'];
export type Currency = 'coins' | 'gems';

export interface LedgerEntry {
  userId: string;
  type: TransactionType;
  currency?: Currency;
  amount: number;
  itemKey?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  counterpartyId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  discordGuildId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Crédite un joueur et journalise l'opération.
 * `RETURNING` nous donne le solde après opération sans requête supplémentaire.
 */
export async function credit(
  entry: LedgerEntry & { amount: number },
  executor: Executor,
): Promise<number> {
  const amount = Math.trunc(entry.amount);
  if (amount <= 0) throw new Error(`credit() attend un montant positif, reçu ${amount}`);
  const currency: Currency = entry.currency ?? 'coins';
  const column = currency === 'coins' ? users.coins : users.gems;

  const [row] = await executor
    .update(users)
    .set({
      ...(currency === 'coins'
        ? {
            coins: sql`${users.coins} + ${amount}`,
            totalCoinsEarned: sql`${users.totalCoinsEarned} + ${amount}`,
          }
        : { gems: sql`${users.gems} + ${amount}` }),
      updatedAt: new Date(),
    })
    .where(eq(users.id, entry.userId))
    .returning({ balance: column });

  if (!row) throw new Error(`joueur introuvable : ${entry.userId}`);

  await writeLedger({ ...entry, currency, amount, balanceAfter: row.balance }, executor);
  return row.balance;
}

/**
 * Débite un joueur si — et seulement si — son solde le permet.
 * Le `WHERE coins >= amount` rend l'opération atomique : deux achats simultanés
 * ne peuvent pas passer tous les deux avec le même argent. Renvoie `null` en cas
 * de fonds insuffisants, sans rien modifier.
 */
export async function debit(
  entry: LedgerEntry & { amount: number },
  executor: Executor,
): Promise<number | null> {
  const amount = Math.trunc(entry.amount);
  if (amount <= 0) throw new Error(`debit() attend un montant positif, reçu ${amount}`);
  const currency: Currency = entry.currency ?? 'coins';
  const column = currency === 'coins' ? users.coins : users.gems;

  const [row] = await executor
    .update(users)
    .set({
      ...(currency === 'coins'
        ? {
            coins: sql`${users.coins} - ${amount}`,
            totalCoinsSpent: sql`${users.totalCoinsSpent} + ${amount}`,
          }
        : { gems: sql`${users.gems} - ${amount}` }),
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, entry.userId), gte(column, amount)))
    .returning({ balance: column });

  if (!row) return null;

  await writeLedger(
    { ...entry, currency, amount: -amount, balanceAfter: row.balance },
    executor,
  );
  return row.balance;
}

/**
 * Écrit une ligne de journal SANS toucher au solde.
 * Réservé au cas « genèse » : la création d'un joueur pose son solde de départ
 * directement dans `INSERT INTO users`, il faut donc la ligne comptable
 * correspondante pour que `SUM(transactions) = users.coins` reste vrai dès la
 * première seconde. Tout autre usage serait un bug.
 */
export async function recordGenesisLedger(
  entry: LedgerEntry & { amount: number; balanceAfter: number },
  executor: Executor,
): Promise<void> {
  await writeLedger({ ...entry, currency: entry.currency ?? 'coins' }, executor);
}

async function writeLedger(
  entry: LedgerEntry & { amount: number; balanceAfter: number; currency: Currency },
  executor: Executor,
): Promise<void> {
  await executor.insert(transactions).values({
    userId: entry.userId,
    type: entry.type,
    currency: entry.currency,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    itemKey: entry.itemKey ?? null,
    quantity: entry.quantity ?? null,
    unitPrice: entry.unitPrice ?? null,
    counterpartyId: entry.counterpartyId ?? null,
    referenceType: entry.referenceType ?? null,
    referenceId: entry.referenceId ?? null,
    discordGuildId: entry.discordGuildId ?? null,
    metadata: entry.metadata ?? null,
  });
}

export async function listTransactions(
  userId: string,
  limit = 20,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(desc(transactions.id))
    .limit(limit);
}

/** Total versé/reçu par type sur une fenêtre — base du suivi anti-inflation. */
export async function sumByType(
  since: Date,
  executor: Executor = getDb(),
): Promise<Array<{ type: string; total: number }>> {
  const rows = await executor
    .select({
      type: transactions.type,
      total: sql<number>`COALESCE(SUM(${transactions.amount}), 0)::bigint`,
    })
    .from(transactions)
    .where(and(gte(transactions.createdAt, since), eq(transactions.currency, 'coins')))
    .groupBy(transactions.type);
  return rows.map((row) => ({ type: row.type, total: Number(row.total) }));
}

/** Total offert par un joueur aujourd'hui (plafond anti-blanchiment). */
export async function giftedToday(
  userId: string,
  since: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COALESCE(SUM(ABS(${transactions.amount})), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'gift_out'),
        gte(transactions.createdAt, since),
      ),
    );
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Banque
// ---------------------------------------------------------------------------

export async function lockBankAccount(tx: Executor, userId: string) {
  const [row] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.userId, userId))
    .limit(1)
    .for('update');
  return row;
}

export async function updateBankBalance(
  userId: string,
  delta: number,
  executor: Executor,
): Promise<number | null> {
  const [row] = await executor
    .update(bankAccounts)
    .set({
      balance: sql`${bankAccounts.balance} + ${delta}`,
      ...(delta > 0
        ? { totalDeposited: sql`${bankAccounts.totalDeposited} + ${delta}` }
        : { totalWithdrawn: sql`${bankAccounts.totalWithdrawn} + ${Math.abs(delta)}` }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bankAccounts.userId, userId),
        delta < 0
          ? gte(bankAccounts.balance, Math.abs(delta))
          : sql`${bankAccounts.balance} + ${delta} <= ${bankAccounts.capacity}`,
      ),
    )
    .returning({ balance: bankAccounts.balance });
  return row?.balance ?? null;
}

export async function upgradeBankTier(
  userId: string,
  tier: { tier: number; capacity: number; interestRate: number; interestCap: number },
  executor: Executor,
): Promise<void> {
  await executor
    .update(bankAccounts)
    .set({
      tier: tier.tier,
      capacity: tier.capacity,
      interestRate: tier.interestRate.toFixed(4),
      interestCap: tier.interestCap,
      updatedAt: new Date(),
    })
    .where(eq(bankAccounts.userId, userId));
}

/** Comptes éligibles aux intérêts (job quotidien). */
export async function findAccountsForInterest(
  before: Date,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(bankAccounts)
    .where(and(lte(bankAccounts.lastInterestAt, before), sql`${bankAccounts.balance} > 0`))
    .limit(limit);
}

export async function applyInterest(
  accountId: string,
  amount: number,
  now: Date,
  executor: Executor,
): Promise<void> {
  await executor
    .update(bankAccounts)
    .set({
      balance: sql`LEAST(${bankAccounts.balance} + ${amount}, ${bankAccounts.capacity})`,
      totalInterest: sql`${bankAccounts.totalInterest} + ${amount}`,
      lastInterestAt: now,
      updatedAt: now,
    })
    .where(eq(bankAccounts.id, accountId));
}

// ---------------------------------------------------------------------------
// Marché
// ---------------------------------------------------------------------------

export type MarketPriceRow = typeof marketPrices.$inferSelect;

export async function getMarketPrice(
  itemKey: string,
  executor: Executor = getDb(),
): Promise<MarketPriceRow | undefined> {
  const [row] = await executor
    .select()
    .from(marketPrices)
    .where(eq(marketPrices.itemKey, itemKey))
    .limit(1);
  return row;
}

export async function getMarketPrices(
  itemKeys: string[],
  executor: Executor = getDb(),
): Promise<Map<string, MarketPriceRow>> {
  if (itemKeys.length === 0) return new Map();
  const rows = await executor
    .select()
    .from(marketPrices)
    .where(inArray(marketPrices.itemKey, itemKeys));
  return new Map(rows.map((row) => [row.itemKey, row]));
}

/** Marché complet enrichi (nom, emoji, rareté) pour `/marche`. */
export async function listMarket(
  options: { category?: string; limit?: number } = {},
  executor: Executor = getDb(),
) {
  const conditions = [eq(itemsConfig.marketTracked, true), eq(itemsConfig.enabled, true)];
  if (options.category) conditions.push(eq(itemsConfig.category, options.category as never));

  return executor
    .select({
      itemKey: marketPrices.itemKey,
      name: itemsConfig.name,
      emoji: itemsConfig.emoji,
      category: itemsConfig.category,
      rarity: itemsConfig.rarity,
      basePrice: marketPrices.basePrice,
      currentPrice: marketPrices.currentPrice,
      previousPrice: marketPrices.previousPrice,
      trend: marketPrices.trend,
      demandIndex: marketPrices.demandIndex,
      featured: marketPrices.featured,
      nextUpdateAt: marketPrices.nextUpdateAt,
    })
    .from(marketPrices)
    .innerJoin(itemsConfig, eq(itemsConfig.key, marketPrices.itemKey))
    .where(and(...conditions))
    .orderBy(asc(itemsConfig.sortOrder))
    .limit(options.limit ?? 200);
}

export async function recordSaleVolume(
  itemKey: string,
  quantity: number,
  executor: Executor,
): Promise<void> {
  await executor
    .update(marketPrices)
    .set({ volumeWindow: sql`${marketPrices.volumeWindow} + ${quantity}` })
    .where(eq(marketPrices.itemKey, itemKey));
}

export async function applyMarketUpdate(
  update: {
    itemKey: string;
    price: number;
    previousPrice: number;
    demandIndex: number;
    trend: number;
    volumeWindow: number;
  },
  nextUpdateAt: Date,
  executor: Executor,
): Promise<void> {
  const now = new Date();
  await executor
    .update(marketPrices)
    .set({
      currentPrice: update.price,
      previousPrice: update.previousPrice,
      demandIndex: update.demandIndex.toFixed(4),
      trend: update.trend.toFixed(4),
      volumeWindow: update.volumeWindow,
      updatedAt: now,
      nextUpdateAt,
    })
    .where(eq(marketPrices.itemKey, update.itemKey));

  await executor.insert(marketPriceHistory).values({
    itemKey: update.itemKey,
    price: update.price,
    demandIndex: update.demandIndex.toFixed(4),
    volume: update.volumeWindow,
    recordedAt: now,
  });
}

export async function setFeatured(
  itemKeys: string[],
  executor: Executor,
): Promise<void> {
  await executor.update(marketPrices).set({ featured: false });
  if (itemKeys.length > 0) {
    await executor
      .update(marketPrices)
      .set({ featured: true })
      .where(inArray(marketPrices.itemKey, itemKeys));
  }
}

export async function priceHistory(
  itemKey: string,
  points: number,
  executor: Executor = getDb(),
): Promise<Array<{ price: number; recordedAt: Date; demandIndex: string }>> {
  const rows = await executor
    .select({
      price: marketPriceHistory.price,
      recordedAt: marketPriceHistory.recordedAt,
      demandIndex: marketPriceHistory.demandIndex,
    })
    .from(marketPriceHistory)
    .where(eq(marketPriceHistory.itemKey, itemKey))
    .orderBy(desc(marketPriceHistory.recordedAt))
    .limit(points);
  return rows.reverse();
}

export async function purgeOldHistory(before: Date, executor: Executor = getDb()): Promise<number> {
  const result = await executor
    .delete(marketPriceHistory)
    .where(lte(marketPriceHistory.recordedAt, before));
  return result.rowCount ?? 0;
}

export async function upsertMarketPrice(
  values: typeof marketPrices.$inferInsert,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .insert(marketPrices)
    .values(values)
    .onConflictDoUpdate({
      target: marketPrices.itemKey,
      set: { basePrice: values.basePrice, referenceVolume: values.referenceVolume },
    });
}

// ---------------------------------------------------------------------------
// Boutique quotidienne
// ---------------------------------------------------------------------------

export type ShopStockRow = typeof shopStock.$inferSelect;

export async function listShopStock(
  rotationDate: string,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      id: shopStock.id,
      itemKey: shopStock.itemKey,
      name: itemsConfig.name,
      emoji: itemsConfig.emoji,
      category: shopStock.category,
      rarity: itemsConfig.rarity,
      price: shopStock.price,
      currency: shopStock.currency,
      discountPercent: shopStock.discountPercent,
      stockTotal: shopStock.stockTotal,
      stockRemaining: shopStock.stockRemaining,
      perUserLimit: shopStock.perUserLimit,
      requiredLevel: shopStock.requiredLevel,
      featured: shopStock.featured,
      expiresAt: shopStock.expiresAt,
      description: itemsConfig.description,
    })
    .from(shopStock)
    .innerJoin(itemsConfig, eq(itemsConfig.key, shopStock.itemKey))
    .where(eq(shopStock.rotationDate, rotationDate))
    .orderBy(desc(shopStock.featured), asc(itemsConfig.sortOrder));
}

/**
 * Réserve du stock de façon atomique.
 * Le `WHERE stock_remaining >= quantity` garantit qu'on ne vend jamais plus que
 * le stock, même si 200 joueurs cliquent sur le même article dans la même
 * seconde. Renvoie `false` si le stock est insuffisant.
 */
export async function reserveShopStock(
  shopStockId: string,
  quantity: number,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(shopStock)
    .set({ stockRemaining: sql`${shopStock.stockRemaining} - ${quantity}`, updatedAt: new Date() })
    .where(and(eq(shopStock.id, shopStockId), gte(shopStock.stockRemaining, quantity)));
  return (result.rowCount ?? 0) > 0;
}

export async function insertShopStock(
  rows: Array<typeof shopStock.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  if (rows.length === 0) return;
  await executor.insert(shopStock).values(rows).onConflictDoNothing();
}

export async function purgeOldShopStock(before: string, executor: Executor = getDb()): Promise<number> {
  const result = await executor.delete(shopStock).where(lte(shopStock.rotationDate, before));
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Instantanés économiques
// ---------------------------------------------------------------------------

export async function captureEconomySnapshot(
  since: Date,
  executor: Executor = getDb(),
): Promise<typeof economySnapshots.$inferSelect> {
  const [totals] = await executor
    .select({
      totalCoins: sql<number>`COALESCE(SUM(${users.coins}), 0)::bigint`,
      totalGems: sql<number>`COALESCE(SUM(${users.gems}), 0)::bigint`,
      totalUsers: sql<number>`COUNT(*)::int`,
      active24h: sql<number>`COUNT(*) FILTER (WHERE ${users.lastSeenAt} >= ${since})::int`,
    })
    .from(users);

  const [bank] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${bankAccounts.balance}), 0)::bigint` })
    .from(bankAccounts);

  const [flows] = await executor
    .select({
      created: sql<number>`COALESCE(SUM(${transactions.amount}) FILTER (WHERE ${transactions.amount} > 0), 0)::bigint`,
      destroyed: sql<number>`COALESCE(SUM(ABS(${transactions.amount})) FILTER (WHERE ${transactions.amount} < 0), 0)::bigint`,
    })
    .from(transactions)
    .where(and(gte(transactions.createdAt, since), eq(transactions.currency, 'coins')));

  const topItems = await executor
    .select({
      itemKey: transactions.itemKey,
      volume: sql<number>`COALESCE(SUM(${transactions.quantity}), 0)::int`,
    })
    .from(transactions)
    .where(and(gte(transactions.createdAt, since), sql`${transactions.itemKey} IS NOT NULL`))
    .groupBy(transactions.itemKey)
    .orderBy(desc(sql`SUM(${transactions.quantity})`))
    .limit(10);

  const [row] = await executor
    .insert(economySnapshots)
    .values({
      totalCoins: Number(totals?.totalCoins ?? 0),
      totalBankCoins: Number(bank?.total ?? 0),
      totalGems: Number(totals?.totalGems ?? 0),
      coinsCreated: Number(flows?.created ?? 0),
      coinsDestroyed: Number(flows?.destroyed ?? 0),
      activeUsers24h: totals?.active24h ?? 0,
      totalUsers: totals?.totalUsers ?? 0,
      topItems,
    })
    .returning();

  return row!;
}

export async function lastEconomySnapshots(limit: number, executor: Executor = getDb()) {
  return executor
    .select()
    .from(economySnapshots)
    .orderBy(desc(economySnapshots.capturedAt))
    .limit(limit);
}

/** Détecte un écart entre le solde d'un joueur et son journal (anti-triche). */
export async function findLedgerMismatches(limit: number, executor: Executor = getDb()) {
  const rows = await executor.execute<{
    user_id: string;
    coins: string;
    ledger: string;
  }>(sql`
    SELECT u.id AS user_id, u.coins::text AS coins, COALESCE(SUM(t.amount), 0)::text AS ledger
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id AND t.currency = 'coins'
    GROUP BY u.id, u.coins
    HAVING u.coins <> COALESCE(SUM(t.amount), 0)
    LIMIT ${limit}
  `);
  return rows.rows.map((row) => ({
    userId: row.user_id,
    coins: Number(row.coins),
    ledger: Number(row.ledger),
  }));
}

/** Identifiant unique de référence, pour lier une transaction à un objet métier. */
export function reference(type: string): { referenceType: string; referenceId: string } {
  return { referenceType: type, referenceId: uuidv7() };
}
