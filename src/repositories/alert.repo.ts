import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { itemsConfig, priceAlerts, users } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/**
 * Alertes de prix : lecture et écriture, aucune règle de jeu. La condition de
 * déclenchement, les bornes de seuil et la résolution d'identifiant court sont
 * dans `game/alerts.ts` ; l'orchestration dans `services/alert.service.ts`.
 */

export type PriceAlertRow = typeof priceAlerts.$inferSelect;

export async function createAlert(
  values: Omit<typeof priceAlerts.$inferInsert, 'id'>,
  executor: Executor = getDb(),
): Promise<PriceAlertRow> {
  const [row] = await executor
    .insert(priceAlerts)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function countActiveAlerts(userId: string, executor: Executor = getDb()): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(priceAlerts)
    .where(and(eq(priceAlerts.userId, userId), eq(priceAlerts.status, 'active')));
  return row?.count ?? 0;
}

export async function listActiveAlerts(userId: string, executor: Executor = getDb()) {
  return executor
    .select({
      alert: priceAlerts,
      itemName: itemsConfig.name,
      itemEmoji: itemsConfig.emoji,
    })
    .from(priceAlerts)
    .innerJoin(itemsConfig, eq(itemsConfig.key, priceAlerts.itemKey))
    .where(and(eq(priceAlerts.userId, userId), eq(priceAlerts.status, 'active')))
    .orderBy(asc(priceAlerts.createdAt));
}

/**
 * Alertes actives d'un joueur dont l'identifiant commence par `prefix`.
 *
 * `prefix` est de l'hexadécimal minuscule déjà validé par le service — donc
 * sans `%` ni `_` — et passe en paramètre lié : ni injection, ni joker
 * involontaire. La comparaison sur `id::text` ne peut pas s'appuyer sur la clé
 * primaire, mais la recherche est restreinte au propriétaire par l'index
 * (user_id, status) : quelques lignes au plus, jamais toute la table.
 */
export async function findActiveAlertsByPrefix(
  userId: string,
  prefix: string,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      alert: priceAlerts,
      itemName: itemsConfig.name,
      itemEmoji: itemsConfig.emoji,
    })
    .from(priceAlerts)
    .innerJoin(itemsConfig, eq(itemsConfig.key, priceAlerts.itemKey))
    .where(
      and(
        eq(priceAlerts.userId, userId),
        eq(priceAlerts.status, 'active'),
        sql`${priceAlerts.id}::text LIKE ${`${prefix}%`}`,
      ),
    );
}

/** Annulation par le propriétaire ; `status = 'active'` rend l'opération idempotente. */
export async function cancelAlert(
  alertId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(priceAlerts)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(priceAlerts.id, alertId),
        eq(priceAlerts.userId, userId),
        eq(priceAlerts.status, 'active'),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

/** Passe en `expired` toutes les alertes actives dont l'échéance est dépassée. */
export async function expireDueAlerts(now: Date, executor: Executor = getDb()): Promise<number> {
  const result = await executor
    .update(priceAlerts)
    .set({ status: 'expired' })
    .where(and(eq(priceAlerts.status, 'active'), lte(priceAlerts.expiresAt, now)));
  return result.rowCount ?? 0;
}

/**
 * Toutes les alertes actives, avec la locale de leur propriétaire : le nom de
 * l'objet dans la notification doit être dans la langue du joueur, et il est
 * figé au moment de la mise en file (le worker de MP ne relit que des clés).
 */
export async function listAllActiveAlerts(executor: Executor = getDb()) {
  return executor
    .select({ alert: priceAlerts, locale: users.locale })
    .from(priceAlerts)
    .innerJoin(users, eq(users.id, priceAlerts.userId))
    .where(eq(priceAlerts.status, 'active'))
    .orderBy(asc(priceAlerts.createdAt));
}

/**
 * Déclenchement conditionnel : `WHERE status = 'active'` garantit qu'une
 * alerte ne part qu'une fois même si deux passages du job se chevauchent —
 * le second voit zéro ligne modifiée et n'envoie rien.
 */
export async function markAlertTriggered(
  alertId: string,
  price: number,
  now: Date,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(priceAlerts)
    .set({ status: 'triggered', triggeredAt: now, triggeredPrice: price })
    .where(and(eq(priceAlerts.id, alertId), eq(priceAlerts.status, 'active')));
  return (result.rowCount ?? 0) > 0;
}
