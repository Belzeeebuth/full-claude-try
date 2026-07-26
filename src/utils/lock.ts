import { getRedis, key } from '../db/redis';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('lock');

/**
 * Verrou distribué court, base de l'anti-double-clic.
 *
 * Discord renvoie parfois deux fois la même interaction, et surtout un joueur
 * peut spammer « Récolter tout » : sans verrou, deux exécutions concurrentes
 * peuvent lire le même état et récolter deux fois. On prend un verrou par
 * (utilisateur, action) avec `SET NX PX`, opération atomique côté Redis.
 *
 * Le verrou est LIBÉRÉ à la fin de l'action, jamais laissé expirer : le TTL
 * n'est qu'un filet en cas de crash du process au milieu de l'action.
 *
 * Repli mémoire : si Redis est indisponible, on utilise une Map locale. En
 * mono-process c'est équivalent ; en sharding le risque résiduel est accepté
 * (une interaction d'un même joueur arrive toujours sur le même shard, car
 * Discord route par serveur et un joueur ne clique que sur un message à la fois).
 */

const memoryLocks = new Map<string, number>();

export class LockBusyError extends Error {
  constructor(public readonly lockKey: string) {
    super(`Action déjà en cours : ${lockKey}`);
    this.name = 'LockBusyError';
  }
}

function lockKeyFor(userId: string, action: string): string {
  return key('lock', action, userId);
}

async function acquire(lockKey: string, ttlMs: number): Promise<boolean> {
  try {
    const result = await getRedis().set(lockKey, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (error) {
    log.warn({ err: error, lockKey }, 'Redis indisponible, verrou en mémoire');
    const now = Date.now();
    const existing = memoryLocks.get(lockKey);
    if (existing && existing > now) return false;
    memoryLocks.set(lockKey, now + ttlMs);
    return true;
  }
}

async function release(lockKey: string): Promise<void> {
  memoryLocks.delete(lockKey);
  try {
    await getRedis().del(lockKey);
  } catch {
    /* le TTL fera le travail */
  }
}

/**
 * Exécute `fn` sous verrou exclusif. Lève `LockBusyError` si une autre exécution
 * est déjà en cours pour ce couple (utilisateur, action).
 */
export async function withUserLock<T>(
  userId: string,
  action: string,
  fn: () => Promise<T>,
  ttlMs = 15_000,
): Promise<T> {
  const lockKey = lockKeyFor(userId, action);
  const acquired = await acquire(lockKey, ttlMs);
  if (!acquired) throw new LockBusyError(action);
  try {
    return await fn();
  } finally {
    await release(lockKey);
  }
}

/**
 * Verrou d'idempotence : garantit qu'une opération identifiée par `token`
 * (custom_id d'interaction, id de webhook de vote…) n'est traitée qu'une fois,
 * même si Discord la relivre. Contrairement à `withUserLock`, la clé n'est PAS
 * libérée : elle expire naturellement.
 */
export async function claimOnce(token: string, ttlSeconds = 900): Promise<boolean> {
  const idempotencyKey = key('once', token);
  try {
    const result = await getRedis().set(idempotencyKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (error) {
    log.warn({ err: error, token }, 'idempotence : Redis indisponible, repli mémoire');
    const now = Date.now();
    const existing = memoryLocks.get(idempotencyKey);
    if (existing && existing > now) return false;
    memoryLocks.set(idempotencyKey, now + ttlSeconds * 1000);
    return true;
  }
}

/** Purge les verrous mémoire expirés (appelé par le scheduler toutes les 5 min). */
export function pruneMemoryLocks(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [lockKey, expiresAt] of memoryLocks) {
    if (expiresAt <= now) {
      memoryLocks.delete(lockKey);
      pruned += 1;
    }
  }
  return pruned;
}
