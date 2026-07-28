import { createHash } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import { env } from '../config/env';
import { cacheGet, cacheSet, key as redisKey } from '../db/redis';
import { moduleLogger } from '../utils/logger';
import { renderMarketChart, type ChartInput } from './chart';
import { renderFarm, type FarmRenderInput } from './farm';
import { renderFishing, type FishingRenderInput } from './fishing';
import { renderLeaderboard, type LeaderboardRenderInput } from './leaderboard';
import { renderMining, type MiningRenderInput } from './mining';
import { renderProfile, type ProfileRenderInput } from './profile';

const log = moduleLogger('render');

/**
 * Façade de rendu : cache, budget de temps et repli.
 *
 * Trois garanties pour la production :
 *  1. CACHE — la clé est le hash de l'ÉTAT rendu, pas l'identifiant du joueur.
 *     Deux affichages successifs d'une ferme inchangée réutilisent le même PNG ;
 *     la moindre modification (une culture qui mûrit) change le hash. La LOCALE
 *     fait partie de l'état : les libellés sont dessinés DANS l'image, donc sans
 *     elle un joueur anglophone recevrait la version française mise en cache par
 *     un francophone.
 *  2. BUDGET DE TEMPS — au-delà de `RENDER_TIMEOUT_MS`, on abandonne l'image et
 *     la commande répond en texte. Une interaction Discord doit être honorée en
 *     3 secondes : mieux vaut un embed sans image qu'une commande qui échoue.
 *  3. REPLI — toute erreur de rendu est capturée et journalisée, jamais propagée
 *     à l'utilisateur. `renderOrNull()` renvoie `null` et l'appelant affiche sa
 *     version texte.
 */

export interface RenderOutcome {
  attachment: AttachmentBuilder | null;
  /**
   * Nom du fichier joint.
   *
   * Plus aucune vue ne le référence en `attachment://` : les images sont
   * envoyées en pièces jointes libres, hors de l'embed, pour ne pas être
   * réduites à la largeur de celui-ci (voir `farmView`). Le champ reste exposé
   * parce qu'il identifie la pièce jointe — utile pour un embed qui voudrait
   * délibérément l'intégrer, et pour le diagnostic.
   */
  fileName: string | null;
  cached: boolean;
  durationMs: number;
}

const EMPTY: RenderOutcome = { attachment: null, fileName: null, cached: false, durationMs: 0 };

function hashState(state: unknown): string {
  return createHash('sha1').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

async function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Rendu générique avec cache Redis et budget de temps.
 * `stateKey` doit capturer TOUT ce qui influence l'image.
 */
async function render(
  namespace: string,
  stateKey: unknown,
  fileName: string,
  producer: () => Promise<Buffer>,
): Promise<RenderOutcome> {
  if (!env.RENDER_ENABLED) return EMPTY;

  const started = Date.now();
  const cacheKey = redisKey('render', namespace, hashState(stateKey));

  try {
    const cached = await cacheGet<string>(cacheKey);
    if (cached) {
      const buffer = Buffer.from(cached, 'base64');
      return {
        attachment: new AttachmentBuilder(buffer, { name: fileName }),
        fileName,
        cached: true,
        durationMs: Date.now() - started,
      };
    }

    const buffer = await withBudget(producer(), env.RENDER_TIMEOUT_MS);
    if (!buffer) {
      log.warn({ namespace, budget: env.RENDER_TIMEOUT_MS }, 'budget de rendu dépassé, repli texte');
      return EMPTY;
    }

    // Discord accepte 8 Mo, mais un PNG de ferme dépasse rarement 300 Ko ;
    // au-delà de 2 Mo on considère que quelque chose ne va pas et on ne met pas
    // en cache une image aussi lourde.
    if (env.RENDER_CACHE_TTL > 0 && buffer.byteLength < 2_000_000) {
      await cacheSet(cacheKey, buffer.toString('base64'), env.RENDER_CACHE_TTL);
    }

    const durationMs = Date.now() - started;
    if (durationMs > 1_500) {
      log.warn({ namespace, durationMs, bytes: buffer.byteLength }, 'rendu lent');
    }

    return {
      attachment: new AttachmentBuilder(buffer, { name: fileName }),
      fileName,
      cached: false,
      durationMs,
    };
  } catch (error) {
    log.error({ err: error, namespace }, 'échec du rendu, repli sur l\'embed texte');
    return EMPTY;
  }
}

export async function renderFarmImage(input: FarmRenderInput): Promise<RenderOutcome> {
  // L'état capture : la grille, chaque parcelle avec son stade et son échéance
  // arrondie à la minute, la météo, et les compteurs du joueur.
  const stateKey = {
    locale: input.locale,
    grid: input.view.grid,
    theme: input.theme,
    weather: input.view.world.weather.weather,
    season: input.view.world.season.season,
    level: input.player.level,
    coins: Math.floor(input.player.coins / 100),
    plots: input.view.plots.map((plot) => [
      plot.slot,
      plot.state,
      Math.round(plot.fertility / 5),
      plot.pestType ?? '',
      plot.crop?.key ?? '',
      plot.crop?.growth.stage ?? '',
      plot.crop ? Math.floor(plot.crop.growth.msRemaining / 60_000) : 0,
      plot.crop?.growth.needsWater ? 1 : 0,
    ]),
  };

  return render('farm', stateKey, 'farm.png', () => renderFarm(input));
}

export async function renderProfileImage(input: ProfileRenderInput): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    name: input.displayName,
    level: input.level,
    xp: Math.floor(input.xp.current / 50),
    coins: Math.floor(input.coins / 100),
    gems: input.gems,
    energy: input.energy.current,
    stats: input.stats,
    coop: input.coop?.tag ?? '',
    title: input.title,
    banner: input.bannerStyle,
    badges: input.badges,
  };

  return render('profile', stateKey, 'profil.png', () => renderProfile(input));
}

export async function renderChartImage(input: ChartInput): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    title: input.title,
    current: input.currentPrice,
    trend: Math.round(input.trend * 1000),
    points: input.points.map((point) => point.price),
  };

  return render('chart', stateKey, 'marche.png', () => renderMarketChart(input));
}

export async function renderLeaderboardImage(
  input: LeaderboardRenderInput,
): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    title: input.title,
    scope: input.scopeLabel,
    entries: input.entries.map((entry) => [entry.rank, entry.name, entry.score]),
    viewer: input.viewer?.rank ?? 0,
  };

  return render('leaderboard', stateKey, 'classement.png', () => renderLeaderboard(input));
}

export async function renderFishingImage(input: FishingRenderInput): Promise<RenderOutcome> {
  const stateKey = { locale: input.locale, season: input.season, weather: input.weather };
  return render('fishing', stateKey, 'peche.png', () => renderFishing(input));
}

export async function renderMiningImage(input: MiningRenderInput): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    depth: input.depth,
    maxDepth: input.maxDepth,
    deepestReached: input.deepestReached,
  };
  return render('mining', stateKey, 'mine.png', () => renderMining(input));
}

export type {
  ChartInput,
  FarmRenderInput,
  FishingRenderInput,
  LeaderboardRenderInput,
  MiningRenderInput,
  ProfileRenderInput,
};
export { renderFarm, renderProfile, renderMarketChart, renderLeaderboard, renderFishing, renderMining };
