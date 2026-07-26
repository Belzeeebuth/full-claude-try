import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig, harvestKeyOf, seedKeyOf } from '../src/config';
import { cumulativePlotCost } from '../src/game/grid';
import { xpTable } from '../src/game/xp';
import {
  buildCustomId,
  CUSTOM_ID_MAX_LENGTH,
  isOwner,
  parseCustomId,
  PUBLIC_OWNER,
} from '../src/utils/custom-id';
import { formatDuration, formatNumber, progressBar, truncate } from '../src/utils/format';
import { isUuid, referralCode, uuidTimestamp, uuidv7 } from '../src/utils/uuid';
import {
  currentWeekStart,
  dailyCycleKey,
  isWeekend,
  nextMidnight,
  weeklyCycleKey,
} from '../src/utils/time';

const config = getConfig();
const balance = getBalance();

/**
 * Ces tests transforment le document d'équilibrage en CONTRAT exécutable.
 * Un game designer qui déséquilibre `crops.json` casse la CI, pas seulement la
 * documentation — c'est tout l'intérêt de dériver le contenu de fichiers.
 */

describe('intégrité de la configuration', () => {
  it('livre le contenu annoncé au cahier des charges', () => {
    expect(config.cropList.length).toBeGreaterThanOrEqual(25);
    expect(config.animalList.length).toBeGreaterThanOrEqual(12);
    expect(config.recipeList.length).toBeGreaterThanOrEqual(20);
    expect(config.buildingList.length).toBeGreaterThanOrEqual(10);
    expect(config.questList.length).toBeGreaterThanOrEqual(30);
    expect(config.achievementList.length).toBeGreaterThanOrEqual(20);
  });

  it('dérive une graine et une récolte par culture', () => {
    for (const crop of config.cropList) {
      const seed = config.items.get(seedKeyOf(crop.key));
      const harvest = config.items.get(harvestKeyOf(crop.key));
      expect(seed, `graine manquante pour ${crop.key}`).toBeDefined();
      expect(harvest, `récolte manquante pour ${crop.key}`).toBeDefined();
      expect(seed!.category).toBe('seed');
      expect(harvest!.category).toBe('harvest');
      expect(harvest!.marketTracked).toBe(true);
    }
  });

  it('rend la revente de graines toujours perdante', () => {
    for (const crop of config.cropList) {
      const seed = config.items.get(seedKeyOf(crop.key))!;
      expect(seed.sellPrice).toBeLessThan(seed.basePrice);
    }
  });

  it('référence des objets, bâtiments et animaux existants', () => {
    for (const recipe of config.recipeList) {
      expect(config.buildings.has(recipe.buildingKey)).toBe(true);
      expect(config.items.has(recipe.outputItemKey)).toBe(true);
      for (const ingredient of recipe.ingredients) {
        expect(config.items.has(ingredient.itemKey), `ingrédient ${ingredient.itemKey}`).toBe(true);
      }
    }
    for (const animal of config.animalList) {
      expect(config.buildings.has(animal.buildingKey)).toBe(true);
      expect(config.items.has(animal.productItemKey)).toBe(true);
      expect(config.items.has(animal.feedItemKey)).toBe(true);
    }
  });

  it('n\'a aucune clé dupliquée', () => {
    const keys = [
      ...config.cropList.map((entry) => `crop:${entry.key}`),
      ...config.animalList.map((entry) => `animal:${entry.key}`),
      ...config.itemList.map((entry) => `item:${entry.key}`),
      ...config.recipeList.map((entry) => `recipe:${entry.key}`),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('équilibrage des cultures', () => {
  it('reste rentable pour toutes les cultures', () => {
    for (const crop of config.cropList) {
      const cycles = 1 + crop.regrowCycles;
      const gross = crop.sellPrice * crop.baseYield * cycles;
      expect(gross, `${crop.key} n'est pas rentable`).toBeGreaterThan(crop.seedPrice);
    }
  });

  it('fait croître le revenu horaire avec le niveau requis', () => {
    const byLevel = [...config.cropList].sort((a, b) => a.requiredLevel - b.requiredLevel);
    const perHour = byLevel.map((crop) => {
      const cycles = 1 + crop.regrowCycles;
      const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
      return ((crop.sellPrice * crop.baseYield * cycles - crop.seedPrice) / totalSeconds) * 3_600;
    });

    // La progression n'est pas strictement monotone (les cultures repousseuses
    // sortent du lot), mais la moyenne du dernier tiers doit dépasser largement
    // celle du premier : sans cela, monter en niveau n'apporterait rien.
    const third = Math.floor(perHour.length / 3);
    const early = perHour.slice(0, third).reduce((sum, value) => sum + value, 0) / third;
    const late = perHour.slice(-third).reduce((sum, value) => sum + value, 0) / third;
    expect(late).toBeGreaterThan(early * 5);
  });

  it('n\'a aucune culture au rendement horaire aberrant pour son niveau', () => {
    for (const crop of config.cropList) {
      const cycles = 1 + crop.regrowCycles;
      const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
      const perHour = ((crop.sellPrice * crop.baseYield * cycles - crop.seedPrice) / totalSeconds) * 3_600;
      // Plafond souple : 90 × le niveau requis. Au-delà, une culture de bas
      // niveau rendrait tout le reste du jeu inutile.
      expect(perHour, `${crop.key} rapporte trop pour son niveau`).toBeLessThan(
        90 * crop.requiredLevel + 400,
      );
    }
  });

  it('propose au moins une culture par saison', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
      const available = config.cropList.filter((crop) => crop.seasons.includes(season as never));
      expect(available.length, `aucune culture en ${season}`).toBeGreaterThan(0);
    }
  });

  it('exige un niveau accessible pour toutes les cultures', () => {
    for (const crop of config.cropList) {
      expect(crop.requiredLevel).toBeLessThanOrEqual(balance.progression.maxLevel);
    }
  });
});

describe('équilibrage de la transformation', () => {
  it('crée toujours de la valeur, sans excès', () => {
    for (const recipe of config.recipeList) {
      const output = config.items.get(recipe.outputItemKey)!;
      // Les recettes produisant un objet non vendable (compost) sont exclues :
      // leur valeur est fonctionnelle, pas marchande.
      if (!output.sellable || output.sellPrice === 0) continue;

      const inputValue = recipe.ingredients.reduce((sum, ingredient) => {
        const item = config.items.get(ingredient.itemKey)!;
        return sum + item.sellPrice * ingredient.quantity;
      }, 0);
      const outputValue = output.sellPrice * recipe.outputQuantity;
      const margin = outputValue / Math.max(1, inputValue);

      expect(margin, `${recipe.key} : marge de ${margin.toFixed(2)}`).toBeGreaterThan(1.2);
      expect(margin, `${recipe.key} : marge de ${margin.toFixed(2)}`).toBeLessThan(2.4);
    }
  });

  it('ne crée pas de boucle infinie de fabrication', () => {
    for (const recipe of config.recipeList) {
      const ingredientKeys = recipe.ingredients.map((ingredient) => ingredient.itemKey);
      expect(ingredientKeys).not.toContain(recipe.outputItemKey);
    }
  });
});

describe('équilibrage des animaux', () => {
  it('amortit chaque animal en un temps raisonnable', () => {
    for (const animal of config.animalList) {
      const product = config.items.get(animal.productItemKey)!;
      const feed = config.items.get(animal.feedItemKey)!;
      const cycleHours = animal.productionSeconds / 3_600;
      const revenue = (product.sellPrice * animal.productQuantity) / cycleHours;
      const cost = (feed.basePrice * animal.feedPerCycle) / cycleHours;
      const net = revenue - cost;
      const price = animal.price > 0 ? animal.price : animal.priceGems * 250;

      expect(net, `${animal.key} n'est pas rentable`).toBeGreaterThan(0);
      const payback = price / net;
      // Entre 5 h (sinon trivial) et 48 h (sinon décourageant) de production.
      expect(payback, `${animal.key} s'amortit en ${payback.toFixed(1)} h`).toBeGreaterThan(5);
      expect(payback, `${animal.key} s'amortit en ${payback.toFixed(1)} h`).toBeLessThan(48);
    }
  });
});

describe('équilibrage de la progression', () => {
  it('mène au niveau maximum en un temps de jeu cohérent', () => {
    const table = xpTable(balance);
    const total = table.at(-1)!.cumulative;
    // Cible : 400 000 à 1 200 000 XP pour le niveau maximum, soit plusieurs mois
    // de jeu régulier avant le prestige.
    expect(total).toBeGreaterThan(400_000);
    expect(total).toBeLessThan(1_200_000);
  });

  it('garde les récompenses de palier marginales face aux revenus de récolte', () => {
    const table = xpTable(balance);
    const totalLevelRewards = table.reduce((sum, row) => sum + row.rewardCoins, 0);
    const fullGridCost = cumulativePlotCost(
      balance.plots.startingUnlocked,
      balance.plots.maxPlots,
      balance,
    );
    // Les récompenses de niveau ne doivent pas financer l'extension : elles
    // représentent un coup de pouce, pas la source principale de revenus.
    expect(totalLevelRewards).toBeLessThan(fullGridCost * 0.2);
  });

  it('rend l\'extension complète coûteuse mais atteignable', () => {
    const total = cumulativePlotCost(
      balance.plots.startingUnlocked,
      balance.plots.maxPlots,
      balance,
    );
    expect(total).toBeGreaterThan(1_000_000);
    expect(total).toBeLessThan(60_000_000);
  });

  it('conserve des puits monétaires actifs', () => {
    expect(balance.economy.salesTaxRate).toBeGreaterThan(0);
    expect(balance.auction.commissionRate).toBeGreaterThan(0);
    expect(balance.economy.sellDirectPenalty).toBeGreaterThan(0);
    expect(balance.economy.giftTaxRate).toBeGreaterThan(0);
  });
});

describe('custom_id', () => {
  it('fait un aller-retour fidèle', () => {
    const id = buildCustomId('farm', 'harvest', '123456789012345678', 12, 'wheat');
    const parsed = parseCustomId(id);
    expect(parsed.namespace).toBe('farm');
    expect(parsed.action).toBe('harvest');
    expect(parsed.ownerId).toBe('123456789012345678');
    expect(parsed.params).toEqual(['12', 'wheat']);
  });

  it('refuse les caractères qui casseraient le format', () => {
    expect(() => buildCustomId('farm', 'harvest', '1', 'a:b')).toThrow();
    expect(() => buildCustomId('farm', 'harvest', '1', 'espace interdit')).toThrow();
  });

  it('refuse un identifiant trop long pour Discord', () => {
    expect(() => buildCustomId('farm', 'harvest', '123456789012345678', 'x'.repeat(120))).toThrow();
    expect(buildCustomId('a', 'b', '1').length).toBeLessThan(CUSTOM_ID_MAX_LENGTH);
  });

  it('protège le propriétaire du composant', () => {
    const parsed = parseCustomId(buildCustomId('farm', 'harvest', '111'));
    expect(isOwner(parsed, '111')).toBe(true);
    expect(isOwner(parsed, '222')).toBe(false);
  });

  it('autorise tout le monde sur un composant public', () => {
    const parsed = parseCustomId(buildCustomId('help', 'page', PUBLIC_OWNER, 2));
    expect(isOwner(parsed, "n'importe qui")).toBe(true);
  });

  it('rejette un identifiant malformé', () => {
    expect(() => parseCustomId('incomplet')).toThrow();
  });
});

describe('utilitaires', () => {
  it('génère des UUID v7 croissants et horodatés', () => {
    const first = uuidv7();
    const second = uuidv7();
    expect(isUuid(first)).toBe(true);
    expect(first < second || first === second).toBe(true);
    const timestamp = uuidTimestamp(first);
    expect(timestamp).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - timestamp!.getTime())).toBeLessThan(5_000);
  });

  it('génère des codes de parrainage sans caractères ambigus', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(referralCode(8)).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });

  it('formate durées et nombres en français', () => {
    expect(formatDuration(0)).toBe('< 1 s');
    expect(formatDuration(90_000)).toBe('1 min 30 s');
    expect(formatDuration(3_600_000 * 26)).toContain('j');
    expect(formatNumber(1234567)).toMatch(/1.234.567/);
  });

  it('dessine une barre de progression bornée', () => {
    expect(progressBar(0, 10, 10)).toBe('▱'.repeat(10));
    expect(progressBar(10, 10, 10)).toBe('▰'.repeat(10));
    expect(progressBar(20, 10, 10)).toBe('▰'.repeat(10));
    expect(progressBar(5, 0, 10)).toBe('▰'.repeat(10));
  });

  it('tronque sans dépasser la limite', () => {
    expect(truncate('abcdef', 4)).toHaveLength(4);
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('calcule des clés de cycle stables', () => {
    const date = new Date('2026-07-26T22:30:00Z');
    expect(dailyCycleKey(date, 'UTC')).toBe('2026-07-26');
    expect(weeklyCycleKey(date, 'UTC')).toMatch(/^2026-W\d{2}$/);
    expect(currentWeekStart(date, 'UTC')).toBe('2026-07-20');
    expect(nextMidnight(date, 'UTC').toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });

  it('détecte le week-end', () => {
    expect(isWeekend(new Date('2026-07-25T12:00:00Z'), 'UTC')).toBe(true); // samedi
    expect(isWeekend(new Date('2026-07-22T12:00:00Z'), 'UTC')).toBe(false); // mercredi
  });
});
