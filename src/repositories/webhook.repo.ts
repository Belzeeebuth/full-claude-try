import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { webhookEvents, webhookSubscriptions } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

export async function insertSubscription(
  values: { userId: string; url: string; secret: string; events: string[] },
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .insert(webhookSubscriptions)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function countSubscriptions(userId: string, executor: Executor = getDb()): Promise<number> {
  const rows = await executor
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, userId));
  return rows.length;
}

export async function listSubscriptions(userId: string, executor: Executor = getDb()) {
  return executor
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, userId))
    .orderBy(desc(webhookSubscriptions.createdAt));
}

export async function findSubscription(userId: string, id: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)))
    .limit(1);
  return row;
}

export async function deleteSubscription(
  userId: string,
  id: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .delete(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.userId, userId)));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Abonnements actifs d'un joueur pour un type d'évènement.
 * Le filtre sur `events` (JSONB) se fait en mémoire : la table reste petite
 * (quelques abonnements par joueur, plafonnés par `balance.api.maxWebhooksPerUser`),
 * un index JSONB serait une optimisation prématurée.
 */
export async function findEnabledSubscriptionsForEvent(
  userId: string,
  eventType: string,
  executor: Executor = getDb(),
) {
  const rows = await executor
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.userId, userId), eq(webhookSubscriptions.enabled, true)));
  return rows.filter((row) => (row.events as string[]).includes(eventType));
}

export async function enqueueEvent(
  values: { subscriptionId: string; eventType: string; payload: unknown },
  executor: Executor = getDb(),
): Promise<void> {
  await executor.insert(webhookEvents).values(values);
}

/** Livraisons en attente, une tentative unique chacune (voir `webhook.service.ts`). */
export async function claimPendingEvents(limit: number, executor: Executor = getDb()) {
  return executor
    .select({ event: webhookEvents, subscription: webhookSubscriptions })
    .from(webhookEvents)
    .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookEvents.subscriptionId))
    .where(eq(webhookEvents.status, 'pending'))
    .orderBy(webhookEvents.createdAt)
    .limit(limit);
}

export async function markEventDelivered(id: number, executor: Executor = getDb()): Promise<void> {
  await executor
    .update(webhookEvents)
    .set({ status: 'delivered', deliveredAt: new Date(), attempts: 1 })
    .where(eq(webhookEvents.id, id));
}

export async function markEventFailed(id: number, error: string, executor: Executor = getDb()): Promise<void> {
  await executor
    .update(webhookEvents)
    .set({ status: 'failed', attempts: 1, lastError: error.slice(0, 500) })
    .where(eq(webhookEvents.id, id));
}

/** Après chaque tentative : remet le compteur d'échecs à zéro, ou l'incrémente. */
export async function recordDeliveryOutcome(
  subscriptionId: string,
  ok: boolean,
  executor: Executor = getDb(),
): Promise<{ consecutiveFailures: number }> {
  const [row] = await executor
    .update(webhookSubscriptions)
    .set(
      ok
        ? { lastDeliveryAt: new Date(), lastStatus: 'ok', consecutiveFailures: 0 }
        : {
            lastDeliveryAt: new Date(),
            lastStatus: 'failed',
            consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`,
          },
    )
    .where(eq(webhookSubscriptions.id, subscriptionId))
    .returning({ consecutiveFailures: webhookSubscriptions.consecutiveFailures });
  return { consecutiveFailures: row?.consecutiveFailures ?? 0 };
}

export async function disableSubscription(id: string, executor: Executor = getDb()): Promise<void> {
  await executor.update(webhookSubscriptions).set({ enabled: false }).where(eq(webhookSubscriptions.id, id));
}
