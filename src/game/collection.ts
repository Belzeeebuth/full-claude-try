import type { GameConfig } from '../config';
import { discoveryKinds, type AnimalVariant, type DiscoveryKind } from '../config/gameplay/schemas';
import type { Quality } from './quality';

/**
 * Collection du fermier (`/collection`) : la partie PURE.
 *
 * Une collection, c'est un UNIVERS (tout ce qui existe dans une famille :
 * les 41 cultures, les 24 espèces…) confronté aux DÉCOUVERTES du joueur
 * (`discoveries` en base). Tout ce qui est décidable sans base vit ici —
 * construction de l'univers depuis la configuration, progression, masquage
 * des entrées inconnues, pagination — pour que `/collection` se teste comme
 * une règle de jeu et que le service ne fasse que brancher la lecture SQL.
 *
 * L'univers vient de `getConfig()` et non de la base : c'est la configuration
 * qui dit ce qui existe, la table `discoveries` ne dit que ce qui a été vu.
 * Une entrée retirée de la configuration disparaît donc de l'univers sans
 * fausser la progression (« 41/41 » et non « 41/42 »).
 */

export const DISCOVERY_KINDS: readonly DiscoveryKind[] = discoveryKinds;

/**
 * Douze entrées par page : avec deux lignes de tête et un pied de page, une
 * page tient dans un embed sans défilement sur mobile, et une collection de
 * 72 produits reste à six pages — parcourable au bouton.
 */
export const COLLECTION_PAGE_SIZE = 12;

/** Variantes qui comptent comme une entrée de collection à part entière. */
export const RARE_VARIANTS: readonly AnimalVariant[] = ['shiny', 'golden'];

/** Nom affiché à la place d'une entrée jamais obtenue. */
export const HIDDEN_NAME = '???';

export interface CollectionEntry {
  kind: DiscoveryKind;
  /** Clé stockée dans `discoveries.entry_key`. */
  key: string;
  name: string;
  emoji: string;
  rarity: string;
  /** Niveau requis, la seule chose qu'on révèle d'une entrée inconnue. */
  requiredLevel: number;
  sortOrder: number;
  /** Renseigné pour la famille `variant` seulement. */
  variant: AnimalVariant | null;
}

/** Ce que la base sait d'une entrée déjà obtenue. */
export interface DiscoveryRecord {
  entryKey: string;
  count: number;
  firstAt: Date;
  bestQuality: Quality | null;
  bestVariant: AnimalVariant | null;
}

export interface CollectionLine {
  entry: CollectionEntry;
  /** `null` tant que l'entrée n'a jamais été obtenue. */
  discovered: DiscoveryRecord | null;
}

export interface CollectionPage {
  kind: DiscoveryKind;
  page: number;
  totalPages: number;
  lines: CollectionLine[];
  discovered: number;
  total: number;
}

export function isDiscoveryKind(value: unknown): value is DiscoveryKind {
  return typeof value === 'string' && (DISCOVERY_KINDS as readonly string[]).includes(value);
}

/** Famille demandée par une option ou un bouton ; les cultures par défaut. */
export function normalizeKind(value: string | null | undefined): DiscoveryKind {
  return isDiscoveryKind(value) ? value : 'crop';
}

/**
 * Famille de collection d'un objet d'inventaire, d'après sa catégorie.
 *
 * Seul ce que le joueur PRODUIT compte : graines, outils, consommables,
 * matériaux et cosmétiques ne sont pas des découvertes — on ne « découvre »
 * pas un arrosoir acheté en boutique.
 */
export function discoveryKindForCategory(category: string): DiscoveryKind | null {
  switch (category) {
    case 'harvest':
      return 'crop';
    case 'animal_product':
    case 'product':
      return 'product';
    case 'fish':
      return 'fish';
    case 'ore':
      return 'ore';
    default:
      return null;
  }
}

/** Clé d'entrée d'une variante : `<espèce>:<variante>` (le `:` est interdit dans une clé de config). */
export function variantEntryKey(animalKey: string, variant: AnimalVariant): string {
  return `${animalKey}:${variant}`;
}

/** Inverse de `variantEntryKey` ; `null` si la clé n'a pas cette forme. */
export function parseVariantEntryKey(
  entryKey: string,
): { animalKey: string; variant: AnimalVariant } | null {
  const separator = entryKey.lastIndexOf(':');
  if (separator <= 0) return null;
  const animalKey = entryKey.slice(0, separator);
  const variant = entryKey.slice(separator + 1);
  return RARE_VARIANTS.includes(variant as AnimalVariant)
    ? { animalKey, variant: variant as AnimalVariant }
    : null;
}

/**
 * Univers d'une famille, dans l'ordre d'affichage : niveau requis croissant
 * (le prochain déblocage est toujours en tête de la zone grise), puis l'ordre
 * de la configuration, puis la clé pour rester stable.
 */
