import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { animalForms, rarities } from '../src/config/gameplay/schemas';

/**
 * L'apparence et le catalogue des animaux sont des DONNÉES, pas du code : ces
 * tests empêchent qu'une espèce ajoutée plus tard retombe silencieusement sur
 * la silhouette générique, ou casse une règle du catalogue que rien d'autre ne
 * vérifie — un mythique payable en pièces, un produit sans suivi de marché, un
 * animal débloqué avant le bâtiment qui l'héberge.
 */
const config = getConfig('fr');
const balance = getBalance();

describe('apparence des animaux', () => {
  it('chaque animal déclare une silhouette connue et une palette complète', () => {
    const incomplete: string[] = [];
    for (const animal of config.animalList) {
      if (!animal.form || !animalForms.includes(animal.form)) {
        incomplete.push(`${animal.key} : forme ${String(animal.form)}`);
      }
      if (!animal.palette) {
        incomplete.push(`${animal.key} : palette absente`);
        continue;
      }
      for (const [channel, value] of Object.entries(animal.palette)) {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) incomplete.push(`${animal.key}.${channel} = ${value}`);
      }
    }
    expect(incomplete).toEqual([]);
  });

  it("l'accent se distingue du corps", () => {
    // Un bec ou des cornes de la teinte exacte du corps seraient invisibles :
    // la silhouette perdrait précisément ce qui identifie l'espèce.
    const invisible = config.animalList
      .filter((animal) => animal.palette && animal.palette.accent === animal.palette.body)
      .map((animal) => animal.key);
    expect(invisible).toEqual([]);
  });

  it('toutes les silhouettes prévues sont réellement utilisées', () => {
    const used = new Set(config.animalList.map((animal) => animal.form));
    // Une forme déclarée mais jamais employée est du code de dessin mort.
    expect([...animalForms].filter((form) => !used.has(form))).toEqual([]);
  });
});

describe('catalogue des animaux', () => {
  it('propose au moins deux espèces par rareté', () => {
    const missing = [...rarities].filter(
      (rarity) => config.animalList.filter((animal) => animal.rarity === rarity).length < 2,
    );
    expect(missing).toEqual([]);
  });

  it("n'est jamais débloqué avant le bâtiment qui l'héberge", () => {
    const problems: string[] = [];
    for (const animal of config.animalList) {
      const building = config.buildings.get(animal.buildingKey);
      if (!building) {
        problems.push(`${animal.key} : bâtiment ${animal.buildingKey} inconnu`);
        continue;
      }
      // Un animal accessible avant son bâtiment s'afficherait dans la boutique
      // sans pouvoir être acheté : une promesse que le joueur ne peut pas tenir.
      if (animal.requiredLevel < building.requiredLevel) {
        problems.push(`${animal.key} (niv ${animal.requiredLevel}) avant ${building.key} (niv ${building.requiredLevel})`);
      }
      if (animal.requiredLevel > balance.progression.maxLevel) {
        problems.push(`${animal.key} : niveau ${animal.requiredLevel} inatteignable`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('se paie dans une seule monnaie, les gemmes étant réservées au mythique', () => {
    const problems: string[] = [];
    for (const animal of config.animalList) {
      const coins = animal.price > 0;
      const gems = animal.priceGems > 0;
      // `buyAnimal` choisit la monnaie d'après `price > 0` : un animal aux deux
      // prix se vendrait en pièces et son prix en gemmes serait lettre morte,
      // un animal sans aucun prix serait gratuit.
      if (coins === gems) problems.push(`${animal.key} : price=${animal.price}, priceGems=${animal.priceGems}`);
      if (gems && animal.rarity !== 'mythic') problems.push(`${animal.key} : gemmes hors mythique`);
    }
    expect(problems).toEqual([]);
  });

  it('a un produit qui lui est propre, de même rareté, suivi par le marché', () => {
    const problems: string[] = [];
    const producers = new Map<string, string>();
    for (const animal of config.animalList) {
      const product = config.items.get(animal.productItemKey);
      if (!product) {
        problems.push(`${animal.key} : produit ${animal.productItemKey} inconnu`);
        continue;
      }
      const previous = producers.get(product.key);
      if (previous) problems.push(`${product.key} partagé par ${previous} et ${animal.key}`);
      producers.set(product.key, animal.key);

      if (product.category !== 'animal_product') problems.push(`${product.key} : catégorie ${product.category}`);
      if (!product.marketTracked) problems.push(`${product.key} : hors marché`);
      if (product.sourceKey !== animal.key) problems.push(`${product.key} : sourceKey ${String(product.sourceKey)}`);
      if (product.rarity !== animal.rarity) problems.push(`${product.key} : rareté ${product.rarity} ≠ ${animal.rarity}`);
      if (!product.sellable || product.sellPrice <= 0) problems.push(`${product.key} : invendable`);
    }
    expect(problems).toEqual([]);
  });

  it("amortit plus lentement un animal de haut niveau", () => {
    // Le contrat d'amortissement (5 h à 48 h) est vérifié par ailleurs ; ici on
    // impose la PROGRESSION : un animal de haut niveau est un investissement,
    // pas un achat impulsif, sinon le bas niveau resterait toujours le meilleur.
    const byLevel = [...config.animalList].sort((a, b) => a.requiredLevel - b.requiredLevel);
    const paybacks = byLevel.map((animal) => {
      const product = config.items.get(animal.productItemKey);
      const feed = config.items.get(animal.feedItemKey);
      if (!product || !feed) throw new Error(`${animal.key} : produit ou nourriture inconnus`);
      const cycleHours = animal.productionSeconds / 3_600;
      const net =
        (product.sellPrice * animal.productQuantity - feed.basePrice * animal.feedPerCycle) / cycleHours;
      const price = animal.price > 0 ? animal.price : animal.priceGems * 250;
      return price / net;
    });
    const third = Math.floor(paybacks.length / 3);
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(paybacks.slice(-third))).toBeGreaterThan(mean(paybacks.slice(0, third)) * 1.5);
  });

  it('garde les bonus passifs modestes', () => {
    // Les bonus se CUMULENT par tête (`src/game/modifiers.ts`) : à 10 % par
    // animal, une étable pleine doublerait déjà les rendements.
    const excessive: string[] = [];
    for (const animal of config.animalList) {
      const { cropYield = 0, marketSellBonus = 0, xpBonus = 0, luck = 0 } = animal.passiveBonus;
      if (Math.max(cropYield, marketSellBonus, xpBonus, luck) > 0.1) excessive.push(animal.key);
    }
    expect(excessive).toEqual([]);
  });
});
