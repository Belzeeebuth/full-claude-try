import { randomUUID } from 'node:crypto';
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
/** Propriétaire du verrou mémoire, même rôle que la valeur de la clé Redis. */
const memoryLockOwners = new Map<string, string>();

/**
 * Libération PROPRIÉTAIRE, en Lua pour rester atomique.
 *
 * Un `DEL` inconditionnel est le piège classique du verrou distribué : si
 * l'action dépasse le TTL, le verrou expire, une deuxième exécution le reprend,
 * puis la première termine et supprime le verrou de la seconde — les deux
 * tournent alors en parallèle, ce qui est exactement ce que le verrou devait
 * empêcher. Ce n'est pas théorique ici : `command.execute()` tourne DANS le
 * verrou et englobe le rendu d'image, dont le seuil dur dépasse le TTL par
 * défaut. On ne supprime donc la clé que si elle porte encore notre jeton.
 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export class LockBusyError extends Error {
  constructor(public readonly lockKey: string) {
    super(`Action already running: ${lockKey}`);
    this.name = 'LockBusyError';
  }
}

function lockKeyFor(userId: string, action: string): string {
  return key('lock', action, userId);
}

async function acquire(lockKey: string, ttlMs: number, token: string): Promise<boolean> {
  try {
    const result = await getRedis().set(lockKey, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (error) {
    log.warn({ err: error, lockKey }, 'Redis indisponible, verrou en mémoire');
    const now = Date.now();
    const existing = memoryLocks.get(lockKey);
    if (existing && existing > now) return false;
    memoryLocks.set(lockKey, now + ttlMs);
    memoryLockOwners.set(lockKey, token);
    return true;
  }
}

async function release(lockKey: string, token: string): Promise<void> {
  if (memoryLockOwners.get(lockKey) === token) {
    memoryLocks.delete(lockKey);
    memoryLockOwners.delete(lockKey);
  }
  try {
    await getRedis().eval(RELEASE_SCRIPT, 1, lockKey, token);
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
  // 30 s et non 15 : le TTL n'est qu'un filet en cas de crash, il ne doit
  // jamais expirer sous une action encore vivante. `command.execute()` tourne
  // dans ce verrou et englobe le rendu, dont le seuil dur vaut déjà 20 s.
  ttlMs = 30_000,
): Promise<T> {
  const lockKey = lockKeyFor(userId, action);
  const token = randomUUID();
  const acquired = await acquire(lockKey, ttlMs, token);
  if (!acquired) throw new LockBusyError(action);
  try {
    return await fn();
  } finally {
    await release(lockKey, token);
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

/**
 * Rend une marque d'idempotence posée par `claimOnce` quand l'opération qu'elle
 * protégeait a finalement échoué.
 *
 * Sans cela, une transaction de paiement en échec après un `claimOnce` réussi
 * laisse la marque en place : la récompense est perdue pour toute la fenêtre,
 * et l'appelant a déjà acquitté l'appel entrant — personne n'en saura rien.
 * Réservé au chemin d'ERREUR : sur le chemin nominal, la marque doit rester.
 */
export async function releaseOnce(token: string): Promise<void> {
  const idempotencyKey = key('once', token);
  memoryLocks.delete(idempotencyKey);
  try {
    await getRedis().del(idempotencyKey);
  } catch (error) {
    log.warn({ err: error, token }, 'idempotence : libération impossible');
  }
}

/** Purge les verrous mémoire expirés (appelé par le scheduler toutes les 5 min). */
export function pruneMemoryLocks(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [lockKey, expiresAt] of memoryLocks) {
    if (expiresAt <= now) {
      memoryLocks.delete(lockKey);
      memoryLockOwners.delete(lockKey);
      pruned += 1;
    }
  }
  return pruned;
}
