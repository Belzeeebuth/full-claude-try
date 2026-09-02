import { createHash } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import { env } from '../config/env';
import { getRedis, key as redisKey } from '../db/redis';
import { moduleLogger } from '../utils/logger';
import {
  animalIndicators,
  describeAnimals,
  renderAnimals,
  type AnimalsRenderInput,
} from './animals';
import { describeChart, renderMarketChart, type ChartInput } from './chart';
import { renderInline, type RenderInputs, type RenderKind } from './dispatch';
import { describeFarm, renderFarm, type FarmRenderInput } from './farm';
import { describeFishing, renderFishing, type FishingRenderInput } from './fishing';
import { describeLeaderboard, renderLeaderboard, type LeaderboardRenderInput } from './leaderboard';
import { describeMining, renderMining, type MiningRenderInput } from './mining';
import {
  RenderPoolUnavailableError,
  RenderQueueFullError,
  renderPoolAvailable,
  renderPoolStats,
  submitRender,
} from './pool';
import { describeProfile, renderProfile, type ProfileRenderInput } from './profile';

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
 *  4. HORS DU THREAD PRINCIPAL — le dessin part dans un worker (voir `pool.ts`).
 *     Le canvas est synchrone : rendu ici, il bloquerait l'event loop et donc la
 *     passerelle Discord pendant toute la durée de l'image. Si le pool est
 *     indisponible (`RENDER_WORKERS=0`, worker impossible à démarrer), on
 *     dessine sur place — une image tardive vaut mieux que pas d'image.
 *  5. TEXTE ALTERNATIF — chaque pièce jointe porte une `description`, ce que
 *     lit un lecteur d'écran à la place de l'image (1 024 caractères max).
 *     Elle est recalculée à chaque affichage, y compris quand le PNG vient du
 *     cache : quelques concaténations ne valent pas un second format de cache,
 *     et une image sans description reviendrait à exclure ceux qui ne la
 *     voient pas — le mode compact ne doit plus être leur seule option.
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

/**
 * Résultat à utiliser quand le joueur a désactivé les images générées
 * (`/settings compact-mode`). Même forme que `EMPTY` : les appelants ont déjà
 * tous un repli texte pour `attachment === null`, donc court-circuiter le
 * rendu ici réutilise ce chemin sans code supplémentaire.
 */
export const NO_IMAGE: RenderOutcome = EMPTY;

function hashState(state: unknown): string {
  return createHash('sha1').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

/**
 * Lecture et écriture du cache d'images en BINAIRE.
 *
 * Les PNG étaient stockés en base64 dans une valeur JSON : un tiers d'octets en
 * plus, plus un aller-retour d'encodage à chaque lecture, sur des images de
 * ~300 Ko et une clé par état de ferme. `getBuffer` d'ioredis évite les deux.
 */
async function readCachedImage(cacheKey: string): Promise<Buffer | undefined> {
  if (env.RENDER_CACHE_TTL <= 0) return undefined;
  try {
    return (await getRedis().getBuffer(cacheKey)) ?? undefined;
  } catch (error) {
    log.debug({ err: error }, 'lecture du cache de rendu impossible');
    return undefined;
  }
}

async function writeCachedImage(cacheKey: string, buffer: Buffer): Promise<void> {
  // Discord accepte 8 Mo, mais un PNG de ferme dépasse rarement 300 Ko ;
  // au-delà de 2 Mo on considère que quelque chose ne va pas et on ne met pas
  // en cache une image aussi lourde.
  if (env.RENDER_CACHE_TTL <= 0 || buffer.byteLength >= 2_000_000) return;
  try {
    await getRedis().set(cacheKey, buffer, 'EX', env.RENDER_CACHE_TTL);
  } catch (error) {
    log.debug({ err: error }, 'écriture du cache de rendu impossible');
  }
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
 * Lance le dessin, de préférence dans un worker.
 *
 * Le repli en ligne ne concerne QUE l'indisponibilité du pool (désactivé,
 * worker impossible à démarrer) : redessiner ici après une saturation de la
 * file reviendrait à bloquer le thread principal exactement quand il est le
 * plus sollicité, c'est-à-dire à faire le contraire de ce qu'on cherche.
 */
function produce<K extends RenderKind>(kind: K, input: RenderInputs[K]): Promise<Buffer> {
  if (!renderPoolAvailable()) return renderInline(kind, input);
  return submitRender(kind, input).catch((error: unknown) => {
    if (error instanceof RenderPoolUnavailableError) return renderInline(kind, input);
    throw error;
  });
}

/**
 * Rendu générique avec cache Redis et budget de temps.
 * `stateKey` doit capturer TOUT ce qui influence l'image ; `description` est
 * le texte alternatif déjà borné par `describeX()`, joint sur les deux chemins.
 */
async function render<K extends RenderKind>(
  kind: K,
  stateKey: unknown,
  fileName: string,
  description: string,
  input: RenderInputs[K],
): Promise<RenderOutcome> {
  if (!env.RENDER_ENABLED) return EMPTY;

  const started = Date.now();
  const cacheKey = redisKey('render', kind, hashState(stateKey));

  try {
    const cached = await readCachedImage(cacheKey);
    if (cached) {
      return {
        attachment: new AttachmentBuilder(cached, { name: fileName, description }),
        fileName,
        cached: true,
        durationMs: Date.now() - started,
      };
    }

    // Le rendu est lancé une fois et référencé : dépasser le budget n'ANNULE
    // rien — le worker va au bout de l'image quoi qu'il arrive. Plutôt que de
    // gaspiller ce CPU, on laisse la promesse alimenter le cache en arrière-plan,
    // et l'affichage suivant est immédiat. Seul un rendu manifestement bloqué est
    // interrompu, par le seuil dur du pool.
    const producing = produce(kind, input);
    const buffer = await withBudget(producing, env.RENDER_TIMEOUT_MS);
    if (!buffer) {
      log.warn(
        { namespace: kind, budget: env.RENDER_TIMEOUT_MS, ...renderPoolStats() },
        'budget de rendu dépassé, repli texte',
      );
      void producing
        .then((late) => writeCachedImage(cacheKey, late))
        .catch(() => undefined);
      return EMPTY;
    }

    await writeCachedImage(cacheKey, buffer);

    const durationMs = Date.now() - started;
    if (durationMs > 1_500) {
      log.warn({ namespace: kind, durationMs, bytes: buffer.byteLength }, 'rendu lent');
    }

    return {
      attachment: new AttachmentBuilder(buffer, { name: fileName, description }),
      fileName,
      cached: false,
      durationMs,
    };
  } catch (error) {
    if (error instanceof RenderQueueFullError) {
      // Saturation : c'est une information de capacité, pas un bug. On le dit
      // une fois par rendu refusé, sans la pile d'appel.
      log.warn({ namespace: kind, ...renderPoolStats() }, 'file de rendu saturée, repli texte');
      return EMPTY;
    }
    log.error({ err: error, namespace: kind }, 'échec du rendu, repli sur l\'embed texte');
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
    equippedPetKey: input.equippedPetKey ?? '',
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

  return render('farm', stateKey, 'farm.png', describeFarm(input), input);
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

  return render('profile', stateKey, 'profil.png', describeProfile(input), input);
}

export async function renderChartImage(input: ChartInput): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    title: input.title,
    current: input.currentPrice,
    trend: Math.round(input.trend * 1000),
    points: input.points.map((point) => point.price),
  };

  return render('chart', stateKey, 'marche.png', describeChart(input), input);
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

  return render('leaderboard', stateKey, 'classement.png', describeLeaderboard(input), input);
}

