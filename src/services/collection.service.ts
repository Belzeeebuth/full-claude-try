import { getConfig } from '../config';
import type { AnimalVariant, DiscoveryKind } from '../config/gameplay/schemas';
import type { Executor } from '../db/client';
import {
  DISCOVERY_KINDS,
  collectionProgress,
  collectionUniverse,
  countRareVariants,
  discoveryKindForCategory,
  indexDiscoveries,
  paginateCollection,
  variantEntryKey,
  type CollectionPage,
  type DiscoveryRecord,
} from '../game/collection';
import * as collectionRepo from '../repositories/collection.repo';
import type { Quality } from '../repositories/inventory.repo';
import { mergeResults, trackAction, type TrackResult } from './tracker.service';

/**
 * Collection du fermier : enregistrement des découvertes et lecture paginée.
 *
 * L'enregistrement est appelé DANS la transaction de l'action qui produit
 * l'objet ou la bête (récolte, collecte, pêche, mine, artisanat, achat ou
 * naissance d'un animal) : si l'action est annulée, la découverte l'est
 * aussi. Une PREMIÈRE découverte alimente `trackAction('discover_entry')`,
 * donc les succès de collection ; un cumul ne fait que compter.
 *
 * Ce service ne dépend pas de `inventory.service` — c'est l'inverse : c'est
 * `addItems` qui l'appelle. L'importer ici créerait un cycle.
 */

export interface DiscoveryContext {
  userId: string;
  coopId?: string | null;
  /**
   * Niveau du joueur, s'il est connu. `trackAction` l'exige dans son contexte
   * mais ne le lit pas pour `discover_entry` (aucun objectif de coopérative,
   * aucun jeton d'événement) : `addItems`, qui ne connaît que l'identifiant,
   * peut l'omettre sans requête supplémentaire.
   */
  level?: number;
}

interface PendingDiscovery {
  kind: DiscoveryKind;
  entryKey: string;
  count: number;
  bestQuality: Quality | null;
  bestVariant: AnimalVariant | null;
}

const QUALITY_RANK: Record<Quality, number> = { normal: 0, silver: 1, gold: 2, iridium: 3 };

/** Écrit un lot de découvertes et suit chaque première fois. */
async function recordAll(
  context: DiscoveryContext,
  pending: Iterable<PendingDiscovery>,
  tx: Executor,
): Promise<TrackResult> {
  const results: TrackResult[] = [];
  const trackContext = { userId: context.userId, coopId: context.coopId, level: context.level ?? 0 };
  for (const entry of pending) {
    const { inserted } = await collectionRepo.upsertDiscovery(
      { userId: context.userId, ...entry },
      tx,
    );
    if (inserted) {
      results.push(await trackAction(trackContext, 'discover_entry', 1, { kind: entry.kind }, tx));
    }
  }
  return mergeResults(results);
}

/**
 * Découvertes portées par un ajout d'inventaire.
 *
 * Les entrées sont AGRÉGÉES par (famille, clé) avant l'écriture : une récolte
 * de soixante parcelles arrive en piles par qualité, et soixante UPSERT dans
 * la transaction qui tient déjà le verrou du joueur seraient un coût pour
 * rien — une pile de blé argent et une pile de blé normal font une seule
 * ligne « blé, ×n, meilleur : argent ».
 */
export async function recordItemDiscoveries(
  context: DiscoveryContext,
  entries: ReadonlyArray<{ itemKey: string; quantity: number; quality?: Quality }>,
  tx: Executor,
): Promise<TrackResult> {
  const config = getConfig();
  const pending = new Map<string, PendingDiscovery>();
  for (const entry of entries) {
    if (entry.quantity <= 0) continue;
    const item = config.items.get(entry.itemKey);
    if (!item) continue;
    const kind = discoveryKindForCategory(item.category);
    if (!kind) continue;
    const quality = entry.quality ?? 'normal';
    const mapKey = `${kind}|${item.key}`;
    const existing = pending.get(mapKey);
    if (existing) {
      existing.count += entry.quantity;
      if (QUALITY_RANK[quality] > QUALITY_RANK[existing.bestQuality ?? 'normal']) {
        existing.bestQuality = quality;
      }
    } else {
      pending.set(mapKey, {
        kind,
        entryKey: item.key,
        count: entry.quantity,
        bestQuality: quality,
        bestVariant: null,
      });
    }
  }
  return recordAll(context, pending.values(), tx);
}

/**
 * Découverte d'une bête qui entre dans le cheptel (achat, naissance) : l'espèce
 * toujours, plus une entrée de variante si elle est rare. `best_variant` de
 * l'espèce garde la meilleure variante vue de cette espèce.
 */
export async function recordAnimalDiscovery(
  context: DiscoveryContext,
  animalKey: string,
  variant: AnimalVariant,
  tx: Executor,
): Promise<TrackResult> {
  const config = getConfig();
  if (!config.animals.has(animalKey)) return mergeResults([]);
  const pending: PendingDiscovery[] = [
    { kind: 'animal', entryKey: animalKey, count: 1, bestQuality: null, bestVariant: variant },
  ];
  if (variant !== 'normal') {
    pending.push({
      kind: 'variant',
      entryKey: variantEntryKey(animalKey, variant),
      count: 1,
      bestQuality: null,
      bestVariant: variant,
    });
  }
  return recordAll(context, pending, tx);
}

// ---------------------------------------------------------------------------
// LECTURE
// ---------------------------------------------------------------------------

export interface CollectionView extends CollectionPage {
  /** Progression de chaque famille, dans l'ordre de `DISCOVERY_KINDS`. */
  totals: Array<{ kind: DiscoveryKind; discovered: number; total: number }>;
  /** Variantes rares découvertes, toutes espèces confondues. */
  rare: { shiny: number; golden: number };
}

function toRecord(row: collectionRepo.DiscoveryRow): DiscoveryRecord {
  return {
    entryKey: row.entryKey,
    count: row.count,
    firstAt: row.firstAt,
    bestQuality: row.bestQuality,
    bestVariant: row.bestVariant,
  };
}

/**
 * Page de collection d'un joueur. Une seule lecture SQL (toutes les
 * découvertes, quelques centaines de lignes au plus) suffit à la page ET aux
 * totaux du pied de page : l'univers vient de la configuration localisée.
 */
export async function getCollection(
  userId: string,
  input: { kind: DiscoveryKind; page: number },
  locale?: string,
): Promise<CollectionView> {
  const config = getConfig(locale);
  const rows = await collectionRepo.listDiscoveries(userId);
  const byKind = new Map<DiscoveryKind, DiscoveryRecord[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind) ?? [];
    list.push(toRecord(row));
    byKind.set(row.kind, list);
  }

  const totals = DISCOVERY_KINDS.map((kind) => ({
    kind,
    ...collectionProgress(
      collectionUniverse(config, kind),
      indexDiscoveries(byKind.get(kind) ?? []),
    ),
  }));

  const page = paginateCollection(
    input.kind,
    collectionUniverse(config, input.kind),
    indexDiscoveries(byKind.get(input.kind) ?? []),
    input.page,
  );

  return { ...page, totals, rare: countRareVariants(byKind.get('variant') ?? []) };
}
