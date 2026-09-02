import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { rarities, seasonNames } from '../src/config/gameplay/schemas';
import type { ItemConfig } from '../src/config/gameplay/schemas';
import { eligibleFish } from '../src/game/fishing';
import { eligibleOre, maxDepthForLevel } from '../src/game/mining';

const config = getConfig('fr');
const balance = getBalance();

/**
 * Contrat de CONTENU de la transformation, des consommables, de la pêche et de
 * la mine — le complément des invariants chiffrés de `config-and-balance.test.ts`
 * (marge, boucles, références).
 *
 * Les invariants chiffrés garantissent qu'aucune recette ne casse l'économie ;
 * ceux-ci garantissent que le catalogue reste JOUABLE : une recette n'exige
 * jamais un ingrédient que le joueur ne peut pas encore obtenir, un consommable
 * n'annonce jamais un effet que le service ne sait pas appliquer, une saison ou
 * une galerie n'est jamais vide. Écrits avec l'extension à 49 recettes, 17
 * poissons et 16 minerais, pour qu'une extension suivante ne défasse pas ce qui
 * a été comblé.
 */

/**
 * Niveau à partir duquel un objet peut RÉELLEMENT entrer dans un inventaire :
 * la culture pour une récolte, l'animal pour un produit animal, la recette pour
 * un produit transformé, la fiche objet pour tout le reste. `requiredLevel` de
 * l'objet seul ne suffit pas — une récolte dérivée hérite d'un niveau 1 par
 * défaut alors que sa culture se débloque bien plus tard.
 */
function availabilityLevel(item: ItemConfig): number {
  if (item.category === 'harvest' && item.sourceKey) {
    return config.crops.get(item.sourceKey)?.requiredLevel ?? item.requiredLevel;
  }
  if (item.category === 'animal_product' && item.sourceKey) {
    return config.animals.get(item.sourceKey)?.requiredLevel ?? item.requiredLevel;
  }
  const producer = config.recipeList.find((recipe) => recipe.outputItemKey === item.key);
  if (producer) return Math.max(producer.requiredLevel, item.requiredLevel);
  return item.requiredLevel;
}

const meanBy = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/**
 * La rareté doit annoncer le palier : un joueur lit « épique » comme « plus
 * tard que rare ». Vérifie que les bandes de niveau ne se chevauchent pas.
 */
function expectRarityBandsOrdered(items: ItemConfig[], label: string): void {
  const bands = rarities
    .map((rarity) => {
      const levels = items.filter((item) => item.rarity === rarity).map((item) => item.requiredLevel);
      return { rarity, min: Math.min(...levels), max: Math.max(...levels), count: levels.length };
    })
    .filter((band) => band.count > 0);
  for (let index = 1; index < bands.length; index += 1) {
    const lower = bands[index - 1];
    const upper = bands[index];
    if (!lower || !upper) continue;
    expect(
      upper.min,
      `${label} : ${upper.rarity} (niv. ${upper.min}) avant la fin de ${lower.rarity} (niv. ${lower.max})`,
    ).toBeGreaterThan(lower.max);
  }
}

