import type { Balance } from '../config/gameplay/schemas';
import { dailyRng } from './rng';

/**
 * Saisons et météo : l'état « monde », commun à tous les joueurs.
 *
 * Choix de conception : la météo est GLOBALE et non par joueur. C'est ce qui rend
 * `/meteo` social (« il pleut, allez arroser gratuitement »), permet des
 * événements collectifs (sécheresse) et empêche le reroll — un joueur ne peut pas
 * relancer sa météo en changeant de serveur.
 *
 * La météo du jour est tirée avec un RNG déterministe basé sur la date. Deux
 * conséquences importantes :
 *  - tous les shards calculent la MÊME météo sans se coordonner ;
 *  - un incident est rejouable : on peut recalculer la météo du 14 juillet pour
 *    vérifier une réclamation de joueur.
 * La ligne est malgré tout persistée dans la table `weather`, ce qui permet à un
 * administrateur de forcer une météo (événement) sans casser le déterminisme.
 */

export type SeasonName = 'spring' | 'summer' | 'autumn' | 'winter';
export type WeatherName = 'sunny' | 'cloudy' | 'rainy' | 'storm' | 'heatwave' | 'frost' | 'snow';

export interface SeasonState {
  season: SeasonName;
  /** Index dans l'ordre des saisons (0-3). */
  index: number;
  /** Numéro d'année de jeu, à partir de 1. */
  gameYear: number;
  startsAt: Date;
  endsAt: Date;
  /** Clé stable `spring_y1`. */
  key: string;
  /** Progression 0-1 dans la saison. */
  progress: number;
}

/** Origine du calendrier de jeu. Fixée une fois pour toutes : la changer décale toutes les saisons. */
export const GAME_EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * Saison à un instant donné, déduite du nombre de jours écoulés depuis l'époque.
 * Aucun état stocké : on peut connaître la saison de n'importe quelle date,
 * passée ou future, ce qui permet à `/saison` d'annoncer la suivante et aux
 * tests de figer le temps.
 */
export function seasonAt(now: Date, balance: Balance, epoch: Date = GAME_EPOCH): SeasonState {
  const lengthMs = balance.seasons.lengthDays * 86_400_000;
  const elapsed = now.getTime() - epoch.getTime();
  const totalSeasons = Math.floor(elapsed / lengthMs);
  const order = balance.seasons.order;
  const index = ((totalSeasons % order.length) + order.length) % order.length;
  const season = (order[index] ?? 'spring') as SeasonName;
  const gameYear = Math.floor(totalSeasons / order.length) + 1;
  const startsAt = new Date(epoch.getTime() + totalSeasons * lengthMs);
  const endsAt = new Date(startsAt.getTime() + lengthMs);

  return {
    season,
    index,
    gameYear,
    startsAt,
    endsAt,
    key: `${season}_y${gameYear}`,
    progress: Math.min(1, Math.max(0, (now.getTime() - startsAt.getTime()) / lengthMs)),
  };
}

export function nextSeason(now: Date, balance: Balance, epoch: Date = GAME_EPOCH): SeasonState {
  const current = seasonAt(now, balance, epoch);
  return seasonAt(new Date(current.endsAt.getTime() + 1_000), balance, epoch);
}

export const SEASON_LABELS: Record<SeasonName, { name: string; emoji: string }> = {
  spring: { name: 'Printemps', emoji: '🌸' },
  summer: { name: 'Été', emoji: '☀️' },
  autumn: { name: 'Automne', emoji: '🍂' },
  winter: { name: 'Hiver', emoji: '❄️' },
};

export interface WeatherState {
  weather: WeatherName;
  emoji: string;
  label: string;
  description: string;
  yieldModifier: number;
  growthModifier: number;
  freeWatering: boolean;
  damageChance: number;
  pestChance: number;
  temperature: number;
  season: SeasonName;
  day: string;
}

/**
 * Tire la météo d'un jour donné pour une saison donnée.
 * `day` est une date `yyyy-MM-dd` en UTC : c'est la graine, donc le résultat est
 * stable et reproductible.
 */
export function rollWeather(
  day: string,
  season: SeasonName,
  balance: Balance,
  secret = 'harvest-weather',
): WeatherState {
  const rng = dailyRng('weather', day, secret);
  const entries = balance.weather.table.map((entry) => ({
    value: entry,
    weight: entry.weights[season] ?? 0,
  }));
  const chosen = rng.weighted(entries) ?? balance.weather.table[0]!;

  // Température cosmétique, cohérente avec la saison et la météo.
  const seasonBase: Record<SeasonName, number> = { spring: 15, summer: 26, autumn: 13, winter: 2 };
  const weatherShift: Record<WeatherName, number> = {
    sunny: 4,
    cloudy: 0,
    rainy: -2,
    storm: -3,
    heatwave: 12,
    frost: -8,
    snow: -6,
  };
  const temperature =
    (seasonBase[season] ?? 15) + (weatherShift[chosen.weather] ?? 0) + rng.int(-2, 2);

  return {
    weather: chosen.weather,
    emoji: chosen.emoji,
    label: chosen.label,
    description: chosen.description,
    yieldModifier: chosen.yieldModifier,
    growthModifier: chosen.growthModifier,
    freeWatering: chosen.freeWatering,
    damageChance: chosen.damageChance,
    pestChance: chosen.pestChance,
    temperature,
    season,
    day,
  };
}

/** Météo neutre, utilisée en repli si la table est indisponible. */
export function neutralWeather(day: string, season: SeasonName): WeatherState {
  return {
    weather: 'cloudy',
    emoji: '☁️',
    label: 'Nuageux',
    description: 'Rien de particulier.',
    yieldModifier: 1,
    growthModifier: 1,
    freeWatering: false,
    damageChance: 0,
    pestChance: 0.05,
    temperature: 16,
    season,
    day,
  };
}

/**
 * Multiplicateur d'arrosage : la canicule double le besoin en eau.
 * Isolé dans une fonction pour que `planCrop()` n'ait pas à connaître la table
 * météo, et pour qu'un événement « sécheresse » puisse réutiliser la même règle.
 */
export function waterMultiplierFor(weather: WeatherName, balance: Balance): number {
  return weather === 'heatwave' ? balance.weather.heatwaveWaterMultiplier : 1;
}
