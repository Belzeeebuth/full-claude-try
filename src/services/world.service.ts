import { balance as getBalance, getConfig, type EventConfig } from '../config';
import { env } from '../config/env';
import { cacheGet, cacheSet, key as redisKey } from '../db/redis';
import { seasonAt, nextSeason, rollWeather, type SeasonState, type WeatherState } from '../game/world';
import * as systemRepo from '../repositories/system.repo';
import { toSqlDate } from '../utils/time';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('world');

/**
 * État du monde : saison, météo du jour, événements actifs.
 *
 * Ces trois informations sont lues par presque toutes les commandes de jeu. Elles
 * sont donc mises en cache Redis avec un TTL court (5 min) : la météo ne change
 * qu'une fois par jour, la saison tous les 14 jours, et un cache raté coûte une
 * seule petite requête.
 */

export interface WorldState {
  season: SeasonState;
  weather: WeatherState;
  activeEvents: EventConfig[];
  /** Modificateurs agrégés des événements en cours. */
  eventModifiers: {
    xpMultiplier: number;
    growthMultiplier: number;
    globalPriceMultiplier: number;
    mutationMultiplier: number;
    qualityBonus: number;
    waterMultiplier: number;
    dailyRewardMultiplier: number;
    itemPriceMultipliers: Record<string, number>;
    categoryPriceMultipliers: Record<string, number>;
  };
}

const CACHE_TTL_SECONDS = 300;

export async function getWorldState(now: Date = new Date()): Promise<WorldState> {
  const balance = getBalance();
  const season = seasonAt(now, balance);
  const day = toSqlDate(now);
  const cacheKey = redisKey('world', day, season.key);

  const cached = await cacheGet<{ weather: WeatherState }>(cacheKey);
  let weather: WeatherState;

  if (cached) {
    weather = { ...cached.weather };
  } else {
    weather = await resolveWeather(day, season, now);
    await cacheSet(cacheKey, { weather }, CACHE_TTL_SECONDS);
  }

  const activeEvents = getActiveEvents(now);
  return { season, weather, activeEvents, eventModifiers: aggregateEventModifiers(activeEvents) };
}

/**
 * Météo du jour : lue en base si elle existe (un administrateur a pu la forcer),
 * sinon tirée de façon déterministe puis persistée.
 */
async function resolveWeather(day: string, season: SeasonState, now: Date): Promise<WeatherState> {
  const balance = getBalance();
  const existing = await systemRepo.getWeatherForDay(day);
  if (existing) {
    return {
      weather: existing.weather,
      emoji: existing.emoji,
      label: existing.description.slice(0, 48),
      description: existing.description,
      yieldModifier: Number(existing.yieldModifier),
      growthModifier: Number(existing.growthModifier),
      freeWatering: existing.freeWatering,
      damageChance: Number(existing.damageChance),
      pestChance: Number(existing.pestChance),
      temperature: existing.temperature,
      season: existing.season,
      day,
    };
  }

  const rolled = rollWeather(day, season.season, balance);
  const forced = getActiveEvents(now).find((event) => event.modifiers.forcedWeather);
  const finalWeather =
    forced?.modifiers.forcedWeather
      ? {
          ...rolled,
          ...(balance.weather.table.find((entry) => entry.weather === forced.modifiers.forcedWeather) ??
            {}),
          weather: forced.modifiers.forcedWeather,
        }
      : rolled;

  await systemRepo.ensureWeather({
    day,
    weather: finalWeather.weather,
    season: season.season,
    temperature: finalWeather.temperature,
    yieldModifier: finalWeather.yieldModifier.toFixed(3),
    growthModifier: finalWeather.growthModifier.toFixed(3),
    freeWatering: finalWeather.freeWatering,
    damageChance: finalWeather.damageChance.toFixed(4),
    pestChance: finalWeather.pestChance.toFixed(4),
    description: finalWeather.description,
    emoji: finalWeather.emoji,
  });

  log.info({ day, weather: finalWeather.weather, season: season.season }, 'météo du jour établie');
  return finalWeather as WeatherState;
}