export async function renderFishingImage(input: FishingRenderInput): Promise<RenderOutcome> {
  const stateKey = { locale: input.locale, season: input.season, weather: input.weather };
  return render('fishing', stateKey, 'peche.png', describeFishing(input), input);
}

export async function renderMiningImage(input: MiningRenderInput): Promise<RenderOutcome> {
  const stateKey = {
    locale: input.locale,
    depth: input.depth,
    maxDepth: input.maxDepth,
    deepestReached: input.deepestReached,
  };
  return render('mining', stateKey, 'mine.png', describeMining(input), input);
}

export async function renderAnimalsImage(input: AnimalsRenderInput): Promise<RenderOutcome> {
  // L'état capture ce qui change le DESSIN : la disposition (ferme, bâtiments,
  // bêtes et leur ordre), les libellés, et les pastilles telles que l'image les
  // décide — pas les jauges brutes, qui bougent chaque minute sans rien changer
  // à l'écran tant qu'aucun seuil n'est franchi.
  const stateKey = {
    locale: input.locale,
    farmId: input.farmId,
    owner: input.ownerName,
    season: input.season,
    weather: input.weather,
    buildings: input.buildings.map((building) => [
      building.key,
      building.name,
      building.tier,
      building.capacity,
      building.used,
    ]),
    animals: input.animals.map((animal) => {
      const flags = animalIndicators(animal);
      return [
        animal.id,
        animal.animalKey,
        animal.buildingKey,
        animal.form ?? '',
        animal.nickname ?? animal.name,
        flags.ready ? 1 : 0,
        flags.feed ? 1 : 0,
        flags.sick ? 1 : 0,
        flags.pet ? 1 : 0,
        flags.sleeping ? 1 : 0,
      ];
    }),
    totals: input.totals,
  };
  return render('animals', stateKey, 'animaux.png', describeAnimals(input), input);
}

export {
  closeRenderPool,
  renderPoolAvailable,
  renderPoolStats,
  warmRenderPool,
} from './pool';
export type { RenderInputs, RenderKind };
export { renderInline };

export type {
  AnimalsRenderInput,
  ChartInput,
  FarmRenderInput,
  FishingRenderInput,
  LeaderboardRenderInput,
  MiningRenderInput,
  ProfileRenderInput,
};
export {
  renderAnimals,
  renderFarm,
  renderProfile,
  renderMarketChart,
  renderLeaderboard,
  renderFishing,
  renderMining,
};
export {
  describeAnimals,
  describeChart,
  describeFarm,
  describeFishing,
  describeLeaderboard,
  describeMining,
  describeProfile,
};
export { ALT_TEXT_MAX_LENGTH, clampAltText } from './alt-text';
