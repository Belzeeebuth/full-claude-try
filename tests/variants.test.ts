import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { rarities } from '../src/config/gameplay/schemas';
import {
  breed,
  collectQuantity,
  inheritVariant,
  projectAnimal,
  rollVariant,
  sellValue,
  variantEffects,
  variantIcon,
  variantProductQuality,
  type AnimalState,
  type AnimalVariant,
} from '../src/game/animals';
import { createRng } from '../src/game/rng';
import { goldenPalette } from '../src/render/sprites';

/**
 * Variantes d'animaux (shiny, dorée) : tirage, hérédité, effets.
 *
 * Les probabilités sont vérifiées sur 10 000 tirages à graine FIXE : le test
 * affirme un intervalle, il ne l'espère pas. Les bornes sont larges (≈ ±40 %
 * de la valeur attendue) pour ne jamais devenir instables si l'équilibrage
 * bouge d'un cheveu, tout en attrapant une inversion (shiny à 20 %), un poids
 * de rareté oublié ou une dorée née d'une portée.
 */

const balance = getBalance();
const config = getConfig('fr');
const DRAWS = 10_000;

function tally(draw: (index: number) => AnimalVariant): Record<AnimalVariant, number> {
  const counts: Record<AnimalVariant, number> = { normal: 0, shiny: 0, golden: 0 };
  for (let index = 0; index < DRAWS; index += 1) counts[draw(index)] += 1;
  return counts;
}

function freshState(): AnimalState {
  const now = new Date('2026-06-01T12:00:00Z');
  return {
    animalKey: 'chicken',
    hunger: 100,
    happiness: 90,
    health: 100,
    statsUpdatedAt: now,
    lastFedAt: now,
    lastCollectedAt: null,
    lastPettedAt: null,
    productionReadyAt: null,
    pendingProduction: 0,
    qualityMultiplier: 1,
    isSick: false,
    isAlive: true,
    bornAt: now,
  };
}

describe('tirage de variante', () => {
  const variants = balance.animals.variants;

  it('une espèce commune : ≈ 2 % de shiny et ≈ 0,2 % de dorées', () => {
    const rng = createRng('variants-common');
    const counts = tally(() => rollVariant(rng, balance, { rarity: 'common' }));
    const shiny = counts.shiny / DRAWS;
    const golden = counts.golden / DRAWS;
    expect(shiny).toBeGreaterThan(variants.shinyChance * 0.6);
    expect(shiny).toBeLessThan(variants.shinyChance * 1.4);
    expect(golden).toBeGreaterThan(variants.goldenChance * 0.3);
    expect(golden).toBeLessThan(variants.goldenChance * 2);
    expect(counts.normal).toBeGreaterThan(DRAWS * 0.95);
  });

  it('une espèce mythique est shiny plus souvent, selon le poids de rareté', () => {
    const weight = variants.rarityWeights.mythic;
    expect(weight).toBeGreaterThan(variants.rarityWeights.common);
    const rng = createRng('variants-mythic');
    const counts = tally(() => rollVariant(rng, balance, { rarity: 'mythic' }));
    const shiny = counts.shiny / DRAWS;
    expect(shiny).toBeGreaterThan(variants.shinyChance * weight * 0.6);
    expect(shiny).toBeLessThan(variants.shinyChance * weight * 1.4);
  });

  it('les poids de rareté sont croissants : plus rare, plus souvent shiny', () => {
    const weights = rarities.map((rarity) => variants.rarityWeights[rarity]);
    for (let index = 1; index < weights.length; index += 1) {
      expect(weights[index]!).toBeGreaterThanOrEqual(weights[index - 1]!);
    }
  });

  it('une rareté inconnue retombe sur le poids 1', () => {
    const rng = createRng('variants-unknown');
    const counts = tally(() => rollVariant(rng, balance, { rarity: 'unheard_of' }));
    expect(counts.shiny / DRAWS).toBeLessThan(variants.shinyChance * 1.4);
  });

  it("est déterministe : même graine, même suite", () => {
    const a = createRng(42);
    const b = createRng(42);
    const first = Array.from({ length: 200 }, () => rollVariant(a, balance, { rarity: 'rare' }));
    const second = Array.from({ length: 200 }, () => rollVariant(b, balance, { rarity: 'rare' }));
    expect(first).toEqual(second);
  });

  it('`allowGolden: false` ne produit jamais de dorée', () => {
    const rng = createRng('variants-no-golden');
    const counts = tally(() => rollVariant(rng, balance, { rarity: 'mythic', allowGolden: false }));
    expect(counts.golden).toBe(0);
    expect(counts.shiny).toBeGreaterThan(0);
  });
});