/** Événements dont la fenêtre couvre l'instant donné. */
export function getActiveEvents(now: Date = new Date()): EventConfig[] {
  return getConfig().eventList.filter((event) => {
    if (!event.enabled) return false;
    const starts = event.startsAt ? new Date(event.startsAt).getTime() : undefined;
    const ends = event.endsAt ? new Date(event.endsAt).getTime() : undefined;
    if (starts !== undefined && now.getTime() < starts) return false;
    if (ends !== undefined && now.getTime() > ends) return false;
    // Sans fenêtre explicite, un événement récurrent est piloté par le scheduler
    // qui écrit `startsAt`/`endsAt` ; sans cron ni dates il est considéré permanent.
    if (!starts && !ends && event.recurringCron) return false;
    return true;
  });
}

function aggregateEventModifiers(events: EventConfig[]): WorldState['eventModifiers'] {
  const result: WorldState['eventModifiers'] = {
    xpMultiplier: 1,
    growthMultiplier: 1,
    globalPriceMultiplier: 1,
    mutationMultiplier: 1,
    qualityBonus: 0,
    waterMultiplier: 1,
    dailyRewardMultiplier: 1,
    itemPriceMultipliers: {},
    categoryPriceMultipliers: {},
  };

  for (const event of events) {
    const modifiers = event.modifiers;
    result.xpMultiplier *= modifiers.xpMultiplier ?? 1;
    result.growthMultiplier *= modifiers.growthMultiplier ?? 1;
    result.globalPriceMultiplier *= modifiers.globalPriceMultiplier ?? 1;
    result.mutationMultiplier *= modifiers.mutationMultiplier ?? 1;
    result.qualityBonus += modifiers.qualityBonus ?? 0;
    result.waterMultiplier *= modifiers.waterMultiplier ?? 1;
    result.dailyRewardMultiplier *= modifiers.dailyRewardMultiplier ?? 1;
    for (const [itemKey, multiplier] of Object.entries(modifiers.cropPriceMultipliers ?? {})) {
      result.itemPriceMultipliers[itemKey] = (result.itemPriceMultipliers[itemKey] ?? 1) * multiplier;
    }
    for (const [category, multiplier] of Object.entries(modifiers.categoryPriceMultipliers ?? {})) {
      result.categoryPriceMultipliers[category] =
        (result.categoryPriceMultipliers[category] ?? 1) * multiplier;
    }
  }

  return result;
}

/** Multiplicateur de prix appliqué à un objet par les événements actifs. */
export function eventPriceMultiplier(
  world: WorldState,
  itemKey: string,
  category: string,
): number {
  return (
    world.eventModifiers.globalPriceMultiplier *
    (world.eventModifiers.itemPriceMultipliers[itemKey] ?? 1) *
    (world.eventModifiers.categoryPriceMultipliers[category] ?? 1)
  );
}

/** Prépare le calendrier des saisons sur un an (job de démarrage). */
export async function ensureSeasonCalendar(now: Date = new Date()): Promise<void> {
  const balance = getBalance();
  let cursor = seasonAt(now, balance);
  const horizon = new Date(now.getTime() + 365 * 86_400_000);

  while (cursor.startsAt < horizon) {
    await systemRepo.upsertSeason({
      key: cursor.key,
      season: cursor.season,
      seasonIndex: cursor.index,
      gameYear: cursor.gameYear,
      startsAt: cursor.startsAt,
      endsAt: cursor.endsAt,
      active: false,
    });
    cursor = seasonAt(new Date(cursor.endsAt.getTime() + 1_000), balance);
  }

  await systemRepo.setActiveSeason(seasonAt(now, balance).key);
}

export function describeNextSeason(now: Date = new Date()): SeasonState {
  return nextSeason(now, getBalance());
}

/** Multiplicateurs globaux issus de l'environnement (`.env`). */
export function globalMultipliers(): { growth: number; economy: number } {
  return {
    growth: env.GLOBAL_GROWTH_MULTIPLIER,
    economy: env.GLOBAL_ECONOMY_MULTIPLIER,
  };
}
