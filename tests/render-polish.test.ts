import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import { gridSizeFor, slotToCoords } from '../src/game/grid';
import { translate } from '../src/i18n';
import { drawPill, newCanvas, offscreen, outlineCanvas, rainbowGradient, tintCanvas } from '../src/render/canvas';
import { renderMarketChart } from '../src/render/chart';
import { renderFarm, type FarmRenderInput } from '../src/render/farm';
import { renderFishing } from '../src/render/fishing';
import { renderLeaderboard, type LeaderboardRenderInput } from '../src/render/leaderboard';
import { depthRarity, renderMining } from '../src/render/mining';
import { levelRingColor, renderProfile, type ProfileRenderInput } from '../src/render/profile';

/**
 * Polish visuel des images : mutations visibles, sol épuisé, bannière de
 * prestige, repères du graphique, médailles, plans de l'étang et de la mine.
 *
 * On ne compare pas des PNG de référence — une police différente les
 * changerait — mais des PROPRIÉTÉS : une information ajoutée à l'entrée change
 * l'image (sinon elle n'est pas dessinée), sans changer ses dimensions (les
 * vues et le cache supposent des tailles stables), et le même état produit
 * exactement les mêmes octets (le cache Redis en dépend).
 */

function sha(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

/** Dimensions lues dans l'en-tête IHDR du PNG (grands-boutistes, octets 16 à 24). */
function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// Ferme
// ---------------------------------------------------------------------------

interface FarmCase {
  mutation?: string;
  fertility?: number;
  season?: string;
  weather?: string;
  farmId?: string;
}

/**
 * Ferme 3×3 minimale : une seule culture, en parcelle 5, à un stade mûr pour
 * que la silhouette soit grande. `nextReadyAt` est nul : le pied de page ne
 * lit alors pas l'horloge, et deux rendus successifs sont comparables.
 */
function farm(options: FarmCase = {}): FarmRenderInput {
  const balance = getBalance();
  const config = getConfig('fr');
  const unlocked = 9;
  const season = options.season ?? 'summer';
  const weather = options.weather ?? 'sunny';
  const plots = Array.from({ length: unlocked }, (_, index) => {
    const slot = index + 1;
    const planted = slot === 5;
    return {
      slot,
      ...slotToCoords(slot, balance),
      state: planted ? 'growing' : 'empty',
      fertility: options.fertility ?? 70,
      fertilityLabel: '',
      weedLevel: 0,
      pestType: null,
      pestDeadlineAt: null,
      unlockCost: 0,
      crop: planted
        ? {
            key: 'tomato',
            name: config.crops.get('tomato')?.name ?? 'tomato',
            emoji: '🍅',
            rarity: 'common',
            growth: {
              stage: 'maturing',
              progress: 0.8,
              ready: false,
              withered: false,
              msRemaining: 600_000,
              readyAt: new Date(0),
              withersAt: null,
              needsWater: false,
              missedWaterings: 0,
              nextWaterAt: null,
            },
            mutation: options.mutation ?? 'none',
            regrowRemaining: 0,
            waterGiven: 1,
            waterNeeded: 1,
            fertilizerKey: null,
          }
        : undefined,
    };
  });
  return {
    locale: 'fr',
    view: {
      farmId: options.farmId ?? 'test-polish',
      name: 'Ferme test',
      grid: gridSizeFor(unlocked, balance),
      plots: plots as never,
      counts: { ready: 0, growing: 1, empty: 8, locked: 0, withered: 0, pests: 0 },
      world: {
        season: { season, index: 0, gameYear: 1, startsAt: new Date(0), endsAt: new Date(0), key: season, progress: 0 },
        weather: {
          weather,
          emoji: '',
          label: weather,
          description: '',
          yieldModifier: 1,
          growthModifier: 1,
          freeWatering: false,
          damageChance: 0,
          pestChance: 0,
          temperature: 20,
          season,
          day: '2026-09-01',
        },
        activeEvents: [],
        eventModifiers: {} as never,
      } as never,
      modifiers: {} as never,
      nextReadyAt: null,
      unlockedPlots: unlocked,
      nextPlotCost: 0,
    } as never,
    player: { username: 'Test', level: 5, coins: 0, gems: 0, avatarUrl: null },
    xp: { current: 0, needed: 100 },
  };
}

describe('ferme : mutations et sol épuisé', () => {
  it('chaque mutation change l’image, sans changer ses dimensions', async () => {
    const plain = await renderFarm(farm());
    const size = pngSize(plain);
    const hashes = new Map<string, string>([['none', sha(plain)]]);
    for (const mutation of ['giant', 'rainbow', 'ancient']) {
      const buffer = await renderFarm(farm({ mutation }));
      expect(pngSize(buffer)).toEqual(size);
      hashes.set(mutation, sha(buffer));
    }
    // Quatre apparences distinctes : aucune mutation ne retombe sur une autre.
    expect(new Set(hashes.values()).size).toBe(4);
  }, 20_000);

  it('un sol sous le seuil de fertilité basse se distingue d’un sol sain', async () => {
    const threshold = getBalance().fertility.lowThreshold;
    const healthy = await renderFarm(farm({ fertility: threshold + 30 }));
    const depleted = await renderFarm(farm({ fertility: Math.max(0, threshold - 10) }));
    expect(pngSize(depleted)).toEqual(pngSize(healthy));
    expect(sha(depleted)).not.toBe(sha(healthy));
  }, 20_000);

  it('le décor de saison est semé sur la ferme : reproductible, et propre à chaque ferme', async () => {
    const first = await renderFarm(farm({ season: 'autumn', mutation: 'rainbow' }));
    const again = await renderFarm(farm({ season: 'autumn', mutation: 'rainbow' }));
    expect(sha(again)).toBe(sha(first));
    const other = await renderFarm(farm({ season: 'autumn', mutation: 'rainbow', farmId: 'autre-ferme' }));
    expect(pngSize(other)).toEqual(pngSize(first));
    expect(sha(other)).not.toBe(sha(first));
  }, 20_000);

  it('la canicule jaunit l’herbe au-delà du simple voile météo', async () => {
    const sunny = await renderFarm(farm({ weather: 'sunny' }));
    const heat = await renderFarm(farm({ weather: 'heatwave' }));
    expect(pngSize(heat)).toEqual(pngSize(sunny));
    expect(sha(heat)).not.toBe(sha(sunny));
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

function profile(overrides: Partial<ProfileRenderInput> = {}): ProfileRenderInput {
  return {
    locale: 'fr',
    username: 'test',
    displayName: 'Test',
    avatarUrl: null,
    title: null,
    badges: [],
    level: 12,
    prestige: 0,
    xp: { current: 10, needed: 100 },
    coins: 0,
    gems: 0,
    bank: 0,
    energy: { current: 50, max: 100 },
    stats: { harvests: 0, animals: 0, crafts: 0, plots: 9, streak: 0, achievements: 0, bestHarvest: 0, coinsEarned: 0 },
    coop: null,
    themeColor: '#7ec850',
    bannerStyle: 'default',
    farmName: 'Ferme',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('profil : bannière de prestige et anneau de niveau', () => {
  it('trois rangs de prestige donnent trois bannières, aux dimensions configurées', async () => {
    const dims = getBalance().render.profile;
    const hashes = new Set<string>();
    for (const prestige of [0, 1, 2]) {
      const buffer = await renderProfile(profile({ prestige }));
      expect(pngSize(buffer)).toEqual({ width: dims.width, height: dims.height });
      hashes.add(sha(buffer));
    }
    expect(hashes.size).toBe(3);
  });

  it('la constellation est semée sur le pseudo : même rang, ciel différent', async () => {
    const a = await renderProfile(profile({ prestige: 2, username: 'alice' }));
    const b = await renderProfile(profile({ prestige: 2, username: 'bob' }));
    expect(sha(a)).not.toBe(sha(b));
    expect(sha(await renderProfile(profile({ prestige: 2, username: 'alice' })))).toBe(sha(a));
  });

  it('l’anneau change de couleur à chaque tranche de niveau', () => {
    const tiers = [1, 10, 25, 50, 75, 100].map((level) => levelRingColor(level));
    expect(new Set(tiers).size).toBe(tiers.length);
    // À l'intérieur d'une tranche, la couleur ne bouge pas.
    expect(levelRingColor(26)).toBe(levelRingColor(49));
    expect(levelRingColor(150)).toBe(levelRingColor(100));
  });
});

// ---------------------------------------------------------------------------
// Graphique, classement, étang, mine
// ---------------------------------------------------------------------------

describe('graphique : repères min / max et dernier prix', () => {
  const now = new Date('2026-09-01T12:00:00Z').getTime();
  const series = (prices: number[]) =>
    prices.map((price, index) => ({ price, recordedAt: new Date(now - (prices.length - index) * 3_600_000) }));

  it('rend une courbe avec extrêmes distincts, aux dimensions configurées', async () => {
    const dims = getBalance().render.chart;
    const buffer = await renderMarketChart({
      locale: 'fr',
      title: 'Melon',
      emoji: '🍈',
      points: series([90, 120, 88, 140, 110]),
      basePrice: 100,
      currentPrice: 110,
      trend: 0.05,
      demandIndex: 1,
    });
    expect(pngSize(buffer)).toEqual({ width: dims.width, height: dims.height });
  });

  it('ne casse ni sur une série plate ni sur un point unique', async () => {
    for (const points of [series([50, 50, 50, 50]), series([50]), []]) {
      const buffer = await renderMarketChart({
        locale: 'en',
        title: 'Wheat',
        emoji: '🌾',
        points,
        basePrice: 50,
        currentPrice: 50,
        trend: 0,
        demandIndex: 1,
      });
      expect(pngSize(buffer).width).toBe(getBalance().render.chart.width);
    }
  });

  it('les libellés des repères existent dans les deux langues', () => {
    for (const locale of ['fr', 'en']) {
      expect(translate(locale, 'render.chart.marker_min', { value: 3 })).not.toBe('render.chart.marker_min');
      expect(translate(locale, 'render.chart.marker_max', { value: 3 })).toContain('3');
    }
  });
});

describe('classement : médailles et ligne du spectateur', () => {
  const board = (viewerIndex: number | null): LeaderboardRenderInput => ({
    locale: 'fr',
    title: 'Richesse',
    emoji: '🪙',
    unit: 'pièces',
    scopeLabel: 'Global',
    entries: Array.from({ length: 8 }, (_, index) => ({
      rank: index + 1,
      name: `Joueur ${index + 1}`,
      score: 1_000 - index * 50,
      extra: '',
      isViewer: index === viewerIndex,
    })),
    viewer: viewerIndex === null ? undefined : { rank: viewerIndex + 1, score: 1_000 - viewerIndex * 50 },
  });

  it('la ligne du spectateur est mise en évidence', async () => {
    const dims = getBalance().render.leaderboard;
    const anonymous = await renderLeaderboard(board(null));
    const highlighted = await renderLeaderboard(board(5));
    expect(pngSize(anonymous)).toEqual({ width: dims.width, height: dims.height });
    expect(pngSize(highlighted)).toEqual(pngSize(anonymous));
    expect(sha(highlighted)).not.toBe(sha(anonymous));
  });
});

describe('étang et mine : plans et filons', () => {
  it('quatre saisons, quatre étangs, tous reproductibles', async () => {
    const dims = getBalance().render.fishing;
    const hashes = new Set<string>();
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
      const buffer = await renderFishing({ locale: 'fr', season, weather: 'sunny' });
      expect(pngSize(buffer)).toEqual({ width: dims.width, height: dims.height });
      hashes.add(sha(buffer));
      expect(sha(await renderFishing({ locale: 'fr', season, weather: 'sunny' }))).toBe(sha(buffer));
    }
    expect(hashes.size).toBe(4);
  });

  it('la rareté des filons croît avec la profondeur', () => {
    const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
    let previous = -1;
    for (let fraction = 0; fraction <= 1; fraction += 0.05) {
      const index = order.indexOf(depthRarity(fraction));
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
    expect(depthRarity(0)).toBe('common');
    expect(depthRarity(1)).toBe('mythic');
  });

  it('les paliers verrouillés assombrissent la coupe sans changer sa taille', async () => {
    const dims = getBalance().render.mining;
    const total = getBalance().mining.maxDepth;
    const open = await renderMining({ locale: 'fr', depth: 3, maxDepth: total, deepestReached: 3 });
    const locked = await renderMining({ locale: 'fr', depth: 3, maxDepth: 5, deepestReached: 3 });
    expect(pngSize(open)).toEqual({ width: dims.width, height: dims.height });
    expect(pngSize(locked)).toEqual(pngSize(open));
    expect(sha(locked)).not.toBe(sha(open));
  });
});

// ---------------------------------------------------------------------------
// Helpers partagés
// ---------------------------------------------------------------------------

describe('helpers de composition (canvas.ts)', () => {
  function painted(ctx: ReturnType<typeof newCanvas>['ctx'], width: number, height: number): number {
    const data = ctx.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count += 1;
    return count;
  }

  it('outlineCanvas dilate la silhouette sans toucher au fond transparent', () => {
    const { canvas, ctx } = offscreen(40, 40);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(15, 15, 10, 10);
    const halo = outlineCanvas(canvas, 3, rainbowGradient);
    const haloPainted = painted(halo.getContext('2d'), 40, 40);
    expect(haloPainted).toBeGreaterThan(painted(ctx, 40, 40));
    // Les coins restent vides : le liseré n'est pas un aplat.
    expect(halo.getContext('2d').getImageData(0, 0, 1, 1).data[3]).toBe(0);
  });

  it('tintCanvas colore les pixels peints et laisse le reste transparent', () => {
    const { canvas, ctx } = offscreen(20, 20);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(5, 5, 10, 10);
    tintCanvas(canvas, 'rgba(255,0,0,1)');
    const center = ctx.getImageData(10, 10, 1, 1).data;
    expect(center[0]).toBe(255);
    expect(center[1]).toBe(0);
    expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(0);
  });

  it('drawPill renvoie une boîte qui contient son texte et respecte l’ancrage', () => {
    const { ctx } = newCanvas(200, 50);
    const left = drawPill(ctx, { x: 10, y: 5, text: 'min 88', fontSize: 11, color: '#fff' });
    expect(left.x).toBe(10);
    expect(left.width).toBeGreaterThanOrEqual(16);
    const right = drawPill(ctx, { x: 190, y: 5, text: 'min 88', fontSize: 11, color: '#fff', align: 'right' });
    expect(right.x + right.width).toBeCloseTo(190, 5);
    const center = drawPill(ctx, { x: 100, y: 5, text: 'min 88', fontSize: 11, color: '#fff', align: 'center' });
    expect(center.x + center.width / 2).toBeCloseTo(100, 5);
  });
});
