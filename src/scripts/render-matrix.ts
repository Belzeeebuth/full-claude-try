import './offline-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { balance as getBalance, getConfig } from '../config';
import { gridSizeFor, slotToCoords } from '../game/grid';
import { translate } from '../i18n';
import { renderMarketChart } from '../render/chart';
import { renderFarm, type FarmRenderInput } from '../render/farm';
import { renderFishing } from '../render/fishing';
import { renderLeaderboard } from '../render/leaderboard';
import { renderMining } from '../render/mining';
import { renderProfile, type ProfileRenderInput } from '../render/profile';

/**
 * Matrice de rendu : les CAS LIMITES des images, sans base ni Discord.
 *
 *   npm run render:matrix
 *
 * `render:preview` montre une jolie ferme moyenne ; celui-ci montre ce qui casse
 * et ce qui doit se VOIR. La géométrie dépend de la taille de grille (3×3 laisse
 * de larges marges, 8×8 n'en laisse presque pas) et le décor dépend de la
 * météo et de la saison. Les deux bugs trouvés en écrivant ce script —
 * bâtiments coupés par le bord en 8×8, nom de ferme tronqué — n'apparaissaient
 * sur aucune ferme moyenne. Les cas « mutations », « sol épuisé » et
 * « prestige » existent pour la même raison : une amélioration qu'aucune image
 * de contrôle ne montre finit par être cassée sans que personne ne le voie.
 */

interface FarmCaseOptions {
  /** Chaque culture plantée reçoit une mutation, en alternance giant / rainbow / ancient. */
  mutations?: boolean;
  /** Toutes les parcelles sous le seuil de fertilité basse. */
  depleted?: boolean;
}

function build(unlocked: number, season: string, weather: string, options: FarmCaseOptions = {}): FarmRenderInput {
  const balance = getBalance();
  const config = getConfig('fr');
  const grid = gridSizeFor(unlocked, balance);
  const now = Date.now();
  const keys = config.cropList.map((crop) => crop.key);
  const stages = ['planted', 'sprouting', 'growing', 'maturing', 'ready'] as const;
  const mutations = ['giant', 'rainbow', 'ancient'] as const;

  const plots = Array.from({ length: Math.min(balance.plots.maxPlots, unlocked + 4) }, (_, index) => {
    const slot = index + 1;
    const locked = slot > unlocked;
    const planted = !locked && slot % 4 !== 0;
    const key = keys[slot % keys.length]!;
    const mutation = options.mutations
      ? mutations[slot % mutations.length]!
      : slot % 7 === 0
        ? 'rainbow'
        : 'none';
    return {
      slot,
      ...slotToCoords(slot, balance),
      state: locked ? 'locked' : planted ? 'growing' : 'empty',
      fertility: options.depleted
        ? (slot * 5) % Math.max(1, balance.fertility.lowThreshold)
        : 30 + ((slot * 11) % 70),
      fertilityLabel: '',
      weedLevel: slot % 9 === 0 ? 55 : 4,
      pestType: slot % 13 === 0 ? 'insects' : null,
      pestDeadlineAt: null,
      unlockCost: 800,
      crop: planted
        ? {
            key,
            name: config.crops.get(key)?.name ?? key,
            emoji: config.crops.get(key)?.emoji ?? '🌱',
            rarity: 'common',
            growth: {
              stage: stages[slot % stages.length]!,
              progress: ((slot * 17) % 100) / 100,
              ready: slot % 5 === 4,
              withered: !options.mutations && slot % 17 === 0,
              msRemaining: 60_000 * (slot * 6),
              readyAt: new Date(now + 60_000 * slot * 6),
              withersAt: null,
              needsWater: slot % 3 === 0,
              missedWaterings: 0,
              nextWaterAt: null,
            },
            mutation,
            regrowRemaining: 0,
            waterGiven: 1,
            waterNeeded: 2,
            fertilizerKey: null,
          }
        : undefined,
    };
  });

  return {
    locale: 'fr',
    view: {
      farmId: `preview-${unlocked}-${season}`,
      name: 'La Grande Ferme des Trois Chênes Centenaires',
      grid,
      plots: plots as never,
      counts: countsOf(plots),
      world: {
        season: { season, index: 1, gameYear: 1, startsAt: new Date(), endsAt: new Date(), key: `${season}_y1`, progress: 0.4 },
        weather: {
          weather, emoji: '🌤️', label: weather, description: '',
          yieldModifier: 1, growthModifier: 1, freeWatering: false,
          damageChance: 0, pestChance: 0, temperature: 18, season, day: '2026-09-01',
        },
        activeEvents: [],
        eventModifiers: {} as never,
      } as never,
      modifiers: {} as never,
      nextReadyAt: new Date(now + 900_000),
      unlockedPlots: unlocked,
      nextPlotCost: 4_550,
    },
    player: { username: 'Marion', level: 24, coins: 1_284_500, gems: 148, avatarUrl: null },
    xp: { current: 4_200, needed: 9_800 },
    buildingsPreview: [
      { key: 'house', tier: 2 },
      { key: 'barn', tier: 3 },
      { key: 'well', tier: 1 },
      { key: 'greenhouse', tier: 1 },
      { key: 'mill', tier: 2 },
      { key: 'warehouse', tier: 4 },
    ],
  };
}