describe('hérédité', () => {
  const variants = balance.animals.variants;

  it('un parent shiny transmet ≈ inheritanceChance', () => {
    const rng = createRng('inherit-one');
    const counts = tally(() => inheritVariant(['shiny', 'normal'], 'common', balance, rng));
    // Hérédité, plus le tirage ordinaire quand elle échoue.
    const expected = variants.inheritanceChance + (1 - variants.inheritanceChance) * variants.shinyChance;
    expect(counts.shiny / DRAWS).toBeGreaterThan(expected * 0.85);
    expect(counts.shiny / DRAWS).toBeLessThan(expected * 1.15);
  });

  it('deux parents shiny transmettent davantage, sans certitude', () => {
    const rng = createRng('inherit-two');
    const counts = tally(() => inheritVariant(['shiny', 'shiny'], 'common', balance, rng));
    const expected =
      variants.doubleInheritanceChance + (1 - variants.doubleInheritanceChance) * variants.shinyChance;
    expect(variants.doubleInheritanceChance).toBeGreaterThan(variants.inheritanceChance);
    expect(counts.shiny / DRAWS).toBeGreaterThan(expected * 0.85);
    expect(counts.shiny / DRAWS).toBeLessThan(expected * 1.15);
    expect(counts.normal).toBeGreaterThan(0);
  });

  it('la dorée ne se transmet jamais et ne naît jamais', () => {
    const rng = createRng('inherit-golden');
    const counts = tally(() => inheritVariant(['golden', 'golden'], 'mythic', balance, rng));
    expect(counts.golden).toBe(0);
    // Deux parents dorés n'ont aucun bonus shiny : ils sont traités comme ordinaires.
    expect(counts.shiny / DRAWS).toBeLessThan(variants.shinyChance * variants.rarityWeights.mythic * 1.4);
  });

  it('`breed` porte la variante du petit et refuse la dorée', () => {
    const chicken = config.animals.get('chicken');
    if (!chicken) throw new Error('configuration sans poule');
    const status = projectAnimal(freshState(), chicken, new Date('2026-06-01T12:00:00Z'), balance);
    const parent = (variant: AnimalVariant) => ({ qualityMultiplier: 1, generation: 1, status, variant });
    const rng = createRng('breed-variants');
    let births = 0;
    let shiny = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const outcome = breed(parent('shiny'), parent('golden'), chicken, balance, rng);
      if (!outcome.success) {
        expect(outcome.variant).toBe('normal');
        continue;
      }
      births += 1;
      expect(outcome.variant).not.toBe('golden');
      if (outcome.variant === 'shiny') shiny += 1;
    }
    expect(births).toBeGreaterThan(0);
    // Un seul parent shiny (le doré ne compte pas) : ≈ 35 % des naissances.
    expect(shiny / births).toBeGreaterThan(variants.inheritanceChance * 0.7);
    expect(shiny / births).toBeLessThan(variants.inheritanceChance * 1.4);
  });

  it("un parent sans variante renseignée vaut `normal` (compatibilité)", () => {
    const chicken = config.animals.get('chicken');
    if (!chicken) throw new Error('configuration sans poule');
    const status = projectAnimal(freshState(), chicken, new Date('2026-06-01T12:00:00Z'), balance);
    const parent = { qualityMultiplier: 1, generation: 1, status };
    const rng = createRng('breed-legacy');
    const outcome = breed(parent, parent, chicken, balance, rng);
    expect(['normal', 'shiny']).toContain(outcome.variant);
  });
});

