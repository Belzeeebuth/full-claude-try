import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { apiKeys } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Clés API : jamais de secret en clair en base, seulement son hachage. */

export async function insertApiKey(
  values: { userId: string; keyHash: string; keyPrefix: string; label: string },
  executor: Executor = getDb(),
) {
  const [row] = await executor
    .insert(apiKeys)
    .values({ id: uuidv7(), ...values })
    .returning();
  return row!;
}

export async function countActiveKeys(userId: string, executor: Executor = getDb()): Promise<number> {
  const rows = await executor
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  return rows.length;
}

export async function listActiveKeys(userId: string, executor: Executor = getDb()) {
  return executor
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

/** Résout une clé par son hachage — chemin chaud de chaque requête d'API authentifiée. */
export async function findActiveByHash(keyHash: string, executor: Executor = getDb()) {
  const [row] = await executor
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return row;
}

export async function touchLastUsed(id: string, executor: Executor = getDb()): Promise<void> {
  await executor.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

/** Révoque par préfixe (affiché à la création et dans `/apikey list`), jamais par hachage complet. */
export async function revokeByPrefix(
  userId: string,
  keyPrefix: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  const result = await executor
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.keyPrefix, keyPrefix),
        isNull(apiKeys.revokedAt),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}
