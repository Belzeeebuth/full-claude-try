import Redis, { type Redis as RedisClient } from 'ioredis';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('redis');

/**
 * Trois connexions Redis distinctes, volontairement :
 *  - `client`   : cache, cooldowns, verrous, ZSET de classement ;
 *  - `subscriber` : pub/sub inter-shards (invalidation de cache, reload config) ;
 *  - `queue`    : réservée à BullMQ, qui exige `maxRetriesPerRequest: null` et
 *                 bloque des connexions entières sur `BRPOPLPUSH` — les mélanger
 *                 ferait expirer les requêtes de cache pendant qu'un worker attend.
 */
let client: RedisClient | undefined;
let subscriber: RedisClient | undefined;
let queueConnection: RedisClient | undefined;

function build(name: string, overrides: Record<string, unknown> = {}): RedisClient {
  const instance = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    connectionName: `harvestbot:${name}`,
    retryStrategy(times) {
      // 200 ms, 400 ms, 800 ms… plafonné à 10 s : on ne bombarde pas un Redis
      // qui redémarre, et on ne renonce jamais définitivement.
      const delay = Math.min(200 * 2 ** Math.min(times, 6), 10_000);
      if (times === 1 || times % 10 === 0) {
        log.warn({ times, delay, name }, 'reconnexion Redis');
      }
      return delay;
    },
    ...overrides,
  });

  instance.on('error', (error: Error) => {
    log.error({ err: error, name }, 'erreur Redis');
  });
  instance.on('ready', () => log.debug({ name }, 'connexion Redis prête'));

  return instance;
}

export function getRedis(): RedisClient {
  if (!client) client = build('main');
  return client;
}

export function getSubscriber(): RedisClient {
  if (!subscriber) subscriber = build('subscriber');
  return subscriber;
}

export function getQueueConnection(): RedisClient {
  if (!queueConnection) {
    queueConnection = build('queue', { maxRetriesPerRequest: null, enableReadyCheck: false });
  }
  return queueConnection;
}

/** Préfixe toutes les clés : plusieurs environnements peuvent partager un Redis. */
export function key(...parts: Array<string | number>): string {
  return [env.REDIS_PREFIX, ...parts].join(':');
}

export async function pingRedis(): Promise<number> {
  const started = Date.now();
  await getRedis().ping();
  return Date.now() - started;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled(
    [client, subscriber, queueConnection].map(async (instance) => instance?.quit()),
  );
  client = undefined;
  subscriber = undefined;
  queueConnection = undefined;
  log.info('connexions Redis fermées');
}

// ---------------------------------------------------------------------------
// Cache générique
// ---------------------------------------------------------------------------

/** Lit une valeur JSON du cache ; `undefined` si absente ou illisible. */
export async function cacheGet<T>(cacheKey: string): Promise<T | undefined> {
  try {
    const raw = await getRedis().get(cacheKey);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch (error) {
    // Le cache est un accélérateur, jamais une dépendance dure : en cas de
    // panne Redis, on dégrade en allant taper la base.
    log.warn({ err: error, cacheKey }, 'lecture cache échouée, repli sur la base');
    return undefined;
  }
}

export async function cacheSet(cacheKey: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(cacheKey, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
  } catch (error) {
    log.warn({ err: error, cacheKey }, 'écriture cache échouée');
  }
}

export async function cacheDelete(...cacheKeys: string[]): Promise<void> {
  if (cacheKeys.length === 0) return;
  try {
    await getRedis().del(...cacheKeys);
  } catch (error) {
    log.warn({ err: error }, 'invalidation cache échouée');
  }
}

/** Lecture-ou-calcul avec mémorisation. */
export async function cached<T>(
  cacheKey: string,
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(cacheKey);
  if (hit !== undefined) return hit;
  const value = await producer();
  await cacheSet(cacheKey, value, ttlSeconds);
  return value;
}
