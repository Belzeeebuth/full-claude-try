import './offline-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { balance as getBalance, getConfig } from '../config';
import { gridSizeFor, slotToCoords } from '../game/grid';
import { renderFarm, type FarmRenderInput } from '../render/farm';

/**
 * Matrice de rendu : les CAS LIMITES de la vue de ferme, sans base ni Discord.
 *
 *   npm run render:matrix
 *
 * `render:preview` montre une jolie ferme moyenne ; celui-ci montre ce qui casse.
 * La géométrie dépend de la taille de grille (3×3 laisse de larges marges, 8×8
 * n'en laisse presque pas) et le décor dépend de la météo. Les deux bugs trouvés
 * en écrivant ce script — bâtiments coupés par le bord en 8×8, nom de ferme
 * tronqué — n'apparaissaient sur aucune ferme moyenne.
 */
function build(unlocked: number, season: string, weather: string): FarmRenderInput {
  const balance = getBalance();
  const config = getConfig('fr');
  const grid = gridSizeFor(unlocked, balance);
  const now = Date.now();
  const keys = config.cropList.map((crop) => crop.key);
  const stages = ['planted', 'sprouting', 'growing', 'maturing', 'ready'] as const;

  const plots = Array.from({ length: Math.min(balance.plots.maxPlots, unlocked + 4) }, (_, index) => {
    const slot = index + 1;
    const locked = slot > unlocked;
    const planted = !locked && slot % 4 !== 0;
    const key = keys[slot % keys.length]!;
    return {
      slot,
      ...slotToCoords(slot, balance),
      state: locked ? 'locked' : planted ? 'growing' : 'empty',
      fertility: 30 + ((slot * 11) % 70),
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
              withered: slot % 17 === 0,
              msRemaining: 60_000 * (slot * 6),
              readyAt: new Date(now + 60_000 * slot * 6),
              withersAt: null,
              needsWater: slot % 3 === 0,
              missedWaterings: 0,
              nextWaterAt: null,
            },
            mutation: slot % 7 === 0 ? 'rainbow' : 'none',
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
    } as never,
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

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'out', 'matrix');
  mkdirSync(outDir, { recursive: true });

  const cases: Array<[string, number, string, string]> = [
    ['min-3x3', 9, 'spring', 'sunny'],
    // ENTRE deux paliers. Tous les autres cas tombent sur une borne exacte
    // (9, 25, 64) — c'est exactement pour cela que le décalage entre
    // `gridSizeFor` et `slotToCoords` n'apparaissait sur aucune image : les
    // parcelles 10 et 26, pourtant payées, n'étaient tout simplement pas
    // dessinées. Elles doivent être visibles ici.
    ['entre-paliers-10', 10, 'spring', 'sunny'],
    ['entre-paliers-26', 26, 'autumn', 'cloudy'],
    ['max-8x8', 64, 'summer', 'rainy'],
    ['automne', 25, 'autumn', 'sunny'],
    ['hiver-neige', 25, 'winter', 'snow'],
    ['orage', 25, 'summer', 'storm'],
    ['canicule', 25, 'summer', 'heatwave'],
  ];

  for (const [name, unlocked, season, weather] of cases) {
    const started = Date.now();
    const buffer = await renderFarm(build(unlocked, season, weather));
    writeFileSync(join(outDir, `${name}.png`), buffer);
    console.log(`${name.padEnd(14)} ${String(buffer.length).padStart(7)} o  ${Date.now() - started} ms`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
