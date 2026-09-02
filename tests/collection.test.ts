import { describe, expect, it } from 'vitest';
import { formatCollectionLine, KIND_EMOJI, rarityDot } from '../src/commands/collection';
import { getConfig } from '../src/config';
import { discoveryKinds } from '../src/config/gameplay/schemas';
import {
  COLLECTION_PAGE_SIZE,
  HIDDEN_NAME,
  clampPage,
  collectionProgress,
  collectionUniverse,
  countRareVariants,
  discoveryKindForCategory,
  indexDiscoveries,
  maskedName,
  normalizeKind,
  pageCount,
  paginateCollection,
  parseVariantEntryKey,
  variantEntryKey,
  type DiscoveryRecord,
} from '../src/game/collection';
import { loadMergedCatalog, translate, translatorFor } from '../src/i18n';
import { buildCustomId } from '../src/utils/custom-id';

/**
 * Collection du fermier : univers, progression, masquage, pagination —
 * la partie pure de `/collection`, plus le formatage d'une ligne et la
 * cohérence des succès `discover_entry` avec le contenu.
 */

const config = getConfig('fr');

function record(entryKey: string, overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    entryKey,
    count: 1,
    firstAt: new Date('2026-06-01T12:00:00Z'),
    bestQuality: null,
    bestVariant: null,
    ...overrides,
  };
}

describe('univers de collection', () => {
  it('les cultures : une entrée par culture active, sans doublon', () => {
    const universe = collectionUniverse(config, 'crop');
    const enabled = config.cropList.filter((crop) => crop.enabled);
    expect(universe.length).toBe(enabled.length);
    expect(new Set(universe.map((entry) => entry.key)).size).toBe(universe.length);
    expect(universe.every((entry) => entry.variant === null)).toBe(true);
  });

  it('les familles d’objets se répartissent par catégorie, sans se recouvrir', () => {
    const product = collectionUniverse(config, 'product').map((entry) => entry.key);
    const fish = collectionUniverse(config, 'fish').map((entry) => entry.key);
    const ore = collectionUniverse(config, 'ore').map((entry) => entry.key);
    expect(product.length).toBeGreaterThan(0);
    expect(fish.length).toBeGreaterThan(0);
    expect(ore.length).toBeGreaterThan(0);
    expect(new Set([...product, ...fish, ...ore]).size).toBe(product.length + fish.length + ore.length);
    for (const key of product) {
      expect(['product', 'animal_product']).toContain(config.items.get(key)?.category);
    }
  });

  it('les variantes : deux entrées (shiny, dorée) par espèce', () => {
    const animals = collectionUniverse(config, 'animal');
    const variants = collectionUniverse(config, 'variant');
    expect(variants.length).toBe(animals.length * 2);
    expect(variants.filter((entry) => entry.variant === 'shiny').length).toBe(animals.length);
    expect(variants.filter((entry) => entry.variant === 'golden').length).toBe(animals.length);
    expect(variants.every((entry) => parseVariantEntryKey(entry.key) !== null)).toBe(true);
  });

  it('trie par niveau requis puis ordre de configuration : le prochain déblocage vient en premier', () => {
    for (const kind of discoveryKinds) {
      const universe = collectionUniverse(config, kind);
      for (let index = 1; index < universe.length; index += 1) {
        const previous = universe[index - 1]!;
        const current = universe[index]!;
        expect(
          previous.requiredLevel < current.requiredLevel ||
            (previous.requiredLevel === current.requiredLevel && previous.sortOrder <= current.sortOrder),
          `${kind}: ${previous.key} avant ${current.key}`,
        ).toBe(true);
      }
    }
  });

  it('les clés de variante font ≤ 64 caractères (largeur de `entry_key`)', () => {
    for (const entry of collectionUniverse(config, 'variant')) {
      expect(entry.key.length).toBeLessThanOrEqual(64);
    }
  });

  it('seul ce que le joueur produit est une découverte', () => {
    expect(discoveryKindForCategory('harvest')).toBe('crop');
    expect(discoveryKindForCategory('animal_product')).toBe('product');
    expect(discoveryKindForCategory('product')).toBe('product');
    expect(discoveryKindForCategory('fish')).toBe('fish');
    expect(discoveryKindForCategory('ore')).toBe('ore');
    for (const category of ['seed', 'tool', 'consumable', 'material', 'cosmetic', 'event', 'nope']) {
      expect(discoveryKindForCategory(category), category).toBeNull();
    }
  });

  it('clé de variante : aller-retour, et refus des formes invalides', () => {
    expect(variantEntryKey('chicken', 'shiny')).toBe('chicken:shiny');
    expect(parseVariantEntryKey('chicken:golden')).toEqual({ animalKey: 'chicken', variant: 'golden' });
    expect(parseVariantEntryKey('chicken:normal')).toBeNull();
    expect(parseVariantEntryKey('chicken')).toBeNull();
    expect(parseVariantEntryKey(':shiny')).toBeNull();
  });

  it('normalise la famille demandée, les cultures par défaut', () => {
    expect(normalizeKind('animal')).toBe('animal');
    expect(normalizeKind('bogus')).toBe('crop');
    expect(normalizeKind(null)).toBe('crop');
    expect(normalizeKind(undefined)).toBe('crop');
  });
});

