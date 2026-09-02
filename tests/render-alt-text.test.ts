import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrowthState } from '../src/game/growth';
import { ALT_TEXT_MAX_LENGTH, clampAltText, listSome } from '../src/render/alt-text';
import { describeChart, type ChartInput } from '../src/render/chart';
import { describeFarm, type FarmRenderInput } from '../src/render/farm';
import { describeFishing } from '../src/render/fishing';
import { describeLeaderboard, type LeaderboardRenderInput } from '../src/render/leaderboard';
import { describeMining } from '../src/render/mining';
import { describeProfile, type ProfileRenderInput } from '../src/render/profile';
import type { FarmView, PlotView } from '../src/services/farm.service';
import { formatNumber } from '../src/utils/format';

/**
 * Textes alternatifs des images (constat C-01 de l'audit).
 *
 * Toute l'interface est une image : ce que lit un lecteur d'écran est
 * EXACTEMENT ce que renvoient ces fonctions. On vérifie donc trois choses, en
 * français et en anglais : qu'elles disent quelque chose, qu'elles tiennent
 * dans la limite de Discord (1 024 caractères, au-delà la pièce jointe est
 * refusée en bloc), et qu'elles portent les chiffres que l'image montre — pas
 * une paraphrase vague.
 */

const LOCALES = ['fr', 'en'] as const;
type Locale = (typeof LOCALES)[number];

/** Une clé qui fuit dans le texte est une phrase manquante dans un fragment. */
const LEAKED_KEY = /render_alt\.|world\.(?:weather|season)\.|farm\.pest_|pets\.catalog\./;

function expectWellFormed(text: string): void {
  expect(text.length).toBeGreaterThan(0);
  expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
  expect(text).not.toMatch(LEAKED_KEY);
}

// ---------------------------------------------------------------------------
// Fixtures : construites à la main, comme dans `render-preview.ts`, sans base
// ---------------------------------------------------------------------------

function crop(name: string, growth: Partial<GrowthState> = {}): NonNullable<PlotView['crop']> {
  return {
    key: name.toLowerCase(),
    name,
    emoji: '🌱',
    rarity: 'common',
    growth: {
      stage: 'growing',
      progress: 0.5,
      ready: false,
      withered: false,
      msRemaining: 3_600_000,
      readyAt: new Date(0),
      withersAt: null,
      needsWater: false,
      missedWaterings: 0,
      nextWaterAt: null,
      ...growth,
    },
    mutation: 'none',
    regrowRemaining: 0,
    waterGiven: 0,
    waterNeeded: 2,
    fertilizerKey: null,
  };
}

function plot(slot: number, overrides: Partial<PlotView> = {}): PlotView {
  return {
    slot,
    x: (slot - 1) % 8,
    y: Math.floor((slot - 1) / 8),
    state: 'empty',
    fertility: 60,
    fertilityLabel: 'ok',
    weedLevel: 0,
    pestType: null,
    pestDeadlineAt: null,
    unlockCost: 800,
    ...overrides,
  };
}

const WORLD = {
  season: {
    season: 'summer',
    index: 1,
    gameYear: 1,
    startsAt: new Date(0),
    endsAt: new Date(0),
    key: 'summer_y1',
    progress: 0.4,
  },
  weather: {
    weather: 'sunny',
    emoji: '☀️',
    label: 'Soleil',
    description: '',
    yieldModifier: 1,
    growthModifier: 1,
    freeWatering: false,
    damageChance: 0,
    pestChance: 0,
    temperature: 27,
    season: 'summer',
    day: '2026-07-26',
  },
  activeEvents: [],
  eventModifiers: {},
} as unknown as FarmView['world'];

