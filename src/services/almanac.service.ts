import { balance as getBalance, getConfig } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import { cacheGet, cacheSet, key as redisKey } from '../db/redis';
import {
  almanacPrice,
  almanacTips,
  currentDayFor,
  dayStartOf,
  forecastDayFor,
  forecastExpiry,
  forecastWeather,
  type AlmanacTip,
} from '../game/almanac';
import type { SeasonState, WeatherState } from '../game/world';
import * as almanacRepo from '../repositories/almanac.repo';
import * as playerRepo from '../repositories/player.repo';
import * as systemRepo from '../repositories/system.repo';
import type { WeatherRow } from '../repositories/system.repo';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { DAY, nextMidnight } from '../utils/time';
import * as economyService from './economy.service';
import { describeNextSeason, getActiveEvents, getWorldState, type WorldState } from './world.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('almanac');

/**
 * Almanach du fermier : l'état du monde gratuit, la prévision de demain payante.
 *
 * La prévision achetée est mémorisée dans Redis et non en base : c'est une
 * information périssable (elle ne vaut plus rien à minuit UTC, quand elle
 * devient la météo du jour, gratuite dans `/weather`), et l'achat lui-même est
 * déjà journalisé dans `transactions` (`shop_purchase` / `almanac`). Le grand
 * livre reste la source de vérité : si Redis a oublié l'entrée (vidage,
 * panne), la ligne d'achat suffit à reconstruire la prévision — le tirage est
 * déterministe — et le joueur ne repaie jamais la même information.
 */

export interface AlmanacForecast {
  /** Jour UTC concerné (`yyyy-MM-dd`). */
  day: string;
  weather: WeatherState;
  tips: AlmanacTip[];
  purchasedAt: Date;
  /** Jusqu'à quand la prévision reste lisible sans repayer. */
  expiresAt: Date;
}

export interface AlmanacView {
  world: WorldState;
  nextSeason: SeasonState;
  /** Jours calendaires (arrondis vers le haut) avant la prochaine saison. */
  daysUntilNextSeason: number;
  /** Jour visé par la prévision proposée à la vente. */
  forecastDay: string;
  /** Prix de la prévision pour ce joueur, à son niveau actuel. */
  price: number;
  /** Prévision déjà achetée, ou `null` si elle est encore scellée. */
  forecast: AlmanacForecast | null;
}

export interface PurchaseResult {
  forecast: AlmanacForecast;
  /** Montant réellement débité (0 si la prévision était déjà possédée). */
  cost: number;
  balanceAfter: number;
  alreadyOwned: boolean;
}

/** Ce que le bouton d'achat a affiché : revalidé pour ne jamais débiter autre chose. */
export interface PurchaseExpectation {
  day: string;
  price: number;
}

/** Forme sérialisée dans Redis — dates en ISO, la météo dans sa langue de référence. */
interface CachedForecast {
  day: string;
  weather: WeatherState;
  purchasedAt: string;
  expiresAt: string;
}

const FALLBACK_TIMEZONE = 'Europe/Paris';

function cacheKey(userId: string, day: string): string {
  return redisKey('almanac', userId, day);
}

/**
 * Le cache porte toujours les libellés de référence (français) : on les
 * réécrit à la lecture, comme `getWorldState`, pour ne pas dupliquer l'entrée
 * Redis par langue.
 */
function localizeWeather(weather: WeatherState, locale?: string): WeatherState {
  if (!locale?.startsWith('en')) return weather;
  const localized = getConfig(locale).balance.weather.table.find(
    (entry) => entry.weather === weather.weather,
  );
  return localized
    ? { ...weather, label: localized.label, description: localized.description }
    : weather;
}

function toForecast(cached: CachedForecast, locale?: string): AlmanacForecast {
  return {
    day: cached.day,
    weather: localizeWeather(cached.weather, locale),
    // Les conseils sont recalculés à chaque lecture plutôt que stockés : un
    // rechargement de la table météo se reflète ainsi sans invalider le cache.
    tips: almanacTips(cached.weather, getBalance()),
    purchasedAt: new Date(cached.purchasedAt),
    expiresAt: new Date(cached.expiresAt),
  };
}

