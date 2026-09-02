import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { animalForms, type AnimalPalette } from '../src/config/gameplay/schemas';
import { ALT_TEXT_MAX_LENGTH } from '../src/render/alt-text';
import {
  MAX_VISIBLE_ANIMALS,
  animalIndicators,
  describeAnimals,
  renderAnimals,
  type AnimalsRenderAnimal,
  type AnimalsRenderInput,
} from '../src/render/animals';
import { newCanvas } from '../src/render/canvas';
import { animalSkin, drawAnimalForm } from '../src/render/sprites';

/**
 * Basse-cour de `/animals` : la silhouette porte l'espèce, le texte alternatif
 * porte ce que l'image montre.
 *
 * On ne compare pas des PNG de référence — une police différente les
 * changerait — mais des propriétés : chaque forme dessine quelque chose, et
 * pas la même chose qu'une autre ; le rendu est reproductible ; la description
 * tient dans la limite de Discord et porte les mêmes chiffres que l'image.
 */

const LOCALES = ['fr', 'en'] as const;

const PALETTE: AnimalPalette = {
  body: '#e8d9b5',
  bodyDark: '#c7b284',
  accent: '#d9463c',
  accentDark: '#9e2e26',
};

/** Somme de contrôle des pixels et nombre de pixels peints, sur une toile transparente. */
function fingerprint(draw: (ctx: ReturnType<typeof newCanvas>['ctx']) => void, size = 96): { hash: number; painted: number } {
  const { ctx } = newCanvas(size, size);
  draw(ctx);
  const data = ctx.getImageData(0, 0, size, size).data;
  let hash = 2166136261;
  let painted = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]!;
    if (alpha > 0) painted += 1;
    hash ^= data[index]! ^ (data[index + 1]! << 8) ^ (data[index + 2]! << 16) ^ (alpha << 24);
    hash = Math.imul(hash, 16777619);
  }
  return { hash: hash >>> 0, painted };
}

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