function farmInput(locale: string, overrides: Partial<FarmRenderInput> = {}): FarmRenderInput {
  const plots = [
    plot(1, { state: 'ready', crop: crop('Blé', { stage: 'ready', progress: 1, ready: true, msRemaining: 0 }) }),
    plot(2, { state: 'growing', crop: crop('Tomate', { msRemaining: 15 * 60_000, needsWater: true }) }),
    plot(3, { state: 'growing', pestType: 'insects', crop: crop('Citrouille', { msRemaining: 2 * 3_600_000 }) }),
    plot(4, { state: 'withered', crop: crop('Melon', { stage: 'withered', withered: true, msRemaining: 0 }) }),
    plot(5),
    plot(6, { state: 'locked' }),
  ];
  return {
    locale,
    view: {
      farmId: 'farm-test',
      name: 'Ferme des Trois Chênes',
      grid: { width: 5, height: 5 },
      plots,
      counts: { ready: 1, growing: 2, empty: 1, locked: 1, withered: 1, pests: 1 },
      world: WORLD,
      modifiers: {} as FarmView['modifiers'],
      nextReadyAt: new Date(0),
      unlockedPlots: 5,
      nextPlotCost: 800,
    },
    player: { username: 'Marion', level: 24, coins: 950, gems: 12, avatarUrl: null },
    xp: { current: 420, needed: 980 },
    animalsPreview: [{ emoji: '🐔', animalKey: 'chicken' }],
    buildingsPreview: [
      { key: 'barn', tier: 1 },
      { key: 'well', tier: 1 },
    ],
    equippedPetKey: 'fox',
    ...overrides,
  };
}

function profileInput(locale: string): ProfileRenderInput {
  return {
    locale,
    username: 'marion',
    displayName: 'Marion des Champs',
    avatarUrl: null,
    title: null,
    badges: ['🏆', '🌾'],
    level: 24,
    prestige: 1,
    xp: { current: 420, needed: 980 },
    coins: 950,
    gems: 12,
    bank: 450,
    energy: { current: 78, max: 130 },
    stats: {
      harvests: 12_480,
      animals: 63,
      crafts: 204,
      plots: 25,
      streak: 34,
      achievements: 17,
      bestHarvest: 842,
      coinsEarned: 8_940,
    },
    coop: { name: 'Les Amis du Blé', tag: 'BLE', level: 7, role: 'officer' },
    themeColor: '#7ec850',
    farmName: 'Ferme des Trois Chênes',
    createdAt: new Date(2026, 1, 14, 12, 0, 0),
  };
}

function chartInput(locale: string, overrides: Partial<ChartInput> = {}): ChartInput {
  const start = new Date(2026, 6, 25, 9, 0, 0).getTime();
  return {
    locale,
    title: 'Melon',
    emoji: '🍈',
    points: Array.from({ length: 24 }, (_, index) => ({
      price: index === 3 ? 70 : index === 20 ? 110 : 90 + (index % 5),
      recordedAt: new Date(start + index * 3_600_000),
    })),
    basePrice: 90,
    currentPrice: 112,
    trend: 0.083,
    demandIndex: 1.12,
    ...overrides,
  };
}

