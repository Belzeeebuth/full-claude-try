import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  bankAccounts,
  economySnapshots,
  itemsConfig,
  marketPriceHistory,
  marketPrices,
  shopPurchases,
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
 * Écrit une ligne de journal pour un solde posé DIRECTEMENT par un `INSERT` ou
 * un `UPDATE`, sans passer par `credit`/`debit`.
 *
 * Deux cas seulement, et pas un de plus :
 *  - la CRÉATION d'un joueur, dont le solde de départ vient de l'`INSERT` ;
 *  - le PRESTIGE, qui ramène le solde à une fraction de sa valeur.
 *
 * Dans les deux cas `amount` est la VARIATION du solde — négative au prestige,
 * qui détruit des pièces — et jamais le solde lui-même : c'est la somme des
 * variations que compare `SUM(transactions.amount) = users.coins`. Y écrire le
 * solde entier créait un écart permanent, signalé en boucle par l'audit horaire.
 */
export async function recordDirectBalanceLedger(
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
/**
 * Comptes éligibles aux intérêts (job quotidien).
 *
 * Le filtre porte sur un solde MINIMUM et non sur « > 0 » : un compte dont
 * l'intérêt s'arrondit à zéro était re-sélectionné chaque jour, en tête de tri,
 * et consommait indéfiniment la limite du lot. Passé quelques centaines de
 * petits comptes, plus personne ne touchait d'intérêts.
 */
export async function findAccountsForInterest(
  before: Date,
  limit: number,
  minimumBalance: number,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(bankAccounts)
    .where(
      and(
        lte(bankAccounts.lastInterestAt, before),
        gte(bankAccounts.balance, Math.max(1, minimumBalance)),
      ),
    )
    .orderBy(asc(bankAccounts.lastInterestAt))
    .limit(limit);
}

/** Repousse l'échéance sans verser d'intérêt (montant arrondi à zéro). */
export async function skipInterest(
  accountId: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(bankAccounts)
    .set({ lastInterestAt: now, updatedAt: now })
    .where(eq(bankAccounts.id, accountId));
}

/**
 * Verse les intérêts, plafonnés par la capacité du coffre.
 *
 * `total_interest` n'additionne que la part RÉELLEMENT créditée : additionner le
 * montant brut alors que le solde est écrêté par `LEAST` faisait diverger les
 * deux compteurs sur les comptes pleins.
 */
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
      totalInterest: sql`${bankAccounts.totalInterest} + GREATEST(0, LEAST(${amount}, ${bankAccounts.capacity} - ${bankAccounts.balance}))`,
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

/** Marché complet enrichi (nom, emoji, rareté) pour `/market`. */
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

/** Toutes les lignes de marché, avec les champs nécessaires au recalcul horaire. */
export async function listMarketPrices(
  executor: Executor = getDb(),
): Promise<MarketPriceRow[]> {
  return executor.select().from(marketPrices);
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

/**
 * Quantité déjà achetée par un joueur sur un article du jour.
 * Appelé sous le verrou de la ligne joueur (`lockUserRow` dans `buy()`), donc
 * la lecture puis l'écriture ne peuvent pas s'entrelacer pour un même joueur.
 */
export async function countUserPurchases(
  userId: string,
  shopStockId: string,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ quantity: shopPurchases.quantity })
    .from(shopPurchases)
    .where(and(eq(shopPurchases.userId, userId), eq(shopPurchases.shopStockId, shopStockId)))
    .limit(1);
  return row?.quantity ?? 0;
}

/** Incrémente le compteur d'achats du joueur pour cet article. */
export async function recordUserPurchase(
  userId: string,
  shopStockId: string,
  quantity: number,
  executor: Executor,
): Promise<void> {
  await executor
    .insert(shopPurchases)
    .values({ userId, shopStockId, quantity })
    .onConflictDoUpdate({
      target: [shopPurchases.userId, shopPurchases.shopStockId],
      set: {
        quantity: sql`${shopPurchases.quantity} + ${quantity}`,
        updatedAt: new Date(),
      },
    });
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

/** Nombre de joueurs au-dessus d'un seuil de suspicion (anti-triche). */
export async function countSuspiciousUsers(
  threshold: number,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(users)
    .where(gte(users.suspicionScore, threshold));
  return row?.count ?? 0;
}

/**
 * Complète un instantané déjà inséré avec les compteurs de santé (dérive du
 * journal, joueurs suspects). Séparé de `captureEconomySnapshot` car ces deux
 * comptages viennent d'un audit potentiellement plus coûteux (jointure sur
 * `transactions`), déjà effectué par ailleurs dans le même job.
 */
export async function recordSnapshotHealth(
  snapshotId: number,
  health: { ledgerMismatches: number; suspiciousUsers: number },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(economySnapshots)
    .set({
      ledgerMismatches: health.ledgerMismatches,
      suspiciousUsers: health.suspiciousUsers,
    })
    .where(eq(economySnapshots.id, snapshotId));
}

/**
 * Détecte un écart entre le solde d'un joueur et son journal (anti-triche).
 *
 * Borné aux joueurs ACTIFS récemment. La version précédente agrégeait toute la
 * table `transactions` — sans borne temporelle, chaque heure : le journal ne
 * faisant que croître, la requête finissait par dépasser `statement_timeout` et
 * l'audit s'arrêtait sans bruit, puisque le job attrape l'erreur. Un écart ne
 * peut de toute façon apparaître que sur un compte qui bouge, et l'index
 * `transactions_user_currency_idx` rend l'agrégation indexable par joueur.
 */
export async function findLedgerMismatches(
  limit: number,
  since: Date = new Date(Date.now() - 7 * 86_400_000),
  executor: Executor = getDb(),
) {
  const rows = await executor.execute<{
    user_id: string;
    coins: string;
    ledger: string;
  }>(sql`
    SELECT u.id AS user_id, u.coins::text AS coins, COALESCE(SUM(t.amount), 0)::text AS ledger
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id AND t.currency = 'coins'
    WHERE u.deleted_at IS NULL AND u.last_seen_at >= ${since}
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
