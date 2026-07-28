import { and, eq } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { ownedPets, users } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Compagnons de ferme : purement cosmétiques (voir `game/pets.ts`). */

export async function listOwnedPetKeys(userId: string, executor: Executor = getDb()): Promise<string[]> {
  const rows = await executor
    .select({ petKey: ownedPets.petKey })
    .from(ownedPets)
    .where(eq(ownedPets.userId, userId));
  return rows.map((row) => row.petKey);
}

/** Idempotent : débloquer un compagnon déjà possédé ne fait rien. */
export async function unlockPet(userId: string, petKey: string, executor: Executor = getDb()): Promise<void> {
  await executor
    .insert(ownedPets)
    .values({ id: uuidv7(), userId, petKey })
    .onConflictDoNothing();
}

export async function isPetOwned(userId: string, petKey: string, executor: Executor = getDb()): Promise<boolean> {
  const [row] = await executor
    .select({ id: ownedPets.id })
    .from(ownedPets)
    .where(and(eq(ownedPets.userId, userId), eq(ownedPets.petKey, petKey)))
    .limit(1);
  return row !== undefined;
}

export async function setEquippedPet(
  userId: string,
  petKey: string | null,
  executor: Executor = getDb(),
): Promise<void> {
  await executor.update(users).set({ equippedPetKey: petKey }).where(eq(users.id, userId));
}
