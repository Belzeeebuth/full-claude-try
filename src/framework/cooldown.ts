import { balance as getBalance } from '../config';
import { getRedis, key as redisKey } from '../db/redis';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('cooldown');

/**
 * Cooldowns et limitation de débit.
 *
 * Redis est la source de vérité : `SET NX PX` est atomique, donc deux
 * interactions simultanées ne peuvent pas passer toutes les deux. En cas de
 * panne Redis, on bascule sur une Map mémoire — un joueur pourrait alors
 * contourner un cooldown en changeant de shard, mais mieux vaut un bot
 * fonctionnel qu'un bot bloqué.
 *
 * Deux mécanismes distincts, souvent confondus :
 *  - COOLDOWN : par commande, pour espacer les actions de jeu (`/daily`) ;
 *  - RATE LIMIT : par joueur, toutes commandes confondues, pour protéger
 *    l'infrastructure d'un script qui spammerait 200 commandes/seconde.
 */

const memoryCooldowns = new Map<string, number>();
const memoryCounters = new Map<string, { count: number; resetAt: number }>();

export interface CooldownStatus {
  active: boolean;
  retryAt: Date;
  remainingMs: number;
}

function cooldownKey(userId: string, bucket: string): string {
  return redisKey('cd', bucket, userId);
}

/**
 * Tente de poser un cooldown. Renvoie `active: true` si le joueur doit patienter.
 * L'opération est une pose-si-absent : elle ne prolonge jamais un cooldown en cours.
 */
export async function checkAndSet(
  userId: string,
  bucket: string,
  seconds: number,
): Promise<CooldownStatus> {
  if (seconds <= 0) {
    return { active: false, retryAt: new Date(), remainingMs: 0 };
  }

  const cacheKey = cooldownKey(userId, bucket);
  const ttlMs = Math.round(seconds * 1_000);

  try {
    const redis = getRedis();
    const result = await redis.set(cacheKey, Date.now() + ttlMs, 'PX', ttlMs, 'NX');
    if (result === 'OK') {
      return { active: false, retryAt: new Date(Date.now() + ttlMs), remainingMs: 0 };
    }
    const remaining = await redis.pttl(cacheKey);
    const remainingMs = remaining > 0 ? remaining : 0;
    return {
      active: remainingMs > 0,
      retryAt: new Date(Date.now() + remainingMs),
      remainingMs,
    };
  } catch (error) {
    log.warn({ err: error, bucket }, 'Redis indisponible, cooldown en mémoire');
    const now = Date.now();
    const expiresAt = memoryCooldowns.get(cacheKey) ?? 0;
    if (expiresAt > now) {
      return { active: true, retryAt: new Date(expiresAt), remainingMs: expiresAt - now };
    }
    memoryCooldowns.set(cacheKey, now + ttlMs);
    return { active: false, retryAt: new Date(now + ttlMs), remainingMs: 0 };
  }
}

/** Consulte un cooldown sans le poser (affichage dans `/help`, `/daily`). */
export async function peek(userId: string, bucket: string): Promise<CooldownStatus> {
  const cacheKey = cooldownKey(userId, bucket);
  try {
    const remaining = await getRedis().pttl(cacheKey);
    const remainingMs = remaining > 0 ? remaining : 0;
    return { active: remainingMs > 0, retryAt: new Date(Date.now() + remainingMs), remainingMs };
  } catch {
    const expiresAt = memoryCooldowns.get(cacheKey) ?? 0;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    return { active: remainingMs > 0, retryAt: new Date(Date.now() + remainingMs), remainingMs };
  }
}

export async function clear(userId: string, bucket: string): Promise<void> {
  try {
    await getRedis().del(cooldownKey(userId, bucket));
  } catch {
    memoryCooldowns.delete(cooldownKey(userId, bucket));
  }
}

/** Cooldown configuré pour une commande (`balance.cooldowns`). */
export function cooldownSecondsFor(commandName: string): number {
  const cooldowns = getBalance().cooldowns;
  return cooldowns[commandName] ?? cooldowns.default ?? 0;
}

// ---------------------------------------------------------------------------
// Limitation de débit
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  limited: boolean;
  remaining: number;
  resetInMs: number;
}

/**
 * Compteur glissant par fenêtre fixe.
 * `INCR` + `EXPIRE` au premier appel : deux commandes Redis, coût négligeable,
 * et le compteur s'auto-nettoie.
 */
export async function consumeRate(
  userId: string,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const cacheKey = redisKey('rate', scope, userId);

  try {
    const redis = getRedis();
    const count = await redis.incr(cacheKey);
    if (count === 1) {
      await redis.expire(cacheKey, windowSeconds);
    }
    const ttl = await redis.ttl(cacheKey);
    return {
      limited: count > limit,
      remaining: Math.max(0, limit - count),
      resetInMs: Math.max(0, ttl) * 1_000,
    };
  } catch {
    const now = Date.now();
    const entry = memoryCounters.get(cacheKey);
    if (!entry || entry.resetAt <= now) {
      memoryCounters.set(cacheKey, { count: 1, resetAt: now + windowSeconds * 1_000 });
      return { limited: false, remaining: limit - 1, resetInMs: windowSeconds * 1_000 };
    }
    entry.count += 1;
    return {
      limited: entry.count > limit,
      remaining: Math.max(0, limit - entry.count),
      resetInMs: Math.max(0, entry.resetAt - now),
    };
  }
}

/** Limitation globale par joueur, appliquée à chaque interaction. */
export async function checkGlobalRate(userId: string): Promise<RateLimitResult> {
  const limits = getBalance().rateLimit;
  const perMinute = await consumeRate(userId, 'cmd:m', limits.commandsPerMinute, 60);
  if (perMinute.limited) return perMinute;
  return consumeRate(userId, 'cmd:h', limits.commandsPerHour, 3_600);
}

/** Nettoyage périodique des structures mémoire de secours. */
export function pruneMemory(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [entryKey, expiresAt] of memoryCooldowns) {
    if (expiresAt <= now) {
      memoryCooldowns.delete(entryKey);
      pruned += 1;
    }
  }
  for (const [entryKey, entry] of memoryCounters) {
    if (entry.resetAt <= now) {
      memoryCounters.delete(entryKey);
      pruned += 1;
    }
  }
  return pruned;
}