describe('catalogue des recettes', () => {
  it("n'est jamais débloqué avant le bâtiment qui le fabrique", () => {
    const problems: string[] = [];
    for (const recipe of config.recipeList) {
      const building = config.buildings.get(recipe.buildingKey);
      if (!building) {
        problems.push(`${recipe.key} : bâtiment ${recipe.buildingKey} inconnu`);
        continue;
      }
      // Une recette listée avant son bâtiment s'afficherait dans /recipes sans
      // pouvoir être lancée : une promesse que le joueur ne peut pas tenir.
      if (recipe.requiredLevel < building.requiredLevel) {
        problems.push(`${recipe.key} (niv ${recipe.requiredLevel}) avant ${building.key} (niv ${building.requiredLevel})`);
      }
      if (building.category !== 'production') problems.push(`${recipe.key} : ${building.key} n'est pas un bâtiment de production`);
      if (recipe.requiredLevel > balance.progression.maxLevel) problems.push(`${recipe.key} : niveau inatteignable`);
    }
    expect(problems).toEqual([]);
  });

  it("n'exige jamais un ingrédient que le joueur ne peut pas encore obtenir", () => {
    // Une recette de niveau 8 qui demanderait une récolte de niveau 16 serait
    // un mur déguisé : débloquée, affichée, impossible à lancer pendant huit
    // niveaux. Chaque ingrédient doit être accessible AU PLUS TARD avec la recette.
    const problems: string[] = [];
    for (const recipe of config.recipeList) {
      for (const ingredient of recipe.ingredients) {
        const item = config.items.get(ingredient.itemKey);
        if (!item) {
          problems.push(`${recipe.key} : ingrédient ${ingredient.itemKey} inconnu`);
          continue;
        }
        const available = availabilityLevel(item);
        if (available > recipe.requiredLevel) {
          problems.push(`${recipe.key} (niv ${recipe.requiredLevel}) demande ${item.key} (niv ${available})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('produit un objet dont la fiche renvoie à la recette', () => {
    // `sourceKey` d'un produit alimente les vues « d'où vient cet objet ? » :
    // s'il pointe ailleurs que sur la recette qui le fabrique, la fiche ment.
    const problems: string[] = [];
    for (const recipe of config.recipeList) {
      const output = config.items.get(recipe.outputItemKey);
      if (!output) {
        problems.push(`${recipe.key} : produit ${recipe.outputItemKey} inconnu`);
        continue;
      }
      if (output.category !== 'product' && output.category !== 'consumable') {
        problems.push(`${recipe.key} : catégorie de sortie ${output.category}`);
      }
      if (output.category === 'product' && output.sourceKey && output.sourceKey !== recipe.key) {
        problems.push(`${output.key} : sourceKey ${output.sourceKey} ≠ ${recipe.key}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('range chaque recette dans la catégorie de son bâtiment', () => {
    // Le filtre de /recipes propose une catégorie par atelier ; une recette
    // classée ailleurs que ses voisines disparaîtrait du filtre attendu.
    const categoryOf = new Map<string, string>();
    const problems: string[] = [];
    for (const recipe of config.recipeList) {
      const known = categoryOf.get(recipe.buildingKey);
      if (known && known !== recipe.category) {
        problems.push(`${recipe.key} : ${recipe.category} alors que ${recipe.buildingKey} range en ${known}`);
      }
      categoryOf.set(recipe.buildingKey, known ?? recipe.category);
    }
    expect(problems).toEqual([]);
  });

  it('donne au moins trois recettes à chaque bâtiment de production', () => {
    // Un atelier qui coûte des dizaines de milliers de pièces pour deux
    // recettes ne vaut pas sa construction.
    const problems: string[] = [];
    for (const building of config.buildingList.filter((entry) => entry.category === 'production')) {
      const count = config.recipeList.filter((recipe) => recipe.buildingKey === building.key).length;
      if (count < 3) problems.push(`${building.key} : ${count} recette(s)`);
    }
    expect(problems).toEqual([]);
  });

  it('ne laisse jamais plus de cinq niveaux sans nouvelle recette', () => {
    // Même pilier « aucun mur » que pour les cultures : entre deux
    // déblocages, monter en niveau doit ouvrir quelque chose à fabriquer.
    const levels = [...new Set(config.recipeList.map((recipe) => recipe.requiredLevel))].sort((a, b) => a - b);
    const gaps: string[] = [];
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1];
      const current = levels[index];
      if (previous === undefined || current === undefined) continue;
      if (current - previous > 5) gaps.push(`${previous} → ${current}`);
    }
    expect(gaps).toEqual([]);
  });

  it('tient les durées entre cinq minutes et douze heures', () => {
    // En deçà, la production ne serait qu'un clic de plus ; au-delà, le slot
    // resterait bloqué au-delà d'une journée de jeu.
    const outside = config.recipeList
      .filter((recipe) => recipe.durationSeconds < 300 || recipe.durationSeconds > 12 * 3_600)
      .map((recipe) => `${recipe.key} : ${recipe.durationSeconds} s`);
    expect(outside).toEqual([]);
  });

  it('offre des puits de fin de partie aux ingrédients légendaires et mythiques', () => {
    // Sans recette qui les consomme, les produits des animaux mythiques et les
    // cultures légendaires n'auraient d'autre destin que la vente : la fin de
    // partie se réduirait à un compteur de pièces.
    const sinks = config.recipeList.filter((recipe) =>
      recipe.ingredients.some((ingredient) => {
        const rarity = config.items.get(ingredient.itemKey)?.rarity;
        return rarity === 'legendary' || rarity === 'mythic';
      }),
    );
    expect(sinks.length).toBeGreaterThanOrEqual(4);
    expect(sinks.some((recipe) => recipe.ingredients.some((i) => config.items.get(i.itemKey)?.rarity === 'mythic'))).toBe(true);
  });

  it('ne fait jamais coïncider deux recettes sur le même sortOrder', () => {
    const orders = config.recipeList.map((recipe) => recipe.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('catalogue des consommables', () => {
  const consumables = config.itemList.filter((item) => item.category === 'consumable');

  /** Les seuls types que `consumable.service.ts` sait appliquer à un consommable. */
  const APPLICABLE = new Set([
    'fertilizer',
    'water_all',
    'xp_boost',
    'growth_boost',
    'luck',
    'pest_repel',
    'pest_cure',
    'energy',
    'streak_freeze',
    'quest_reroll',
  ]);

  it("se revend toujours moins cher qu'il ne s'achète", () => {
    // Sinon la boutique deviendrait une pompe à pièces : acheter, revendre, recommencer.
    const problems = consumables
      .filter((item) => item.basePrice > 0 && item.sellPrice >= item.basePrice)
      .map((item) => `${item.key} : achat ${item.basePrice}, revente ${item.sellPrice}`);
    expect(problems).toEqual([]);
  });

  it('ne déclare que des effets que le service sait interpréter', () => {
    // Un type inconnu passe le schéma (il est partagé avec les outils et les
    // cosmétiques) mais tombe dans le `default` de `useConsumable` : l'objet se
    // vendrait puis lèverait une erreur à l'usage.
    const problems = consumables
      .filter((item) => !item.effect?.type || !APPLICABLE.has(item.effect.type))
      .map((item) => `${item.key} : effet ${String(item.effect?.type)}`);
    expect(problems).toEqual([]);
  });

  it('chiffre chaque effet : durée pour les boosts, quantité pour les instantanés', () => {
    // Le service retombe sur des valeurs par défaut (1 h, +0 %) quand le champ
    // manque : l'objet « fonctionnerait » sans faire ce que sa description promet.
    const problems: string[] = [];
    for (const item of consumables) {
      const effect = item.effect;
      if (!effect?.type) continue;
      const missing = (field: string): void => {
        problems.push(`${item.key} (${effect.type}) : ${field} manquant`);
      };
      switch (effect.type) {
        case 'xp_boost':
        case 'growth_boost':
          if (!(effect.multiplier && effect.multiplier > 1)) missing('multiplier > 1');
          if (!effect.durationSeconds) missing('durationSeconds');
          break;
        case 'luck':
          if (!(effect.bonus && effect.bonus > 0)) missing('bonus');
          if (!effect.durationSeconds) missing('durationSeconds');
          break;
        case 'pest_repel':
          if (!effect.durationSeconds) missing('durationSeconds');
          break;
        case 'energy':
          if (!(effect.amount && effect.amount > 0)) missing('amount');
          break;
        case 'fertilizer':
          if (!(effect.fertility && effect.fertility > 0)) missing('fertility');
          break;
        default:
          break;
      }
    }
    expect(problems).toEqual([]);
  });

  it('fait payer la puissance : à effet égal, le plus fort coûte plus cher', () => {
    // Un consommable plus puissant et moins cher qu'un autre du même type rend
    // ce dernier inutile et fausse la lecture des prix de la boutique.
    const potency = (item: ItemConfig): number | undefined => {
      const effect = item.effect;
      if (!effect?.type) return undefined;
      switch (effect.type) {
        case 'fertilizer':
          return (effect.fertility ?? 0) + 100 * ((effect.yieldBoost ?? 0) + (effect.qualityBoost ?? 0));
        case 'xp_boost':
        case 'growth_boost':
          return ((effect.multiplier ?? 1) - 1) * (effect.durationSeconds ?? 0);
        case 'luck':
          return (effect.bonus ?? 0) * (effect.durationSeconds ?? 0);
        case 'pest_repel':
          return effect.durationSeconds ?? 0;
        case 'energy':
          return effect.amount ?? 0;
        default:
          return undefined;
      }
    };
    const problems: string[] = [];
    const priced = consumables.filter((item) => item.basePrice > 0);
    for (const weaker of priced) {
      for (const stronger of priced) {
        if (weaker.effect?.type !== stronger.effect?.type) continue;
        const a = potency(weaker);
        const b = potency(stronger);
        if (a === undefined || b === undefined || b <= a) continue;
        if (stronger.basePrice <= weaker.basePrice) {
          problems.push(`${stronger.key} est plus fort que ${weaker.key} mais pas plus cher`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('vivier de pêche', () => {
  const fishItems = config.itemList.filter((item) => item.category === 'fish' && item.enabled);
  const pool = fishItems.map((item) => ({
    key: item.key,
    rarity: item.rarity,
    requiredLevel: item.requiredLevel,
    seasons: item.seasons,
    timeOfDay: item.timeOfDay,
  }));
  // La vieille botte est une prise-gag : elle ne compte pas comme « quelque chose mord ».
  const isCatch = (key: string): boolean => (config.items.get(key)?.sellPrice ?? 0) >= 10;

  it('fait de la rareté une annonce fiable du niveau', () => {
    expectRarityBandsOrdered(fishItems, 'poissons');
  });

  it('fait mordre quelque chose dès le déblocage, de jour comme de nuit, en toute saison', () => {
    const problems: string[] = [];
    for (const season of seasonNames) {
      for (const daytime of [true, false]) {
        const eligible = eligibleFish(pool, { level: balance.fishing.unlockLevel, season, daytime }).filter((fish) =>
          isCatch(fish.key),
        );
        if (eligible.length === 0) problems.push(`${season}, ${daytime ? 'jour' : 'nuit'} : rien ne mord`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('réserve à chaque créneau saison × moment une prise rare ou mieux en fin de partie', () => {
    // Sinon un joueur de haut niveau n'aurait aucune raison de pêcher hors
    // des créneaux des espèces légendaires : l'étang serait vide la moitié du temps.
    const rank = (rarity: string): number => rarities.indexOf(rarity as (typeof rarities)[number]);
    const problems: string[] = [];
    for (const season of seasonNames) {
      for (const daytime of [true, false]) {
        const eligible = eligibleFish(pool, { level: balance.progression.maxLevel, season, daytime });
        if (!eligible.some((fish) => rank(fish.rarity) >= rank('rare'))) {
          problems.push(`${season}, ${daytime ? 'jour' : 'nuit'} : rien au-dessus de peu commun`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('donne à chaque saison une espèce qui lui est propre', () => {
    // Une espèce exclusive est ce qui fait revenir le joueur à l'étang quand la
    // saison change ; une saison sans exclusivité serait la copie d'une autre.
    const missing = seasonNames.filter(
      (season) => !fishItems.some((item) => item.seasons?.length === 1 && item.seasons[0] === season),
    );
    expect(missing).toEqual([]);
  });

  it('fait grimper la valeur avec la rareté', () => {
    const means = rarities
      .map((rarity) => meanBy(fishItems.filter((item) => item.rarity === rarity).map((item) => item.sellPrice)))
      .filter((mean) => mean > 0);
    for (let index = 1; index < means.length; index += 1) {
      expect(means[index]).toBeGreaterThan(means[index - 1] ?? 0);
    }
  });
});

describe('filons de la mine', () => {
  const oreItems = config.itemList.filter((item) => item.category === 'ore' && item.enabled);
  const pool = oreItems.map((item) => ({
    key: item.key,
    rarity: item.rarity,
    requiredLevel: item.requiredLevel,
    minDepth: item.minDepth ?? 1,
  }));

  it('fait de la rareté une annonce fiable du niveau', () => {
    expectRarityBandsOrdered(oreItems, 'minerais');
  });

  it('reste atteignable avant le niveau maximal', () => {
    // Un minerai enfoui plus bas que la profondeur accessible au dernier niveau
    // serait une entrée de catalogue que personne ne verrait jamais.
    const reachable = maxDepthForLevel(balance.progression.maxLevel, balance);
    const problems = oreItems
      .filter((item) => (item.minDepth ?? 1) > reachable || item.requiredLevel > balance.progression.maxLevel)
      .map((item) => `${item.key} : profondeur ${item.minDepth}, niveau ${item.requiredLevel}`);
    expect(problems).toEqual([]);
  });

  it('trouve toujours quelque chose dès le premier coup de pioche', () => {
    const eligible = eligibleOre(pool, { level: balance.mining.unlockLevel, depth: 1 });
    expect(eligible.length).toBeGreaterThan(0);
  });

  it('ne laisse jamais plus de trois galeries sans nouveau filon', () => {
    // Descendre doit régulièrement révéler quelque chose de neuf, sinon
    // l'avancement (20 % par coup) ne récompense qu'une fois sur dix.
    const depths = [...new Set(pool.map((ore) => ore.minDepth))].sort((a, b) => a - b);
    const gaps: string[] = [];
    for (let index = 1; index < depths.length; index += 1) {
      const previous = depths[index - 1];
      const current = depths[index];
      if (previous === undefined || current === undefined) continue;
      if (current - previous > 3) gaps.push(`${previous} → ${current}`);
    }
    expect(depths[0]).toBe(1);
    expect(gaps).toEqual([]);
  });

  it('fait grimper la valeur avec la rareté', () => {
    const means = rarities
      .map((rarity) => meanBy(oreItems.filter((item) => item.rarity === rarity).map((item) => item.sellPrice)))
      .filter((mean) => mean > 0);
    for (let index = 1; index < means.length; index += 1) {
      expect(means[index]).toBeGreaterThan(means[index - 1] ?? 0);
    }
  });
});

describe('catalogue des objets', () => {
  it('ne fait jamais coïncider deux objets sur le même sortOrder', () => {
    // L'inventaire et la boutique trient par sortOrder ; une égalité rendrait
    // l'ordre dépendant de l'ordre du fichier, donc fragile aux insertions.
    const orders = config.itemList.map((item) => item.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('traduit chaque description en anglais', () => {
    // `nameEn` est déjà couvert ailleurs ; une description FR sans pendant EN
    // retomberait en français chez un joueur anglophone.
    const missing = config.itemList
      .filter((item) => item.description && !item.descriptionEn)
      .map((item) => item.key);
    expect(missing).toEqual([]);
  });
});