describe('silhouettes par espèce', () => {
  it('chaque forme dessine une image non vide, distincte des autres', () => {
    const seen = new Map<number, string>();
    for (const form of animalForms) {
      const { hash, painted } = fingerprint((ctx) =>
        drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form, palette: PALETTE, seed: 3 }),
      );
      // Une silhouette de 96 px couvre au moins un dixième de sa boîte ;
      // en dessous, c'est un point ou une erreur de coordonnées.
      expect(painted, form).toBeGreaterThan(96 * 96 * 0.1);
      const twin = seen.get(hash);
      expect(twin, `${form} est identique à ${String(twin)}`).toBeUndefined();
      seen.set(hash, form);
    }
    expect(seen.size).toBe(animalForms.length);
  });

  it('reste lisible à 34 px : chaque forme peint encore une vraie surface', () => {
    for (const form of animalForms) {
      const { painted } = fingerprint(
        (ctx) => drawAnimalForm(ctx, { x: 0, y: 0, size: 34, form, palette: PALETTE }),
        34,
      );
      expect(painted, form).toBeGreaterThan(34 * 34 * 0.1);
    }
  });

  it('est déterministe : même entrée, mêmes pixels', () => {
    const draw = (ctx: ReturnType<typeof newCanvas>['ctx']): void =>
      drawAnimalForm(ctx, { x: 4, y: 4, size: 80, form: 'hoofed', palette: PALETTE, seed: 7 });
    expect(fingerprint(draw).hash).toBe(fingerprint(draw).hash);
  });

  it('le miroir, la graine et les indicateurs changent réellement le dessin', () => {
    const base = fingerprint((ctx) =>
      drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form: 'fowl', palette: PALETTE, seed: 1 }),
    ).hash;
    const mirrored = fingerprint((ctx) =>
      drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form: 'fowl', palette: PALETTE, seed: 1, facing: -1 }),
    ).hash;
    const otherSeed = fingerprint((ctx) =>
      drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form: 'fowl', palette: PALETTE, seed: 2 }),
    ).hash;
    const sick = fingerprint((ctx) =>
      drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form: 'fowl', palette: PALETTE, seed: 1, sick: true }),
    ).hash;
    const sleeping = fingerprint((ctx) =>
      drawAnimalForm(ctx, { x: 0, y: 0, size: 96, form: 'fowl', palette: PALETTE, seed: 1, sleeping: true }),
    ).hash;
    expect(new Set([base, mirrored, otherSeed, sick, sleeping]).size).toBe(5);
  });

  it("résout l'apparence depuis le catalogue, et rien sans forme", () => {
    const chicken = getConfig('fr').animals.get('chicken');
    expect(chicken).toBeDefined();
    const skin = animalSkin(chicken);
    expect(skin?.form).toBe('fowl');
    expect(skin?.palette.body).toBe(chicken!.palette!.body);
    expect(animalSkin(undefined)).toBeUndefined();
    expect(animalSkin({ form: 'fowl', palette: null })).toBeUndefined();
  });

  it('toutes les espèces du catalogue se dessinent sans erreur', () => {
    for (const animal of getConfig('fr').animalList) {
      const skin = animalSkin(animal);
      expect(skin, animal.key).toBeDefined();
      const { painted } = fingerprint((ctx) =>
        drawAnimalForm(ctx, { x: 0, y: 0, size: 64, form: skin!.form, palette: skin!.palette }),
      );
      expect(painted, animal.key).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures de basse-cour, construites à la main comme dans `render-preview.ts`
// ---------------------------------------------------------------------------

function animal(index: number, key: string, overrides: Partial<AnimalsRenderAnimal> = {}): AnimalsRenderAnimal {
  const species = getConfig('fr').animals.get(key);
  if (!species) throw new Error(`espèce inconnue : ${key}`);
  return {
    id: `a-${String(index).padStart(3, '0')}`,
    animalKey: key,
    name: species.name,
    nickname: null,
    emoji: species.emoji,
    form: species.form ?? null,
    palette: species.palette ?? null,
    buildingKey: species.buildingKey,
    hunger: 80,
    happiness: 75,
    health: 100,
    hungry: false,
    sick: false,
    canCollect: false,
    canFeed: true,
    canPet: false,
    readyProduction: 0,
    productEmoji: '🥚',
    ...overrides,
  };
}

function barnyard(locale: string, overrides: Partial<AnimalsRenderInput> = {}): AnimalsRenderInput {
  return {
    locale,
    farmId: 'farm-test',
    ownerName: 'Marion',
    season: 'summer',
    weather: 'sunny',
    buildings: [
      { key: 'coop', name: 'Poulailler', tier: 2, capacity: 8, used: 3 },
      { key: 'barn', name: 'Étable', tier: 1, capacity: 3, used: 2 },
      { key: 'apiary', name: 'Rucher', tier: 1, capacity: 3, used: 0 },
    ],
    animals: [
      animal(1, 'chicken', { nickname: 'Poulette', hungry: true, hunger: 20 }),
      animal(2, 'chicken', { canCollect: true, readyProduction: 2 }),
      animal(3, 'duck', { canPet: true, happiness: 40 }),
      animal(4, 'cow', { nickname: 'Marguerite', sick: true, health: 50 }),
      animal(5, 'pig', { happiness: 95, hunger: 90 }),
    ],
    totals: { alive: 5, hungry: 1, sick: 1, ready: 1 },
    ...overrides,
  };
}

describe('indicateurs actionnables', () => {
  it('ne signale que ce sur quoi le joueur peut agir', () => {
    expect(animalIndicators(animal(1, 'chicken', { hungry: true }))).toMatchObject({ feed: true, sleeping: false });
    expect(animalIndicators(animal(1, 'chicken', { hungry: true, canFeed: false })).feed).toBe(false);
    expect(animalIndicators(animal(1, 'chicken', { canCollect: true })).ready).toBe(true);
    expect(animalIndicators(animal(1, 'chicken', { sick: true })).sick).toBe(true);
  });

  it('ne dessine un cœur que si la caresse compte : bonheur bas', () => {
    expect(animalIndicators(animal(1, 'chicken', { canPet: true, happiness: 40 })).pet).toBe(true);
    expect(animalIndicators(animal(1, 'chicken', { canPet: true, happiness: 90 })).pet).toBe(false);
  });

  it('une bête heureuse et sans rien à faire dort', () => {
    const resting = animalIndicators(animal(1, 'pig', { happiness: 95, hunger: 90 }));
    expect(resting).toEqual({ ready: false, feed: false, sick: false, pet: false, sleeping: true });
    expect(animalIndicators(animal(1, 'pig', { happiness: 95, canCollect: true })).sleeping).toBe(false);
  });
});

describe('rendu de la basse-cour', () => {
  it.each(LOCALES)('%s : produit un PNG reproductible', async (locale) => {
    const first = await renderAnimals(barnyard(locale));
    const second = await renderAnimals(barnyard(locale));
    expect(isPng(first)).toBe(true);
    expect(first.equals(second)).toBe(true);
  });

  it('sans bâtiment : dessine quand même une scène', async () => {
    const buffer = await renderAnimals(barnyard('fr', { buildings: [], animals: [], totals: { alive: 0, hungry: 0, sick: 0, ready: 0 } }));
    expect(isPng(buffer)).toBe(true);
  });

  it('avec 40 bêtes : borne le dessin sans échouer', async () => {
    const many = Array.from({ length: 40 }, (_, index) => animal(index + 1, 'chicken'));
    const buffer = await renderAnimals(
      barnyard('fr', {
        buildings: [{ key: 'coop', name: 'Poulailler', tier: 4, capacity: 32, used: 40 }],
        animals: many,
        totals: { alive: 40, hungry: 0, sick: 0, ready: 0 },
      }),
    );
    expect(isPng(buffer)).toBe(true);
  });

  it('une espèce sans forme retombe sur la silhouette générique', async () => {
    const buffer = await renderAnimals(
      barnyard('fr', { animals: [animal(1, 'chicken', { form: null, palette: null })] }),
    );
    expect(isPng(buffer)).toBe(true);
  });
});

/** Une clé qui fuit dans le texte est une phrase manquante dans un fragment. */
const LEAKED_KEY = /render_alt\.|world\.(?:weather|season)\./;

const EXPECTED: Record<(typeof LOCALES)[number], string[]> = {
  fr: [
    'Basse-cour de Marion',
    'Été',
    'Ensoleillé',
    '5 animal(aux), 1 affamé(s), 1 malade(s), 1 à collecter',
    'Poulailler (palier 2), 3 / 8',
    'Rucher (palier 1), vide, 3 place(s)',
    'Poulette (Poule)',
    'À collecter :',
    'À nourrir : Poulette (Poule)',
    'Malades, à soigner : Marguerite (Vache)',
    'À caresser : Canard',
  ],
  en: [
    "Marion's barnyard",
    'Summer',
    'Sunny',
    '5 animal(s), 1 hungry, 1 sick, 1 to collect',
    'Poulailler (tier 2), 3 / 8',
    'Rucher (tier 1), empty, 3 slot(s)',
    'Poulette (Poule)',
    'To collect:',
    'To feed: Poulette (Poule)',
    'Sick, to treat: Marguerite (Vache)',
    'To pet: Canard',
  ],
};

describe('texte alternatif de la basse-cour', () => {
  it.each(LOCALES)('%s : compteurs, enclos et actions, sous la limite de Discord', (locale) => {
    const text = describeAnimals(barnyard(locale));
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text).not.toMatch(LEAKED_KEY);
    for (const needle of EXPECTED[locale]) expect(text).toContain(needle);
  });

  it('est traduite : les deux langues ne disent pas la même chose', () => {
    expect(describeAnimals(barnyard('fr'))).not.toBe(describeAnimals(barnyard('en')));
  });

  it('sans bâtiment : le dit, et ne liste rien', () => {
    const text = describeAnimals(
      barnyard('fr', { buildings: [], animals: [], totals: { alive: 0, hungry: 0, sick: 0, ready: 0 } }),
    );
    expect(text).toContain('Aucun bâtiment');
    expect(text).not.toContain('À nourrir');
  });

  it.each(LOCALES)('%s : borne les listes avec 60 bêtes affamées et annonce les non dessinées', (locale) => {
    const many = Array.from({ length: 60 }, (_, index) =>
      animal(index + 1, 'chicken', { nickname: `Poulette au nom particulièrement long numéro ${index + 1}`, hungry: true }),
    );
    const text = describeAnimals(
      barnyard(locale, {
        buildings: [{ key: 'coop', name: 'Poulailler', tier: 4, capacity: 64, used: 60 }],
        animals: many,
        totals: { alive: 60, hungry: 60, sick: 0, ready: 0 },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text).toContain(String(60 - MAX_VISIBLE_ANIMALS));
  });
});
