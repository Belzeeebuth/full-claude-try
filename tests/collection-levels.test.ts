import { describe, expect, it } from 'vitest';
import { formatCollectionLine } from '../src/commands/collection';
import { getConfig } from '../src/config';
import type { ItemConfig } from '../src/config/gameplay/schemas';
import { collectionUniverse } from '../src/game/collection';
import { translatorFor } from '../src/i18n';

/**
 * Niveau révélé par `/collection` : le seul renseignement qu'une entrée
 * masquée livre au joueur doit être VRAI, et c'est aussi la clé de tri qui
 * promet « le prochain déblocage en tête ».
 *
 * Le piège : `requiredLevel` sur la fiche objet vaut 1 par défaut (Zod) et
 * n'est renseigné ni sur les 24 produits animaux ni sur 47 des 48 produits
 * transformés. Prendre ce champ tel quel affichait « niv. 1 » pour un mythique
 * de niveau 46 et écrasait le tri par niveau en simple tri par `sortOrder`.
 */

const config = getConfig('fr');

/**
 * Niveau d'accès réel, recalculé ici depuis la configuration brute — la même
 * dérivation que `availabilityLevel` de `content-recipes.test.ts`, pour que le
 * test échoue si `collectionUniverse` retombe sur le champ brut de l'objet.
 */
function availabilityLevel(item: ItemConfig): number {
  if (item.category === 'animal_product' && item.sourceKey) {
    return config.animals.get(item.sourceKey)?.requiredLevel ?? item.requiredLevel;
  }
  const producer = config.recipeList.find(
    (recipe) => recipe.enabled && recipe.outputItemKey === item.key,
  );
  if (producer) return Math.max(producer.requiredLevel, item.requiredLevel);
  return item.requiredLevel;
}

describe('niveau révélé par la collection', () => {
  const universe = collectionUniverse(config, 'product');
  const levelOf = (key: string): number | undefined =>
    universe.find((entry) => entry.key === key)?.requiredLevel;

  it('chaque produit porte le niveau de sa source, animal ou recette', () => {
    expect(universe.length).toBeGreaterThan(0);
    for (const entry of universe) {
      const item = config.items.get(entry.key);
      expect(item, entry.key).toBeDefined();
      expect(entry.requiredLevel, entry.key).toBe(availabilityLevel(item!));
    }
    // Le défaut Zod à 1 ne doit plus tenir lieu de niveau pour toute la famille.
    expect(new Set(universe.map((entry) => entry.requiredLevel)).size).toBeGreaterThan(2);
  });

  it('l’œuf de la poule précède l’encens de phénix, avec les niveaux de leurs sources', () => {
    expect(levelOf('egg')).toBe(config.animals.get('chicken')!.requiredLevel);
    expect(levelOf('phoenix_incense')).toBe(
      config.recipeList.find((recipe) => recipe.outputItemKey === 'phoenix_incense')!.requiredLevel,
    );
    expect(levelOf('phoenix_incense')!).toBeGreaterThan(levelOf('egg')!);
    const keys = universe.map((entry) => entry.key);
    expect(keys.indexOf('egg')).toBeLessThan(keys.indexOf('phoenix_incense'));
  });

  it('le tri par niveau ne dégénère pas en tri par ordre de configuration', () => {
    const bySortOrder = [...universe].sort(
      (a, b) => a.sortOrder - b.sortOrder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    // Les produits animaux (niveau 2+) et les transformés se rangent par
    // niveau, donc l'ordre affiché diffère de l'ordre du catalogue.
    expect(universe.map((entry) => entry.key)).not.toEqual(bySortOrder.map((entry) => entry.key));
    for (let index = 1; index < universe.length; index += 1) {
      expect(
        universe[index - 1]!.requiredLevel <= universe[index]!.requiredLevel,
        `${universe[index - 1]!.key} avant ${universe[index]!.key}`,
      ).toBe(true);
    }
  });

  it('la ligne masquée annonce le vrai niveau dans les deux langues', () => {
    const entry = universe.find((candidate) => candidate.key === 'phoenix_incense')!;
    for (const locale of ['fr', 'en']) {
      const line = formatCollectionLine({ entry, discovered: null }, translatorFor(locale), locale);
      expect(line, locale).toContain(String(entry.requiredLevel));
      expect(line, locale).not.toMatch(/\b1\b/);
    }
  });
});