function leaderboardInput(locale: string, overrides: Partial<LeaderboardRenderInput> = {}): LeaderboardRenderInput {
  return {
    locale,
    title: 'Harvests',
    emoji: '🌾',
    unit: 'pts',
    scopeLabel: 'Global',
    entries: Array.from({ length: 12 }, (_, index) => ({
      rank: index + 1,
      name: index === 0 ? 'Marion' : `Player ${index + 1}`,
      score: 980 - index * 40,
      extra: index === 0 ? 'lvl 24' : '',
    })),
    viewer: { rank: 42, score: 15 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ferme
// ---------------------------------------------------------------------------

const FARM_EXPECTED: Record<Locale, string[]> = {
  fr: [
    'Été',
    'Ensoleillé',
    '27 °C',
    '1 prête(s), 2 en croissance, 1 vide(s), 1 verrouillée(s)',
    'Prochaine récolte dans 15 min : parcelle 2 (Tomate)',
    'À récolter : parcelle 1 (Blé)',
    'À arroser : parcelle 2 (Tomate)',
    'À traiter : parcelle 3 (Citrouille, Insectes)',
    'Flétries : parcelle 4 (Melon)',
    '1 animal(aux)',
    '2 bâtiment(s)',
  ],
  en: [
    'Summer',
    'Sunny',
    '27 °C',
    '1 ready, 2 growing, 1 empty, 1 locked',
    'Next harvest in 15 min: plot 2 (Tomate)',
    'To harvest: plot 1 (Blé)',
    'To water: plot 2 (Tomate)',
    'To treat: plot 3 (Citrouille, Insects)',
    'Withered: plot 4 (Melon)',
    '1 animal(s)',
    '2 building(s)',
  ],
};

describe('texte alternatif de la ferme', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(LOCALES)('%s : nom, météo, compteurs, prochaine récolte et parcelles à traiter', (locale) => {
    const text = describeFarm(farmInput(locale));
    expectWellFormed(text);
    for (const needle of ['Ferme des Trois Chênes', 'Marion', '24', '950', '12', '420', '980', ...FARM_EXPECTED[locale]]) {
      expect(text).toContain(needle);
    }
  });

  it('est traduite : les deux langues ne disent pas la même chose mot pour mot', () => {
    expect(describeFarm(farmInput('fr'))).not.toBe(describeFarm(farmInput('en')));
  });

  it("ne dépend pas de l'horloge : deux appels à des instants différents sont identiques", () => {
    // La prochaine récolte se lit dans `msRemaining`, figé par le service au
    // moment de la vue, pas dans `Date.now()` — sinon l'image en cache et sa
    // description divergeraient à chaque affichage.
    const input = farmInput('fr');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 26, 10, 0, 0));
    const first = describeFarm(input);
    vi.setSystemTime(new Date(2026, 6, 28, 18, 30, 0));
    expect(describeFarm(input)).toBe(first);
  });

  it('sans culture : le dit, sans lister de parcelles', () => {
    const text = describeFarm(
      farmInput('fr', {
        view: {
          ...farmInput('fr').view,
          plots: [plot(1), plot(2, { state: 'locked' })],
          counts: { ready: 0, growing: 0, empty: 1, locked: 1, withered: 0, pests: 0 },
        },
        equippedPetKey: null,
        animalsPreview: [],
        buildingsPreview: [],
      }),
    );
    expectWellFormed(text);
    expect(text).toContain('Aucune culture en terre.');
    expect(text).not.toContain('À arroser');
    expect(text).not.toContain('Compagnon');
  });

  it('borne les listes et reste sous la limite de Discord avec 64 parcelles', () => {
    const plots = Array.from({ length: 64 }, (_, index) =>
      plot(index + 1, {
        state: 'growing',
        pestType: 'mole',
        crop: crop(`Culture au nom particulièrement long numéro ${index + 1}`, {
          msRemaining: 60_000 * (index + 1),
          needsWater: true,
        }),
      }),
    );
    const text = describeFarm(
      farmInput('fr', {
        view: {
          ...farmInput('fr').view,
          grid: { width: 8, height: 8 },
          plots,
          counts: { ready: 0, growing: 64, empty: 0, locked: 0, withered: 0, pests: 64 },
        },
      }),
    );
    expectWellFormed(text);
    expect(text).toContain('et 56 autre(s)');
  });

  it('tronque proprement un nom de ferme démesuré', () => {
    const input = farmInput('fr');
    input.view.name = Array.from({ length: 200 }, (_, index) => `mot${index}`).join(' ');
    const text = describeFarm(input);
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    // Le dernier mot conservé est un mot ENTIER du nom : jamais « mot15 » coupé en « mot1 ».
    const words = new Set(input.view.name.split(' '));
    const lastWord = /(\S+)…$/.exec(text)?.[1];
    expect(lastWord !== undefined && words.has(lastWord)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

describe('texte alternatif du profil', () => {
  it.each(LOCALES)('%s : niveau, XP, monnaies et statistiques en entier', (locale) => {
    const text = describeProfile(profileInput(locale));
    expectWellFormed(text);
    for (const needle of [
      'Marion des Champs',
      '24',
      '420',
      '980',
      '950',
      '12',
      '450',
      '78',
      '130',
      formatNumber(12_480, locale),
      formatNumber(8_940, locale),
      '25/64',
      '[BLE] Les Amis du Blé',
      'Ferme des Trois Chênes',
      locale === 'fr' ? '34 jour(s)' : '34 day(s)',
      locale === 'fr' ? 'Prestige 1' : 'Prestige 1',
      locale === 'fr' ? '2 badge(s) : 🏆 🌾' : '2 badge(s): 🏆 🌾',
      locale === 'fr' ? '14/02/2026' : '2/14/2026',
      locale === 'fr' ? 'Fermier' : 'Farmer',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('au niveau maximum, ne montre pas de fraction d\'XP', () => {
    const text = describeProfile({ ...profileInput('en'), xp: { current: 0, needed: 0 }, coop: null, badges: [] });
    expectWellFormed(text);
    expect(text).toContain('max level');
    expect(text).not.toContain('/ 0 XP');
    expect(text).not.toContain('Co-op');
    expect(text).not.toContain('badge');
  });
});

// ---------------------------------------------------------------------------
// Graphique de marché
// ---------------------------------------------------------------------------

describe('texte alternatif du graphique', () => {
  it.each(LOCALES)('%s : objet, prix, tendance, bornes et nombre de points', (locale) => {
    const text = describeChart(chartInput(locale));
    expectWellFormed(text);
    for (const needle of [
      'Melon',
      '112',
      '90',
      '70',
      '110',
      '24',
      '1.12',
      locale === 'fr' ? '+8,3 %' : '+8.3%',
      locale === 'fr' ? 'en hausse' : 'rising',
      // Bornes temporelles de l'historique, dans le format de date du spectateur.
      locale === 'fr' ? '25/07' : '07/25',
      locale === 'fr' ? '26/07' : '07/26',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('nomme la direction de la tendance', () => {
    expect(describeChart(chartInput('fr', { trend: -0.12 }))).toContain('en baisse');
    expect(describeChart(chartInput('en', { trend: -0.12 }))).toContain('falling');
    expect(describeChart(chartInput('fr', { trend: 0 }))).toContain('stable');
    expect(describeChart(chartInput('en', { trend: 0 }))).toContain('flat');
  });

  it("sans historique, n'invente ni date ni bornes", () => {
    const text = describeChart(chartInput('fr', { points: [] }));
    expectWellFormed(text);
    expect(text).toContain('Aucun historique');
    expect(text).not.toContain('Minimum');
  });
});

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------

describe('texte alternatif du classement', () => {
  it.each(LOCALES)('%s : titre, portée, dix classés et rang du spectateur', (locale) => {
    const text = describeLeaderboard(leaderboardInput(locale));
    expectWellFormed(text);
    for (const needle of [
      'Harvests',
      'Global',
      '#1 Marion, 980 pts (lvl 24)',
      '#2 Player 2, 940 pts',
      '#10 Player 10, 620 pts',
      locale === 'fr' ? 'Votre rang : #42 avec 15 pts' : 'Your rank: #42 with 15 pts',
    ]) {
      expect(text).toContain(needle);
    }
    // L'image s'arrête au dixième : la description aussi.
    expect(text).not.toContain('#11 ');
  });

  it('sans classé ni spectateur classé, le dit', () => {
    const text = describeLeaderboard(leaderboardInput('en', { entries: [], viewer: undefined }));
    expectWellFormed(text);
    expect(text).toContain('Nobody ranked yet.');
    expect(text).not.toContain('Your rank');
  });
});

// ---------------------------------------------------------------------------
// Pêche et mine
// ---------------------------------------------------------------------------

describe("texte alternatif de l'étang", () => {
  it.each(LOCALES)('%s : saison et météo', (locale) => {
    const text = describeFishing({ locale, season: 'autumn', weather: 'rainy' });
    expectWellFormed(text);
    expect(text).toContain(locale === 'fr' ? 'Automne' : 'Autumn');
    expect(text).toContain(locale === 'fr' ? 'Pluvieux' : 'Rainy');
  });

  it('retombe sur la clé brute pour une météo inconnue du catalogue, comme le bandeau dessiné', () => {
    expect(describeFishing({ locale: 'fr', season: 'spring', weather: 'sandstorm' })).toContain('sandstorm');
  });
});

describe('texte alternatif de la mine', () => {
  it.each(LOCALES)('%s : profondeur, record et paliers hors de portée', (locale) => {
    const text = describeMining({ locale, depth: 7, maxDepth: 12, deepestReached: 9 });
    expectWellFormed(text);
    for (const needle of [
      '20',
      '12',
      locale === 'fr' ? 'palier 7 sur 12' : 'level 7 of 12',
      locale === 'fr' ? 'Record personnel : palier 9' : 'Personal record: level 9',
      locale === 'fr' ? '8 palier(s) hors de portée' : '8 level(s) out of reach',
    ]) {
      expect(text).toContain(needle);
    }
  });

  it('tout débloqué et au record : ni palier verrouillé ni record séparé', () => {
    const text = describeMining({ locale: 'fr', depth: 20, maxDepth: 20, deepestReached: 20 });
    expectWellFormed(text);
    expect(text).not.toContain('hors de portée');
    expect(text).not.toContain('Record');
  });
});

// ---------------------------------------------------------------------------
// Troncature
// ---------------------------------------------------------------------------

describe('troncature du texte alternatif', () => {
  it('laisse intact un texte court, en normalisant les espaces', () => {
    expect(clampAltText('  Ferme   de Marion. ')).toBe('Ferme de Marion.');
  });

  it('laisse intact un texte exactement à la limite', () => {
    const exact = 'a'.repeat(ALT_TEXT_MAX_LENGTH);
    expect(clampAltText(exact)).toBe(exact);
  });

  it('coupe sur une frontière de mot, jamais au milieu, et termine par « … »', () => {
    const original = Array.from({ length: 400 }, (_, index) => `mot${index}`).join(' ');
    const text = clampAltText(original);
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    const head = text.slice(0, -1);
    expect(original.startsWith(head)).toBe(true);
    // Le caractère qui suit dans l'original est un espace : le dernier mot
    // conservé est entier.
    expect(original.charAt(head.length)).toBe(' ');
  });

  it('coupe net un mot unique démesuré plutôt que de ne rien garder', () => {
    const text = clampAltText('x'.repeat(3_000));
    expect(text.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeGreaterThan(ALT_TEXT_MAX_LENGTH / 2);
  });

  it('respecte une limite personnalisée sans laisser de ponctuation orpheline', () => {
    expect(clampAltText('alpha beta gamma delta', 20)).toBe('alpha beta gamma…');
    // « gamma, » finirait à la 18e position, sans place pour le « … » : on
    // recule d'un mot, et la virgule qui restait en bout de ligne s'en va.
    expect(clampAltText('alpha beta, gamma, delta', 18)).toBe('alpha beta…');
    expect(clampAltText('alpha beta gamma, delta', 19)).toBe('alpha beta gamma…');
  });

  it('énumère au plus N éléments puis compte le reste', () => {
    const items = Array.from({ length: 10 }, (_, index) => `p${index + 1}`);
    expect(listSome(items, 8, (rest) => `et ${rest} autres`)).toBe('p1, p2, p3, p4, p5, p6, p7, p8, et 2 autres');
    expect(listSome(items.slice(0, 3), 8, () => 'jamais')).toBe('p1, p2, p3');
  });
});