/** Échéance de lecture d'une prévision achetée maintenant, dans le fuseau du joueur. */
async function expiryFor(userId: string, now: Date): Promise<Date> {
  const settings = await playerRepo.getSettings(userId);
  return forecastExpiry(now, nextMidnight(now, settings?.timezone ?? FALLBACK_TIMEZONE));
}

async function storeForecast(userId: string, cached: CachedForecast, now: Date): Promise<void> {
  const expiresAt = new Date(cached.expiresAt);
  const ttlSeconds = Math.max(60, Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000));
  await cacheSet(cacheKey(userId, cached.day), cached, ttlSeconds);
}

/** Reconstruit un état météo à partir d'une ligne persistée (météo forcée). */
function weatherFromRow(row: WeatherRow, day: string): WeatherState {
  const config = getBalance().weather.table.find((entry) => entry.weather === row.weather);
  return {
    weather: row.weather,
    emoji: row.emoji,
    label: config?.label ?? row.description,
    description: row.description,
    yieldModifier: Number(row.yieldModifier),
    growthModifier: Number(row.growthModifier),
    freeWatering: row.freeWatering,
    damageChance: Number(row.damageChance),
    pestChance: Number(row.pestChance),
    temperature: row.temperature,
    season: row.season,
    day,
  };
}

/**
 * Météo qu'aura le jour visé : exactement ce que `getWorldState` calculera à
 * minuit, sans rien persister.
 *
 * L'ordre de priorité est celui de `world.service` : une ligne déjà en base
 * (un administrateur a forcé la météo) l'emporte, puis un événement à météo
 * imposée, puis le tirage déterministe. Recopier cet ordre est ce qui rend la
 * prévision EXACTE — une prévision qui ignorerait un événement « sécheresse »
 * vendrait une information fausse.
 */
async function previewWeather(day: string): Promise<WeatherState> {
  const balance = getBalance();
  const stored = await systemRepo.getWeatherForDay(day);
  if (stored) return weatherFromRow(stored, day);

  const rolled = forecastWeather(day, balance);
  const forcedKey = getActiveEvents(dayStartOf(day)).find((event) => event.modifiers.forcedWeather)
    ?.modifiers.forcedWeather;
  if (!forcedKey) return rolled;

  const forced = balance.weather.table.find((entry) => entry.weather === forcedKey);
  if (!forced) return rolled;
  return {
    ...rolled,
    weather: forced.weather,
    emoji: forced.emoji,
    label: forced.label,
    description: forced.description,
    yieldModifier: forced.yieldModifier,
    growthModifier: forced.growthModifier,
    freeWatering: forced.freeWatering,
    damageChance: forced.damageChance,
    pestChance: forced.pestChance,
  };
}

/**
 * Prévision déjà possédée pour le jour visé, ou `null`.
 *
 * Redis d'abord ; à défaut, le grand livre : une ligne d'achat pour ce jour
 * prouve le paiement, et la prévision se recalcule à l'identique. L'entrée
 * est alors remise en cache pour que les lectures suivantes ne retouchent
 * pas la base.
 */
