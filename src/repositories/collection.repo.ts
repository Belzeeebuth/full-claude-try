import { and, asc, eq, sql } from 'drizzle-orm';
import type { AnimalVariant, DiscoveryKind } from '../config/gameplay/schemas';
import { getDb, type Executor } from '../db/client';
import { discoveries } from '../db/schema';
import type { Quality } from './inventory.repo';

/**
 * Collection du fermier : lecture et UPSERT de `discoveries`, aucune règle
 * de jeu. Le service décide QUOI enregistrer (quelle famille, quelle clé) ;
 * ce dépôt ne sait que compter et garder le meilleur exemplaire.
 */

export type DiscoveryRow = typeof discoveries.$inferSelect;

export interface DiscoveryUpsert {
  userId: string;
  kind: DiscoveryKind;
  entryKey: string;
  /** Unités obtenues par cette action (≥ 1). */
  count: number;
  bestQuality?: Quality | null;
  bestVariant?: AnimalVariant | null;
  now?: Date;
}

/**
 * Enregistre une obtention : crée la ligne à la première fois, sinon cumule
 * le compteur et relève `best_*`. Une seule requête, atomique — deux récoltes
 * simultanées du même joueur ne peuvent pas se perdre l'une l'autre.
 *
 * `GREATEST` sur les colonnes énumérées compare par ORDRE DE DÉCLARATION du
 * type (normal < silver < gold < iridium ; normal < shiny < golden), et
 * ignore NULL : une ligne sans qualité connue prend la première venue.
 *
 * `inserted` (via `xmax = 0`, l'astuce PostgreSQL usuelle : une ligne juste
 * insérée n'a pas de transaction de suppression) dit si c'est une PREMIÈRE
 * découverte — c'est ce qui déclenche succès et annonce, pas le cumul.
 */
export async function upsertDiscovery(
  input: DiscoveryUpsert,
  executor: Executor,
): Promise<{ inserted: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await executor
    .insert(discoveries)
    .values({
      userId: input.userId,
      kind: input.kind,
      entryKey: input.entryKey,
      firstAt: now,
      count: Math.max(1, Math.floor(input.count)),
      bestQuality: input.bestQuality ?? null,
      bestVariant: input.bestVariant ?? null,
    })
    .onConflictDoUpdate({
      target: [discoveries.userId, discoveries.kind, discoveries.entryKey],
      set: {
        count: sql`${discoveries.count} + excluded.count`,
        bestQuality: sql`GREATEST(${discoveries.bestQuality}, excluded.best_quality)`,
        bestVariant: sql`GREATEST(${discoveries.bestVariant}, excluded.best_variant)`,
      },
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { inserted: row?.inserted === true };
}

/** Découvertes d'un joueur, toutes familles ou une seule, par ancienneté. */
export async function listDiscoveries(
  userId: string,
  options: { kind?: DiscoveryKind } = {},
  executor: Executor = getDb(),
): Promise<DiscoveryRow[]> {
  const conditions = [eq(discoveries.userId, userId)];
  if (options.kind) conditions.push(eq(discoveries.kind, options.kind));
  return executor
    .select()
    .from(discoveries)
    .where(and(...conditions))
    .orderBy(asc(discoveries.firstAt), asc(discoveries.entryKey));
}
