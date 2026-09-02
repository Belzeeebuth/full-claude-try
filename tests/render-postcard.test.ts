import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { ALT_TEXT_MAX_LENGTH } from '../src/render/alt-text';
import {
  CAPTION_MAX_LENGTH,
  describePostcard,
  growthStageIndex,
  pickStampSubject,
  postmarkDate,
  renderPostcard,
  sanitizeCaption,
  type PostcardAnimal,
  type PostcardPlot,
  type PostcardRenderInput,
} from '../src/render/postcard';

/**
 * Carte postale de `/postcard` : une image PUBLIQUE, bâtie sur des textes
 * choisis par le joueur.
 *
 * Ce qu'on vérifie : que la légende ne peut pas servir de support de spam
 * (mentions, liens, markdown), que l'image sort au format annoncé et à
 * l'identique d'un rendu à l'autre (le cache en dépend), et que le texte
 * alternatif tient dans la limite de Discord tout en disant ce que l'image
 * montre. Pas de PNG de référence : une police différente le changerait.
 */

const LOCALES = ['fr', 'en'] as const;

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** Dimensions lues dans le bloc IHDR, qui suit immédiatement la signature PNG. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Légende
// ---------------------------------------------------------------------------

describe('nettoyage de la légende', () => {
  it('laisse passer une phrase ordinaire, accents et ponctuation compris', () => {
    expect(sanitizeCaption("Premiers melons de l'été, venez goûter !")).toBe("Premiers melons de l'été, venez goûter !");
  });

  it('vide, absente ou faite de blancs : chaîne vide', () => {
    expect(sanitizeCaption(null)).toBe('');
    expect(sanitizeCaption(undefined)).toBe('');
    expect(sanitizeCaption('   \n\t ')).toBe('');
  });

  it('retire les mentions Discord, y compris @everyone et @here', () => {
    expect(sanitizeCaption('Coucou <@123456789012345678> et <@!42> et <@&7> et <#99>')).toBe('Coucou et et et');
    expect(sanitizeCaption('@everyone venez voir @here')).toBe('venez voir');
    expect(sanitizeCaption('@EVERYONE !')).toBe('!');
    // Un « @ » orphelin ne doit pas ressembler à une mention en capture d'écran.
    expect(sanitizeCaption('mail@ferme')).not.toContain('@');
  });

  it('retire les liens, avec ou sans schéma', () => {
    expect(sanitizeCaption('Rejoignez https://discord.gg/abc maintenant')).toBe('Rejoignez maintenant');
    expect(sanitizeCaption('Allez sur www.exemple.com/promo !')).toBe('Allez sur !');
    expect(sanitizeCaption('exemple.fr vend tout')).toBe('vend tout');
    expect(sanitizeCaption('Site : ferme.example.org/x?y=1')).toBe('Site :');
  });

  it('retire le markdown : gras, italique, code, spoiler, citation, titre', () => {
    expect(sanitizeCaption('**gras** _ital_ ~~barré~~ `code` ||secret||')).toBe('gras ital barré code secret');
    expect(sanitizeCaption('> citation')).toBe('citation');
    expect(sanitizeCaption('# Titre')).toBe('Titre');
    expect(sanitizeCaption('\\*échappé\\*')).toBe('échappé');
  });

  it("aplatit sur une ligne et retire les caractères invisibles", () => {
    expect(sanitizeCaption('ligne 1\nligne 2\r\nligne 3\tfin')).toBe('ligne 1 ligne 2 ligne 3 fin');
    expect(sanitizeCaption('a​b‮c﻿d')).toBe('abcd');
    expect(sanitizeCaption('trop    d   espaces')).toBe('trop d espaces');
  });

  it(`borne à ${CAPTION_MAX_LENGTH} points de code sans couper un emoji`, () => {
    const long = 'a'.repeat(CAPTION_MAX_LENGTH + 20);
    expect(Array.from(sanitizeCaption(long))).toHaveLength(CAPTION_MAX_LENGTH);
    const emojis = '🌻'.repeat(CAPTION_MAX_LENGTH + 5);
    const cleaned = sanitizeCaption(emojis);
    expect(Array.from(cleaned)).toHaveLength(CAPTION_MAX_LENGTH);
    expect(cleaned).toBe('🌻'.repeat(CAPTION_MAX_LENGTH));
  });

  it('est idempotent : nettoyer deux fois ne change rien', () => {
    const once = sanitizeCaption('**@everyone** voir https://x.io\nvite');
    expect(sanitizeCaption(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// Fonctions pures annexes
// ---------------------------------------------------------------------------

describe('stade, timbre et cachet', () => {
  it('convertit les stades du moteur en index de dessin, 1 par défaut', () => {
    expect(growthStageIndex('planted')).toBe(1);
    expect(growthStageIndex('sprouting')).toBe(2);
    expect(growthStageIndex('growing')).toBe(3);
    expect(growthStageIndex('maturing')).toBe(4);
    expect(growthStageIndex('ready')).toBe(5);
    expect(growthStageIndex('withered')).toBe(5);
    expect(growthStageIndex('inconnu')).toBe(1);
  });

  it('choisit la culture la plus plantée, sinon la bête la plus nombreuse, sinon rien', () => {
    const crop = (key: string, withered = false): Pick<PostcardPlot, 'locked' | 'crop'> => ({
      locked: false,
      crop: { key, stage: 3, ready: false, withered },
    });
    expect(pickStampSubject([crop('wheat'), crop('tomato'), crop('tomato')], [{ animalKey: 'cow' }])).toEqual({
      kind: 'crop',
      key: 'tomato',
    });
    // Une culture fanée ne fait pas un joli timbre ; une parcelle verrouillée ne compte pas.
    expect(
      pickStampSubject([crop('wheat', true), { locked: true, crop: { key: 'melon', stage: 5, ready: true, withered: false } }], [
        { animalKey: 'cow' },
        { animalKey: 'chicken' },
        { animalKey: 'cow' },
      ]),
    ).toEqual({ kind: 'animal', key: 'cow' });
    expect(pickStampSubject([{ locked: false, crop: null }], [])).toBeNull();
    // Ex æquo : la première rencontrée, donc stable d'un rendu à l'autre.
    expect(pickStampSubject([crop('grape'), crop('wheat')], [])).toEqual({ kind: 'crop', key: 'grape' });
  });

  it('date le cachet dans la langue et le fuseau du fermier', () => {
    const late = new Date('2026-09-02T23:30:00Z');
    expect(postmarkDate(late, 'fr', 'Europe/Paris')).toBe('3 sept. 2026');
    expect(postmarkDate(late, 'en', 'Europe/Paris')).toBe('Sep 3, 2026');
    expect(postmarkDate(late, 'fr', 'UTC')).toBe('2 sept. 2026');
    // Un fuseau invalide ne fait pas échouer la carte.
    expect(postmarkDate(late, 'fr', 'Mars/Olympus')).toMatch(/sept\. 2026$/);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function animalsOf(keys: string[]): PostcardAnimal[] {
  const catalog = getConfig('fr');
  return keys.map((key) => {
    const species = catalog.animals.get(key);
    if (!species) throw new Error(`espèce inconnue : ${key}`);
    return { animalKey: key, emoji: species.emoji, form: species.form ?? null, palette: species.palette ?? null };
  });
}

function plotsOf(width: number, height: number, fill: (slot: number) => PostcardPlot['crop']): PostcardPlot[] {
  const plots: PostcardPlot[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const slot = y * width + x + 1;
      plots.push({ slot, x, y, locked: false, fertility: 40 + ((slot * 7) % 60), crop: fill(slot) });
    }
  }
  return plots;
}

function postcard(locale: string, overrides: Partial<PostcardRenderInput> = {}): PostcardRenderInput {
  const keys = ['wheat', 'tomato', 'melon', 'grape'];
  const plots = plotsOf(5, 5, (slot) =>
    slot % 4 === 0
      ? null
      : { key: keys[slot % keys.length]!, stage: 1 + (slot % 5), ready: slot % 5 === 4, withered: slot === 13 },
  );
  const animals = animalsOf(['chicken', 'cow', 'sheep']);
  return {
    locale,
    farmId: 'farm-test',
    farmName: 'Ferme des Trois Chênes',
    farmer: { name: 'Marion', level: 24, prestige: 1, coins: 1_284_500 },
    caption: "Premiers melons de l'été, venez goûter !",
    date: new Date('2026-09-02T10:00:00Z'),
    timezone: 'Europe/Paris',
    season: 'summer',
    weather: { weather: 'sunny', label: 'Ensoleillé', temperature: 26 },
    grid: { width: 5, height: 5 },
    plots,
    animals,
    buildings: [
      { key: 'house', tier: 2 },
      { key: 'barn', tier: 3 },
    ],
    stamp: pickStampSubject(plots, animals),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

describe('rendu de la carte postale', () => {
  it.each(LOCALES)('%s : produit un PNG non vide, aux dimensions de balance.render.postcard', async (locale) => {
    const buffer = await renderPostcard(postcard(locale));
    expect(isPng(buffer)).toBe(true);
    // Une carte vraiment dessinée pèse bien plus qu'un aplat de papier.
    expect(buffer.byteLength).toBeGreaterThan(20_000);
    expect(pngSize(buffer)).toEqual(getBalance().render.postcard);
  });

  it('est déterministe : même entrée, même PNG — le cache en dépend', async () => {
    const first = await renderPostcard(postcard('fr'));
    const second = await renderPostcard(postcard('fr'));
    expect(first.equals(second)).toBe(true);
  });

  it('change avec la légende, la ferme et la date', async () => {
    const base = await renderPostcard(postcard('fr'));
    const captioned = await renderPostcard(postcard('fr', { caption: 'Autre légende' }));
    const otherFarm = await renderPostcard(postcard('fr', { farmId: 'farm-other' }));
    const otherDay = await renderPostcard(postcard('fr', { date: new Date('2026-12-24T10:00:00Z') }));
    expect(base.equals(captioned)).toBe(false);
    expect(base.equals(otherFarm)).toBe(false);
    expect(base.equals(otherDay)).toBe(false);
  });

  it('dessine une ferme vide, privée, sans bête ni bâtiment ni timbre imposé', async () => {
    const buffer = await renderPostcard(
      postcard('en', {
        plots: plotsOf(3, 3, () => null),
        grid: { width: 3, height: 3 },
        animals: [],
        buildings: [],
        caption: '',
        stamp: null,
        season: 'winter',
        weather: { weather: 'snow', label: 'Neige', temperature: -3 },
        farmer: { name: 'A very long farmer display name indeed', level: 3, prestige: 0, coins: null },
      }),
    );
    expect(isPng(buffer)).toBe(true);
  });

  it('tient une 8×8 pleine, neuf bêtes et sept bâtiments, avec une légende de 60 caractères', async () => {
    const keys = getConfig('fr').cropList.map((crop) => crop.key);
    const plots = plotsOf(8, 8, (slot) => ({ key: keys[slot % keys.length]!, stage: 5, ready: true, withered: false }));
    const buffer = await renderPostcard(
      postcard('fr', {
        plots,
        grid: { width: 8, height: 8 },
        animals: animalsOf(['chicken', 'chicken', 'duck', 'cow', 'pig', 'sheep', 'bee', 'goat', 'horse']),
        buildings: ['house', 'barn', 'coop', 'well', 'greenhouse', 'mill', 'apiary'].map((key) => ({ key, tier: 2 })),
        caption: 'Soixante caractères pile pour cette légende là, vraiment !!',
        season: 'autumn',
        weather: { weather: 'rainy', label: 'Pluie', temperature: 14 },
      }),
    );
    expect(isPng(buffer)).toBe(true);
    expect(pngSize(buffer)).toEqual(getBalance().render.postcard);
  });

  it('un timbre dont le sujet a disparu du catalogue retombe sur une culture de saison', async () => {
    const buffer = await renderPostcard(postcard('fr', { stamp: { kind: 'crop', key: 'culture-disparue' } }));
    expect(isPng(buffer)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Texte alternatif
// ---------------------------------------------------------------------------

/** Une clé qui fuit dans le texte est une phrase manquante dans un fragment. */
const LEAKED_KEY = /render_alt\.|render\.postcard|world\.(?:weather|season)\./;

describe('texte alternatif de la carte', () => {
  it.each(LOCALES)('%s : tient dans la limite de Discord et ne laisse fuir aucune clé', (locale) => {
    const text = describePostcard(postcard(locale));
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text).not.toMatch(LEAKED_KEY);
  });

  it('en français : qui, quoi, quel temps, ce que montre la photo, le cachet', () => {
    const text = describePostcard(postcard('fr'));
    expect(text).toContain('Ferme des Trois Chênes');
    expect(text).toContain('Marion');
    expect(text).toContain('niveau 24');
    expect(text).toContain('Prestige 1');
    expect(text).toContain("Premiers melons de l'été");
    expect(text).toContain('Été');
    expect(text).toContain('Ensoleillé');
    expect(text).toContain('26 °C');
    // 25 parcelles, 6 vides (multiples de 4), moins la fanée n° 13 : 18.
    expect(text).toContain('18 culture(s)');
    expect(text).toContain('3 animal(aux)');
    expect(text).toContain('2 bâtiment(s)');
    expect(text).toContain('2 sept. 2026');
    // Le séparateur de milliers français d'ICU est une espace fine insécable ;
    // on ne présume pas de son point de code exact.
    expect(text).toMatch(/1\D284\D500 pièces/);
  });

  it('en anglais : même contenu, autre langue', () => {
    const text = describePostcard(postcard('en'));
    expect(text).toContain('sent by Marion, level 24');
    expect(text).toContain('Summer');
    expect(text).toContain('Sunny');
    expect(text).toContain('18 crop(s)');
    expect(text).toContain('Sep 2, 2026');
    expect(text).toContain('1,284,500 coins');
    expect(text).not.toBe(describePostcard(postcard('fr')));
  });

  it('ferme privée : les pièces ne sont ni dessinées ni décrites', () => {
    const text = describePostcard(postcard('fr', { farmer: { name: 'Marion', level: 24, prestige: 0, coins: null } }));
    expect(text).not.toContain('pièces');
    expect(text).not.toContain('Prestige');
  });

  it('champ vide et légende absente : salutation par défaut et « champ encore vide »', () => {
    const text = describePostcard(
      postcard('fr', { plots: plotsOf(3, 3, () => null), animals: [], buildings: [], caption: '', stamp: null }),
    );
    expect(text).toContain('Bien le bonjour de la ferme !');
    expect(text).toContain('champ encore vide');
    // Le timbre porte toujours quelque chose : une culture de saison.
    expect(text).toContain("Timbre à l'effigie d'une culture");
  });

  it('reste borné même avec les textes les plus longs possibles', () => {
    const text = describePostcard(
      postcard('fr', {
        farmName: 'F'.repeat(64),
        farmer: { name: 'N'.repeat(32), level: 999, prestige: 99, coins: 999_999_999_999 },
        caption: 'L'.repeat(CAPTION_MAX_LENGTH),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
  });

  it('est identique d’un appel à l’autre : aucune horloge cachée', () => {
    const input = postcard('en');
    expect(describePostcard(input)).toBe(describePostcard(input));
  });
});