/**
 * Compteurs DÉRIVÉS des parcelles construites, et non codés en dur : le pied de
 * page annonçait « 4 prêtes • 10 en croissance • 5 vides • 4 verrouillées » sur
 * toutes les images, y compris une grille 3×3 qui ne contient que 9 parcelles.
 * Une matrice de cas limites qui ment sur ce qu'elle montre ne sert à rien.
 */
function countsOf(
  plots: ReadonlyArray<{
    state: string;
    pestType: string | null;
    crop?: { growth: { ready: boolean; withered: boolean } } | undefined;
  }>,
) {
  const counts = { ready: 0, growing: 0, empty: 0, locked: 0, withered: 0, pests: 0 };
  for (const plot of plots) {
    if (plot.pestType) counts.pests += 1;
    if (plot.state === 'locked') counts.locked += 1;
    else if (!plot.crop) counts.empty += 1;
    else if (plot.crop.growth.withered) counts.withered += 1;
    else if (plot.crop.growth.ready) counts.ready += 1;
    else counts.growing += 1;
  }
  return counts;
}

/** Carte de profil : le prestige pilote la bannière, le niveau la couleur de l'anneau. */
function profile(prestige: number, level: number, overrides: Partial<ProfileRenderInput> = {}): ProfileRenderInput {
  return {
    locale: 'fr',
    username: 'Marion',
    displayName: 'Marion des Champs',
    avatarUrl: null,
    title: 'Fermière confirmée',
    badges: ['🏆', '🌾', '🔥'],
    level,
    prestige,
    xp: { current: 4_200, needed: 9_800 },
    coins: 1_284_500,
    gems: 148,
    bank: 450_000,
    energy: { current: 78, max: 130 },
    stats: {
      harvests: 12_480,
      animals: 63,
      crafts: 1_204,
      plots: 25,
      streak: 34,
      achievements: 17,
      bestHarvest: 84_200,
      coinsEarned: 8_940_000,
    },
    coop: { name: 'Les Amis du Blé', tag: 'BLE', level: 7, role: 'officer' },
    themeColor: '#7ec850',
    bannerStyle: 'starry',
    farmName: 'Ferme des Trois Chênes',
    createdAt: new Date('2026-02-14T09:00:00Z'),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'out', 'matrix');
  mkdirSync(outDir, { recursive: true });
  const write = async (name: string, render: () => Promise<Buffer>): Promise<void> => {
    const started = Date.now();
    const buffer = await render();
    writeFileSync(join(outDir, `${name}.png`), buffer);
    console.log(`${name.padEnd(20)} ${String(buffer.length).padStart(7)} o  ${Date.now() - started} ms`);
  };

  const farms: Array<[string, number, string, string, FarmCaseOptions?]> = [
    ['min-3x3', 9, 'spring', 'sunny'],
    // ENTRE deux paliers. Tous les autres cas tombent sur une borne exacte
    // (9, 25, 64) — c'est exactement pour cela que le décalage entre
    // `gridSizeFor` et `slotToCoords` n'apparaissait sur aucune image : les
    // parcelles 10 et 26, pourtant payées, n'étaient tout simplement pas
    // dessinées. Elles doivent être visibles ici.
    ['entre-paliers-10', 10, 'spring', 'sunny'],
    ['entre-paliers-26', 26, 'autumn', 'cloudy'],
    ['max-8x8', 64, 'summer', 'rainy'],
    ['printemps', 25, 'spring', 'sunny'],
    ['automne', 25, 'autumn', 'sunny'],
    ['hiver-neige', 25, 'winter', 'snow'],
    ['hiver-clair', 25, 'winter', 'sunny'],
    ['orage', 25, 'summer', 'storm'],
    ['canicule', 25, 'summer', 'heatwave'],
    // Chaque culture plantée porte une mutation : géante, irisée, ancienne.
    ['mutations', 25, 'summer', 'sunny', { mutations: true }],
    // Toutes les parcelles sous le seuil de fertilité basse : sol pâle et craquelé.
    ['sol-epuise', 25, 'summer', 'cloudy', { depleted: true }],
  ];
  for (const [name, unlocked, season, weather, options] of farms) {
    await write(name, () => renderFarm(build(unlocked, season, weather, options)));
  }

  // Profils : bannière unie (0), étoiles (1), constellation (2+) ; anneau
  // d'avatar par tranche de niveau.
  await write('profil-prestige-0', () => renderProfile(profile(0, 8, { bannerStyle: 'default' })));
  await write('profil-prestige-1', () => renderProfile(profile(1, 24, { bannerStyle: 'sunset' })));
  await write('profil-prestige-2', () => renderProfile(profile(2, 61)));
  await write('profil-prestige-4', () => renderProfile(profile(4, 100, { bannerStyle: 'neon', xp: { current: 0, needed: 0 } })));

  // Graphiques : une tendance haussière dont le maximum n'est pas le dernier
  // point, une baissière dont le minimum EST le dernier point (les deux
  // étiquettes doivent alors fusionner, pas se superposer).
  const now = Date.now();
  const rising = Array.from({ length: 32 }, (_, index) => ({
    price: 90 + Math.round(Math.sin(index / 3) * 22 + index * 1.4),
    recordedAt: new Date(now - (32 - index) * 3_600_000),
  }));
  await write('marche-hausse', () =>
    renderMarketChart({
      locale: 'fr',
      title: 'Melon',
      emoji: '🍈',
      points: rising,
      basePrice: 90,
      currentPrice: rising.at(-1)!.price,
      trend: 0.083,
      demandIndex: 1.12,
    }),
  );
  const falling = Array.from({ length: 24 }, (_, index) => ({
    price: 240 - index * 6 + Math.round(Math.cos(index / 2) * 9),
    recordedAt: new Date(now - (24 - index) * 3_600_000),
  }));
  await write('marche-baisse', () =>
    renderMarketChart({
      locale: 'fr',
      title: 'Café',
      emoji: '☕',
      points: falling,
      basePrice: 200,
      currentPrice: falling.at(-1)!.price,
      trend: -0.31,
      demandIndex: 0.74,
    }),
  );
  await write('marche-sans-historique', () =>
    renderMarketChart({
      locale: 'fr',
      title: 'Blé',
      emoji: '🌾',
      points: [],
      basePrice: 12,
      currentPrice: 14,
      trend: 0,
      demandIndex: 1,
    }),
  );

  // Classement : médailles du podium, ligne du spectateur bordée.
  await write('classement', () =>
    renderLeaderboard({
      locale: 'fr',
      title: translate('fr', 'leaderboard.wealth'),
      emoji: '🪙',
      unit: translate('fr', 'leaderboard.unit.wealth'),
      scopeLabel: translate('fr', 'leaderboard.scope.global'),
      entries: Array.from({ length: 10 }, (_, index) => ({
        rank: index + 1,
        name: ['Marion', 'Théo', 'Aïcha', 'Luc', 'Sofia', 'Yanis', 'Emma', 'Noah', 'Léa', 'Gabriel'][index]!,
        score: 5_000_000 - index * 420_000,
        extra: translate('fr', 'leaderboard.entry_level', { level: 60 - index * 3 }),
        isViewer: index === 5,
      })),
      viewer: { rank: 6, score: 2_900_000 },
    }),
  );

  // Étang : une image par saison, dont une sous la pluie.
  for (const [season, weather] of [['spring', 'sunny'], ['summer', 'rainy'], ['autumn', 'cloudy'], ['winter', 'snow']] as const) {
    await write(`etang-${season}`, () => renderFishing({ locale: 'fr', season, weather }));
  }

  // Mine : début de partie, puis un joueur profond avec un record plus bas.
  await write('mine-debut', () => renderMining({ locale: 'fr', depth: 2, maxDepth: 6, deepestReached: 2 }));
  await write('mine-profonde', () => renderMining({ locale: 'fr', depth: 14, maxDepth: 22, deepestReached: 19 }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
