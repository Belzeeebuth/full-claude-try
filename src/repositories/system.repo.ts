import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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

/** Une réservation abandonnée (process tué en plein envoi) redevient libre. */
const CLAIM_STALE_MS = 5 * 60_000;

export interface ClaimedNotification {
  notification: {
    id: number;
    userId: string;
    type: string;
    title: string | null;
    body: string | null;
    payload: unknown;
  };
  discordId: string;
  locale: string;
}

/**
 * RÉSERVE des notifications à distribuer, au lieu de simplement les lire.
 *
 * La distribution des MP est un `setInterval` présent sur chaque shard — elle ne
 * passe pas par BullMQ, qui dédoublonne les crons. Une simple lecture faisait
 * donc envoyer le même message par tous les shards, et un lot plus lent que
 * l'intervalle le faisait renvoyer par le tick suivant du même process.
 *
 * `FOR UPDATE SKIP LOCKED` sur la sous-requête donne à chaque appelant un lot
 * disjoint ; `claimed_at` protège au-delà de la transaction, et expire au bout
 * de `CLAIM_STALE_MS` pour qu'un process mort ne bloque pas la file.
 *
 * La jointure porte sur `picked.user_id`, PAS sur `n.user_id` : dans un
 * `UPDATE … FROM`, la clause `FROM` ne peut pas référencer la table cible. La
 * requête était rejetée à l'exécution (42P01) — invisible à la relecture comme à
 * la compilation, d'où le test d'intégration qui l'accompagne.
 */
export async function claimPendingNotifications(
  now: Date,
  limit: number,
  claimedBy: string,
  executor: Executor = getDb(),
): Promise<ClaimedNotification[]> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);

  const result = await executor.execute<{
    id: string;
    user_id: string;
    type: string;
    title: string | null;
    body: string | null;
    payload: unknown;
    discord_id: string;
    locale: string;
  }>(sql`
    UPDATE notifications AS n
       SET claimed_at = ${now}, claimed_by = ${claimedBy}
      FROM (
             SELECT id, user_id
               FROM notifications
              WHERE delivered = false
                AND deliver_at <= ${now}
                AND attempts <= 3
                AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
              ORDER BY deliver_at
              LIMIT ${limit}
                FOR UPDATE SKIP LOCKED
           ) AS picked
      JOIN users AS u ON u.id = picked.user_id
     WHERE n.id = picked.id
 RETURNING n.id, n.user_id, n.type, n.title, n.body, n.payload,
           u.discord_id, u.locale
  `);

  return result.rows.map((row) => ({
    notification: {
      id: Number(row.id),
      userId: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      payload: row.payload,
    },
    discordId: row.discord_id,
    locale: row.locale,
  }));
}

/** Libère une réservation sans marquer la notification délivrée (erreur transitoire). */
export async function releaseNotificationClaim(
  id: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(notifications)
    .set({ claimedAt: null, claimedBy: null })
    .where(eq(notifications.id, id));
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

/**
 * Compte les notifications du jour pour un LOT de joueurs, en une requête.
 * Le worker appliquait le plafond quotidien avec un `COUNT` par notification :
 * un lot de 20 coûtait 20 allers-retours pour une information agrégeable.
 */
export async function countNotificationsTodayFor(
  userIds: string[],
  since: Date,
  executor: Executor = getDb(),
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await executor
    .select({ userId: notifications.userId, count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(inArray(notifications.userId, userIds), gte(notifications.createdAt, since)))
    .groupBy(notifications.userId);
  return new Map(rows.map((row) => [row.userId, row.count]));
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