describe('progression et masquage', () => {
  const universe = collectionUniverse(config, 'crop');

  it('compte les entrées découvertes de l’univers, jamais les orphelines', () => {
    const [first, second] = universe;
    if (!first || !second) throw new Error('univers trop petit');
    const discoveries = indexDiscoveries([record(first.key), record(second.key), record('removed_crop')]);
    expect(collectionProgress(universe, discoveries)).toEqual({ discovered: 2, total: universe.length });
    expect(collectionProgress(universe, new Map())).toEqual({ discovered: 0, total: universe.length });
  });

  it('masque le nom d’une entrée jamais obtenue', () => {
    const entry = universe[0]!;
    expect(maskedName(entry, false)).toBe(HIDDEN_NAME);
    expect(maskedName(entry, true)).toBe(entry.name);
  });

  it('compte les variantes rares découvertes, par variante', () => {
    const counts = countRareVariants([
      record('chicken:shiny'),
      record('cow:shiny'),
      record('cow:golden'),
      record('chicken'),
    ]);
    expect(counts).toEqual({ shiny: 2, golden: 1 });
  });
});

describe('pagination', () => {
  const universe = collectionUniverse(config, 'crop');

  it('découpe en pages de COLLECTION_PAGE_SIZE et borne la page demandée', () => {
    const total = pageCount(universe.length);
    expect(total).toBe(Math.ceil(universe.length / COLLECTION_PAGE_SIZE));
    expect(clampPage(0, total)).toBe(1);
    expect(clampPage(99, total)).toBe(total);
    expect(clampPage(Number.NaN, total)).toBe(1);
    expect(clampPage(2.7, total)).toBe(2);
    expect(pageCount(0)).toBe(1);
  });

  it('la page porte les lignes de sa tranche, découvertes ou non', () => {
    const known = universe[COLLECTION_PAGE_SIZE]!; // première entrée de la page 2
    const discoveries = indexDiscoveries([record(known.key, { count: 7, bestQuality: 'gold' })]);
    const page = paginateCollection('crop', universe, discoveries, 2);
    expect(page.page).toBe(2);
    expect(page.lines.length).toBe(Math.min(COLLECTION_PAGE_SIZE, universe.length - COLLECTION_PAGE_SIZE));
    expect(page.lines[0]?.entry.key).toBe(known.key);
    expect(page.lines[0]?.discovered?.count).toBe(7);
    expect(page.lines[1]?.discovered).toBeNull();
    expect(page.discovered).toBe(1);
    expect(page.total).toBe(universe.length);
  });

  it('une page hors bornes retombe sur la dernière', () => {
    const page = paginateCollection('crop', universe, new Map(), 50);
    expect(page.page).toBe(page.totalPages);
    expect(page.lines.length).toBeGreaterThan(0);
  });

  it('les custom_id de pagination et de filtre tiennent en 100 caractères', () => {
    const owner = '123456789012345678901';
    for (const kind of discoveryKinds) {
      expect(buildCustomId('collection', 'page', owner, 50, kind).length).toBeLessThanOrEqual(100);
      expect(buildCustomId('collection', 'refresh', owner, kind, 50).length).toBeLessThanOrEqual(100);
      expect(buildCustomId('collection', 'kind', owner, kind).length).toBeLessThanOrEqual(100);
    }
  });
});