export function collectionUniverse(config: GameConfig, kind: DiscoveryKind): CollectionEntry[] {
  const entries: CollectionEntry[] = [];
  switch (kind) {
    case 'crop':
      for (const crop of config.cropList) {
        if (!crop.enabled) continue;
        entries.push({
          kind,
          key: crop.key,
          name: crop.name,
          emoji: crop.emoji,
          rarity: crop.rarity,
          requiredLevel: crop.requiredLevel,
          sortOrder: crop.sortOrder,
          variant: null,
        });
      }
      break;
    case 'product':
    case 'fish':
    case 'ore':
      for (const item of config.itemList) {
        if (!item.enabled || discoveryKindForCategory(item.category) !== kind) continue;
        entries.push({
          kind,
          key: item.key,
          name: item.name,
          emoji: item.emoji,
          rarity: item.rarity,
          requiredLevel: item.requiredLevel,
          sortOrder: item.sortOrder,
          variant: null,
        });
      }
      break;
    case 'animal':
      for (const animal of config.animalList) {
        if (!animal.enabled) continue;
        entries.push({
          kind,
          key: animal.key,
          name: animal.name,
          emoji: animal.emoji,
          rarity: animal.rarity,
          requiredLevel: animal.requiredLevel,
          sortOrder: animal.sortOrder,
          variant: null,
        });
      }
      break;
    case 'variant':
      // Une entrée par espèce × variante rare : la poule shiny et la poule
      // dorée sont deux trouvailles distinctes, chacune avec sa case.
      for (const animal of config.animalList) {
        if (!animal.enabled) continue;
        for (const variant of RARE_VARIANTS) {
          entries.push({
            kind,
            key: variantEntryKey(animal.key, variant),
            name: animal.name,
            emoji: animal.emoji,
            rarity: animal.rarity,
            requiredLevel: animal.requiredLevel,
            sortOrder: animal.sortOrder,
            variant,
          });
        }
      }
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown collection kind: ${String(exhaustive)}`);
    }
  }
  return entries.sort(
    (a, b) =>
      a.requiredLevel - b.requiredLevel ||
      a.sortOrder - b.sortOrder ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * Progression sur un univers. Seules les entrées de l'univers comptent : une
 * découverte orpheline (contenu retiré de la configuration) n'est ni comptée
 * ni affichée, pour ne jamais montrer « 42/41 ».
 */
export function collectionProgress(
  universe: readonly CollectionEntry[],
  discoveries: ReadonlyMap<string, DiscoveryRecord>,
): { discovered: number; total: number } {
  let discovered = 0;
  for (const entry of universe) {
    if (discoveries.has(entry.key)) discovered += 1;
  }
  return { discovered, total: universe.length };
}

export function pageCount(total: number, pageSize = COLLECTION_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** Ramène une page demandée (option, bouton périmé) dans les bornes réelles. */
export function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), Math.max(1, totalPages));
}

export function paginateCollection(
  kind: DiscoveryKind,
  universe: readonly CollectionEntry[],
  discoveries: ReadonlyMap<string, DiscoveryRecord>,
  page: number,
  pageSize = COLLECTION_PAGE_SIZE,
): CollectionPage {
  const totalPages = pageCount(universe.length, pageSize);
  const current = clampPage(page, totalPages);
  const start = (current - 1) * pageSize;
  const lines = universe.slice(start, start + pageSize).map((entry) => ({
    entry,
    discovered: discoveries.get(entry.key) ?? null,
  }));
  const progress = collectionProgress(universe, discoveries);
  return { kind, page: current, totalPages, lines, ...progress };
}

/**
 * Nom affiché d'une entrée : le vrai nom une fois obtenue, `???` sinon.
 * L'emoji est masqué avec le nom — un « 🐉 ??? » ne cache rien.
 */
export function maskedName(entry: CollectionEntry, discovered: boolean): string {
  return discovered ? entry.name : HIDDEN_NAME;
}

/** Nombre de variantes rares découvertes, par variante, sur la famille `variant`. */
export function countRareVariants(
  discoveries: Iterable<DiscoveryRecord>,
): Record<'shiny' | 'golden', number> {
  const counts = { shiny: 0, golden: 0 };
  for (const record of discoveries) {
    const parsed = parseVariantEntryKey(record.entryKey);
    if (parsed && (parsed.variant === 'shiny' || parsed.variant === 'golden')) {
      counts[parsed.variant] += 1;
    }
  }
  return counts;
}

/** Indexe des découvertes par clé d'entrée, pour les fonctions ci-dessus. */
export function indexDiscoveries(
  records: Iterable<DiscoveryRecord>,
): Map<string, DiscoveryRecord> {
  const map = new Map<string, DiscoveryRecord>();
  for (const record of records) map.set(record.entryKey, record);
  return map;
}