async function readForecast(
  userId: string,
  day: string,
  now: Date,
  locale?: string,
): Promise<AlmanacForecast | null> {
  const cached = await cacheGet<CachedForecast>(cacheKey(userId, day));
  // La clé contient déjà le jour ; la vérification protège d'une entrée
  // corrompue ou d'un préfixe Redis partagé par erreur entre environnements.
  if (cached && cached.day === day) return toForecast(cached, locale);

  // Une prévision pour J ne s'achète que pendant J-1 : borner la recherche
  // au début du jour courant suffit et garde la requête indexée.
  const purchase = await almanacRepo.findForecastPurchase(userId, day, dayStartOf(currentDayFor(now)));
  if (!purchase) return null;

  const [weather, expiresAt] = await Promise.all([previewWeather(day), expiryFor(userId, now)]);
  const rebuilt: CachedForecast = {
    day,
    weather,
    purchasedAt: purchase.createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await storeForecast(userId, rebuilt, now);
  log.info({ userId, day }, 'prévision reconstruite depuis le grand livre');
  return toForecast(rebuilt, locale);
}

export async function getAlmanac(
  player: PlayerContext,
  now: Date = new Date(),
  locale?: string,
): Promise<AlmanacView> {
  const balance = getBalance();
  const forecastDay = forecastDayFor(now);
  const [world, forecast] = await Promise.all([
    getWorldState(now, locale),
    readForecast(player.id, forecastDay, now, locale),
  ]);

  return {
    world,
    nextSeason: describeNextSeason(now),
    daysUntilNextSeason: Math.max(
      1,
      Math.ceil((world.season.endsAt.getTime() - now.getTime()) / DAY),
    ),
    forecastDay,
    price: almanacPrice(player.level, balance),
    forecast,
  };
}

/**
 * Achète la prévision de demain.
 *
 * Idempotent : une prévision déjà possédée (cache ou grand livre) n'est
 * jamais refacturée, même si le joueur clique deux fois plus vite que le
 * verrou de composant. `expected` transporte ce que le bouton affichait ; si
 * le jour a basculé (message de la veille) ou si le prix a changé (niveau
 * gagné entre-temps), on refuse plutôt que de débiter autre chose que ce qui
 * a été annoncé.
 */
export async function buyForecast(
  player: PlayerContext,
  now: Date = new Date(),
  locale?: string,
  expected?: PurchaseExpectation,
): Promise<PurchaseResult> {
  const balance = getBalance();
  const forecastDay = forecastDayFor(now);
  const price = almanacPrice(player.level, balance);

  if (expected && expected.day !== forecastDay) {
    throw gameError('invalid_state', 'That forecast is no longer about tomorrow.', {
      i18nKey: 'errors.almanac.outdated',
    });
  }
  if (expected && expected.price !== price) {
    throw gameError('invalid_state', 'The forecast price has changed since it was displayed.', {
      i18nKey: 'errors.almanac.price_changed',
      params: { price },
    });
  }

  const owned = await readForecast(player.id, forecastDay, now, locale);
  if (owned) {
    return { forecast: owned, cost: 0, balanceAfter: player.coins, alreadyOwned: true };
  }

  // Lectures hors transaction : rien ici ne dépend du solde.
  const [weather, expiresAt] = await Promise.all([
    previewWeather(forecastDay),
    expiryFor(player.id, now),
  ]);

  let balanceAfter = player.coins;
  // Un prix nul (configuration) ne passe pas par le grand livre : `debit`
  // refuse un montant non positif, et une ligne à zéro n'aurait aucun sens.
  if (price > 0) {
    balanceAfter = await withTransaction(async (tx) => {
      const user = await lockUserRow(tx, player.id);
      if (!user) {
        throw gameError('not_registered', 'Account not found.', {
          i18nKey: 'errors.economy.account_not_found',
        });
      }
      const remaining = await economyService.charge(
        {
          userId: player.id,
          amount: price,
          type: 'shop_purchase',
          itemKey: almanacRepo.ALMANAC_ITEM_KEY,
          quantity: 1,
          unitPrice: price,
          // `day` est ce qui permet au grand livre de retrouver l'achat si
          // Redis l'oublie : ne pas le retirer sans revoir `readForecast`.
          metadata: { day: forecastDay },
        },
        tx,
      );
      await economyService.trackSpending(
        { userId: player.id, coopId: player.coopId, level: player.level },
        price,
        tx,
      );
      return remaining;
    });
  }

  const cached: CachedForecast = {
    day: forecastDay,
    weather,
    purchasedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await storeForecast(player.id, cached, now);

  log.info(
    { userId: player.id, day: forecastDay, weather: weather.weather, price },
    'prévision d\'almanach achetée',
  );

  return {
    forecast: toForecast(cached, locale),
    cost: price,
    balanceAfter,
    alreadyOwned: false,
  };
}
