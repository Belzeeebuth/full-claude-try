import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  auditLogs,
  guildSettings,
  notifications,
  scheduledTasks,
  seasons,
  users,
  weather,
} from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Météo, saisons, notifications, tâches planifiées, audit, config serveur. */

export type WeatherRow = typeof weather.$inferSelect;

export async function getWeatherForDay(
  day: string,
  executor: Executor = getDb(),
): Promise<WeatherRow | undefined> {
  const [row] = await executor.select().from(weather).where(eq(weather.day, day)).limit(1);
  return row;
}

/**
 * Insère la météo du jour si elle n'existe pas encore, et renvoie la ligne
 * effective. `ON CONFLICT DO NOTHING` + relecture : si deux shards tirent la
 * météo en même temps, un seul gagne et les deux voient le même résultat.
 */
export async function ensureWeather(
  values: typeof weather.$inferInsert,
  executor: Executor = getDb(),
): Promise<WeatherRow> {
  await executor.insert(weather).values(values).onConflictDoNothing({ target: weather.day });
  const row = await getWeatherForDay(values.day as string, executor);
  return row!;
}

export async function overrideWeather(
  day: string,
  patch: Partial<typeof weather.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.update(weather).set(patch).where(eq(weather.day, day));
}

export async function recentWeather(days: number, executor: Executor = getDb()) {
  return executor.select().from(weather).orderBy(desc(weather.day)).limit(days);
}

// ---------------------------------------------------------------------------
// Saisons
// ---------------------------------------------------------------------------

export async function upsertSeason(
  values: typeof seasons.$inferInsert,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.insert(seasons).values(values).onConflictDoNothing({ target: seasons.key });
}

export async function setActiveSeason(key: string, executor: Executor = getDb()): Promise<void> {
  await executor.update(seasons).set({ active: false }).where(eq(seasons.active, true));
  await executor.update(seasons).set({ active: true }).where(eq(seasons.key, key));
}

export async function getActiveSeason(executor: Executor = getDb()) {
  const [row] = await executor.select().from(seasons).where(eq(seasons.active, true)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function enqueueNotification(
  values: Omit<typeof notifications.$inferInsert, 'id'>,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .insert(notifications)
    .values(values)
    .onConflictDoNothing({ target: notifications.dedupeKey });
  return (result.rowCount ?? 0) > 0;
}

export async function claimPendingNotifications(
  now: Date,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select({
      notification: notifications,
      discordId: users.discordId,
      locale: users.locale,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        eq(notifications.delivered, false),
        lte(notifications.deliverAt, now),
        lte(notifications.attempts, 3),
      ),
    )
    .orderBy(asc(notifications.deliverAt))
    .limit(limit);
}

export async function markNotificationDelivered(
  id: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notifications)
    .set({ delivered: true, deliveredAt: new Date() })
    .where(eq(notifications.id, id));
}

export async function markNotificationFailed(
  id: number,
  error: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notifications)
    .set({ attempts: sql`${notifications.attempts} + 1`, lastError: error.slice(0, 500) })
    .where(eq(notifications.id, id));
}

export async function countNotificationsToday(
  userId: string,
  since: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), gte(notifications.createdAt, since)));
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Tâches planifiées
// ---------------------------------------------------------------------------

export async function registerTask(
  values: Omit<typeof scheduledTasks.$inferInsert, 'id'>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .insert(scheduledTasks)
    .values(values)
    .onConflictDoUpdate({
      target: scheduledTasks.taskKey,
      set: { runAt: values.runAt, cron: values.cron, payload: values.payload, updatedAt: new Date() },
    });
}

/**
 * Réclame une tâche due, avec verrou coopératif.
 * Le `WHERE status = 'pending'` combiné au `RETURNING` fait office de
 * « compare-and-swap » : un seul shard peut passer une tâche en `running`.
 */