describe('formatage des lignes', () => {
  const t = translatorFor('fr');
  const universe = collectionUniverse(config, 'crop');
  const variants = collectionUniverse(config, 'variant');

  it('une entrée inconnue montre ???, sa rareté et son niveau, jamais son nom', () => {
    const entry = universe.find((candidate) => candidate.requiredLevel > 1) ?? universe[0]!;
    const line = formatCollectionLine({ entry, discovered: null }, t, 'fr');
    expect(line).toContain('❔');
    expect(line).toContain(HIDDEN_NAME);
    expect(line).toContain(String(entry.requiredLevel));
    expect(line).not.toContain(entry.name);
    expect(line).not.toContain(entry.emoji);
  });

  it('une entrée découverte montre le nom, le compteur et la meilleure qualité', () => {
    const entry = universe[0]!;
    const line = formatCollectionLine(
      { entry, discovered: record(entry.key, { count: 1234, bestQuality: 'iridium' }) },
      t,
      'fr',
    );
    expect(line).toContain('✅');
    expect(line).toContain(entry.name);
    expect(line).toContain(entry.emoji);
    expect(line).toMatch(/1[\s  ]?234/);
    expect(line).toContain(t('common.quality.iridium'));
    expect(line).not.toContain(HIDDEN_NAME);
  });

  it('une variante découverte porte son icône et son libellé', () => {
    const golden = variants.find((entry) => entry.variant === 'golden')!;
    const found = formatCollectionLine({ entry: golden, discovered: record(golden.key) }, t, 'fr');
    expect(found).toContain('🌟');
    expect(found).toContain(t('animals.variant.golden'));
    expect(found).toContain(golden.name);
    const hidden = formatCollectionLine({ entry: golden, discovered: null }, t, 'fr');
    expect(hidden).toContain(HIDDEN_NAME);
    expect(hidden).not.toContain(golden.name);
  });

  it('la rareté est portée par une pastille colorée', () => {
    const dots = new Set(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].map(rarityDot));
    expect(dots.size).toBe(6);
    expect(rarityDot('unknown')).toBe(rarityDot('common'));
  });

  it('chaque famille a un emoji et un libellé traduit dans les deux langues', () => {
    for (const kind of discoveryKinds) {
      expect(KIND_EMOJI[kind]).toBeTruthy();
      for (const locale of ['fr', 'en']) {
        expect(translate(locale, `collection.kind.${kind}`)).not.toBe(`collection.kind.${kind}`);
      }
    }
  });

  it('le fragment `collection` est fusionné dans les deux catalogues', () => {
    const fr = loadMergedCatalog('fr') as { collection?: Record<string, unknown>; animals?: Record<string, unknown> };
    const en = loadMergedCatalog('en') as { collection?: Record<string, unknown>; animals?: Record<string, unknown> };
    expect(fr.collection).toBeDefined();
    expect(en.collection).toBeDefined();
    // Les annonces de chance complètent l'espace `animals.*` existant (fusion profonde).
    expect(typeof fr.animals?.lucky_shiny).toBe('string');
    expect(typeof en.animals?.lucky_golden).toBe('string');
    expect(typeof fr.animals?.buy_body).toBe('string');
  });
});

describe('succès de collection', () => {
  const discover = config.achievementList.filter((entry) => entry.conditionType === 'discover_entry');

  it('existent, en plusieurs paliers, avec une famille valide quand ils en ciblent une', () => {
    expect(discover.length).toBeGreaterThanOrEqual(4);
    expect(discover.length).toBeLessThanOrEqual(6);
    for (const achievement of discover) {
      const kind = achievement.conditionTarget.kind;
      if (kind !== undefined) expect(discoveryKinds).toContain(kind);
      expect(achievement.enabled).toBe(true);
    }
    const generic = discover.filter((entry) => entry.conditionTarget.kind === undefined);
    expect(generic.length).toBeGreaterThanOrEqual(3);
    const amounts = generic.map((entry) => entry.conditionAmount).sort((a, b) => a - b);
    expect(new Set(amounts).size).toBe(amounts.length);
  });

  it('« toutes les cultures » vise exactement le nombre de cultures actives', () => {
    const herbarium = config.achievements.get('herbarium_complete');
    expect(herbarium).toBeDefined();
    expect(herbarium?.conditionTarget.kind).toBe('crop');
    expect(herbarium?.conditionAmount).toBe(collectionUniverse(config, 'crop').length);
  });

  it('une famille de succès ne peut pas dépasser la taille de son univers', () => {
    for (const achievement of discover) {
      const kind = achievement.conditionTarget.kind;
      if (!kind) continue;
      expect(achievement.conditionAmount, achievement.key).toBeLessThanOrEqual(
        collectionUniverse(config, kind).length,
      );
    }
  });
});