describe('effets et économie', () => {
  const variants = balance.animals.variants;

  it('la dorée double la quantité par cycle, la shiny ne change rien à la quantité', () => {
    const cow = config.animals.get('cow');
    if (!cow) throw new Error('configuration sans vache');
    const state = freshState();
    const status = projectAnimal(state, cow, new Date('2026-06-01T12:00:00Z'), balance);
    const base = collectQuantity(cow, status, state, 3);
    const golden = collectQuantity(cow, status, state, 3, variantEffects('golden', balance).productMultiplier);
    const shiny = collectQuantity(cow, status, state, 3, variantEffects('shiny', balance).productMultiplier);
    expect(golden).toBe(base * variants.goldenProductMultiplier);
    expect(shiny).toBe(base);
    expect(variantEffects('normal', balance)).toEqual({ productMultiplier: 1, sellMultiplier: 1, qualityBoost: 0 });
  });

  it('la shiny sort de l’argent ≈ shinyQualityBoost, jamais plus haut ; les autres restent normales', () => {
    const rng = createRng('quality-shiny');
    let silver = 0;
    for (let index = 0; index < DRAWS; index += 1) {
      const quality = variantProductQuality('shiny', balance, rng);
      expect(['normal', 'silver']).toContain(quality);
      if (quality === 'silver') silver += 1;
    }
    expect(silver / DRAWS).toBeGreaterThan(variants.shinyQualityBoost * 0.85);
    expect(silver / DRAWS).toBeLessThan(variants.shinyQualityBoost * 1.15);
    for (let index = 0; index < 100; index += 1) {
      expect(variantProductQuality('normal', balance, rng)).toBe('normal');
      expect(variantProductQuality('golden', balance, rng)).toBe('normal');
    }
  });

  it('la dorée se revend goldenSellMultiplier fois plus cher, la shiny au prix ordinaire', () => {
    const cow = config.animals.get('cow');
    if (!cow) throw new Error('configuration sans vache');
    const status = projectAnimal(freshState(), cow, new Date('2026-06-01T12:00:00Z'), balance);
    const normal = sellValue(cow, status, balance);
    expect(sellValue(cow, status, balance, 'normal')).toBe(normal);
    expect(sellValue(cow, status, balance, 'shiny')).toBe(normal);
    expect(sellValue(cow, status, balance, 'golden')).toBe(
      Math.floor(cow.price * balance.animals.sellPriceRatio * variants.goldenSellMultiplier),
    );
    expect(sellValue(cow, status, balance, 'golden')).toBeGreaterThan(normal);
  });

  it("acheter-revendre en boucle reste une perte nette, quelle que soit la rareté", () => {
    // Économie fermée : l'espérance de revente immédiate d'une bête neuve
    // doit rester sous son prix d'achat, sinon la dorée devient une loterie
    // rentable. On borne les poids de rareté au maximum autorisé.
    for (const rarity of rarities) {
      const goldenChance = Math.min(0.5, variants.goldenChance * variants.rarityWeights[rarity]);
      const expected =
        goldenChance * balance.animals.sellPriceRatio * variants.goldenSellMultiplier +
        (1 - goldenChance) * balance.animals.sellPriceRatio;
      expect(expected, rarity).toBeLessThan(1);
    }
  });

  it('icônes : une par variante rare, rien pour une bête ordinaire', () => {
    expect(variantIcon('normal')).toBe('');
    expect(variantIcon('shiny')).not.toBe('');
    expect(variantIcon('golden')).not.toBe('');
    expect(variantIcon('shiny')).not.toBe(variantIcon('golden'));
  });
});

describe('palette dorée', () => {
  it('tire chaque canal vers l’or tout en restant distincte de l’espèce', () => {
    const chicken = config.animals.get('chicken');
    if (!chicken?.palette) throw new Error('configuration sans palette de poule');
    const golden = goldenPalette(chicken.palette);
    for (const channel of ['body', 'bodyDark', 'accent', 'accentDark'] as const) {
      expect(golden[channel]).not.toBe(chicken.palette[channel]);
      expect(golden[channel]).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    }
    // Le corps doré est chaud : plus de rouge et de vert que de bleu.
    const [r, g, b] = golden.body.match(/\d+/g)!.map(Number);
    expect(r!).toBeGreaterThan(b!);
    expect(g!).toBeGreaterThan(b!);
  });
});