export async function claimTask(
  taskKey: string,
  workerId: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(scheduledTasks)
    .set({ status: 'running', lockedBy: workerId, lockedAt: now, startedAt: now, updatedAt: now })
    .where(
      and(
        eq(scheduledTasks.taskKey, taskKey),
        eq(scheduledTasks.status, 'pending'),
        lte(scheduledTasks.runAt, now),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

export async function completeTask(
  taskKey: string,
  outcome: { durationMs: number; nextRunAt?: Date; error?: string },
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(scheduledTasks)
    .set({
      status: outcome.error ? 'failed' : outcome.nextRunAt ? 'pending' : 'done',
      completedAt: new Date(),
      durationMs: outcome.durationMs,
      lastError: outcome.error?.slice(0, 500) ?? null,
      attempts: outcome.error ? sql`${scheduledTasks.attempts} + 1` : 0,
      lockedBy: null,
      lockedAt: null,
      ...(outcome.nextRunAt ? { runAt: outcome.nextRunAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.taskKey, taskKey));
}

export async function listTasks(executor: Executor = getDb()) {
  return executor.select().from(scheduledTasks).orderBy(asc(scheduledTasks.runAt));
}

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------

export async function audit(
  entry: Omit<typeof auditLogs.$inferInsert, 'id'>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.insert(auditLogs).values(entry);
}

export async function listAuditForTarget(
  targetDiscordId: string,
  limit: number,
  executor: Executor = getDb(),
) {
  return executor
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.targetDiscordId, targetDiscordId))
    .orderBy(desc(auditLogs.id))
    .limit(limit);
}

export async function listRecentAudit(limit: number, executor: Executor = getDb()) {
  return executor.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit);
}

// ---------------------------------------------------------------------------
// Configuration par serveur Discord
// ---------------------------------------------------------------------------

export type GuildSettingsRow = typeof guildSettings.$inferSelect;

export async function getGuildSettings(
  discordGuildId: string,
  executor: Executor = getDb(),
): Promise<GuildSettingsRow | undefined> {
  const [row] = await executor
    .select()
    .from(guildSettings)
    .where(eq(guildSettings.discordGuildId, discordGuildId))
    .limit(1);
  return row;
}

export async function ensureGuildSettings(
  discordGuildId: string,
  data: { name?: string; memberCount?: number; locale?: string },
  executor: Executor = getDb(),
): Promise<GuildSettingsRow> {
  await executor
    .insert(guildSettings)
    .values({
      id: uuidv7(),
      discordGuildId,
      name: data.name,
      memberCount: data.memberCount,
      locale: data.locale ?? 'fr',
    })
    .onConflictDoUpdate({
      target: guildSettings.discordGuildId,
      set: { name: data.name, memberCount: data.memberCount, leftAt: null, updatedAt: new Date() },
    });
  const row = await getGuildSettings(discordGuildId, executor);
  return row!;
}

export async function updateGuildSettings(
  discordGuildId: string,
  patch: Partial<typeof guildSettings.$inferInsert>,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(guildSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(guildSettings.discordGuildId, discordGuildId));
}

export async function markGuildLeft(
  discordGuildId: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(guildSettings)
    .set({ leftAt: new Date(), updatedAt: new Date() })
    .where(eq(guildSettings.discordGuildId, discordGuildId));
}

/** Compteurs globaux pour `/admin stats` et `/metrics`. */
export async function globalCounts(executor: Executor = getDb()): Promise<{
  users: number;
  activeToday: number;
  guilds: number;
}> {
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await executor
    .select({
      users: sql<number>`count(*)::int`,
      activeToday: sql<number>`count(*) FILTER (WHERE ${users.lastSeenAt} >= ${since})::int`,
    })
    .from(users);
  const [guilds] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(guildSettings)
    .where(sql`${guildSettings.leftAt} IS NULL`);

  return {
    users: row?.users ?? 0,
    activeToday: row?.activeToday ?? 0,
    guilds: guilds?.count ?? 0,
  };
}
