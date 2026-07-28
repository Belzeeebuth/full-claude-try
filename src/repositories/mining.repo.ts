import { eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { mineProgress } from '../db/schema';
import { uuidv7 } from '../utils/uuid';

/** Progression de mine : une ligne par joueur, créée paresseusement au premier `/mine`. */
export async function getOrCreateMineProgress(userId: string, executor: Executor = getDb()) {
  const [existing] = await executor
    .select()
    .from(mineProgress)
    .where(eq(mineProgress.userId, userId))
    .limit(1);
  if (existing) return existing;

  const [created] = await executor
    .insert(mineProgress)
    .values({ id: uuidv7(), userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Course perdue contre une insertion concurrente : la ligne existe désormais.
  const [row] = await executor
    .select()
    .from(mineProgress)
    .where(eq(mineProgress.userId, userId))
    .limit(1);
  return row!;
}

export async function advanceDepth(
  userId: string,
  depth: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(mineProgress)
    .set({
      currentDepth: depth,
      deepestReached: sql`GREATEST(${mineProgress.deepestReached}, ${depth})`,
      updatedAt: new Date(),
    })
    .where(eq(mineProgress.userId, userId));
}

export async function incrementOresMined(
  userId: string,
  amount: number,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(mineProgress)
    .set({
      totalOresMined: sql`${mineProgress.totalOresMined} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(mineProgress.userId, userId));
}
