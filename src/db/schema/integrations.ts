import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './core';
import { webhookEventStatusEnum } from './enums';

/**
 * ---------------------------------------------------------------------------
 * API PUBLIQUE ET WEBHOOKS (v3.2)
 * ---------------------------------------------------------------------------
 * Le secret n'est JAMAIS stocké en clair : `keyHash`/`secret` sont ce qui
 * transite en base, la valeur brute n'existant que le temps de la réponse à
 * `/apikey create` — exactement le même principe qu'un token Discord ou un
 * mot de passe, même si l'entropie d'un jeton généré rend un hachage rapide
 * (SHA-256) suffisant, contrairement à un mot de passe choisi par l'humain.
 */

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    /** 8 premiers caractères du jeton, pour que le joueur reconnaisse SA clé sans qu'on la reconserve. */
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    label: varchar('label', { length: 48 }).notNull().default('default'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId, t.revokedAt),
  ],
);

export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** Secret HMAC : signe chaque livraison (en-tête `X-Harvester-Signature`) pour que le destinataire vérifie l'origine. */
    secret: varchar('secret', { length: 64 }).notNull(),
    /** Types d'évènements souscrits, ex. `["crop_ready","auction_won"]`. */
    events: jsonb('events').notNull().default(sql`'[]'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    lastStatus: varchar('last_status', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_subscriptions_user_idx').on(t.userId),
    check('webhook_subscriptions_failures_range', sql`${t.consecutiveFailures} BETWEEN 0 AND 100`),
  ],
);

/** File d'attente de livraison : découple la détection d'un évènement de jeu de l'appel HTTP sortant. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: webhookEventStatusEnum('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('webhook_events_pending_idx').on(t.status, t.createdAt),
    index('webhook_events_subscription_idx').on(t.subscriptionId, t.createdAt.desc()),
    check('webhook_events_attempts_range', sql`${t.attempts} BETWEEN 0 AND 10`),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
