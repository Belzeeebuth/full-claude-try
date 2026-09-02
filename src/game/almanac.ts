import type { Balance } from '../config/gameplay/schemas';
import { addMoney, scaleMoney } from './money';
import { rollWeather, seasonAt, waterMultiplierFor, type WeatherState } from './world';

/**
 * ---------------------------------------------------------------------------
 * ALMANACH — règles pures
 * ---------------------------------------------------------------------------
 * La météo du jour est tirée de façon déterministe (`rollWeather`, graine
 * `WORLD_SEED`). Elle a été rendue imprévisible pour les joueurs quand la
 * graine codée en dur a été retirée : connaître la pluie de demain, c'est
 * savoir quand planter sans arroser, et quand rentrer la récolte avant l'orage.
 *
 * L'almanach VEND cette information : c'est thématique (l'almanach du fermier)
 * et c'est un puits monétaire — l'argent quitte l'économie sans contrepartie
 * matérielle, ce que le pilier « économie fermée » réclame en permanence.
 *
 * Tout ce qui est décidable sans E/S vit ici : le jour visé, le prix, la
 * prévision et la lecture actionnable de la table météo. Le service ne fait
 * qu'y brancher le solde, le verrou et le cache.
 */

/** Longueur d'un jour en millisecondes, dupliquée ici pour ne rien importer de `utils/`. */
const DAY_MS = 86_400_000;

/**
 * Jour visé par la prévision : le lendemain en UTC.
 *
 * La météo est un état GLOBAL indexé par la date UTC (`toSqlDate` dans
 * `world.service`) et fixée par le job de minuit UTC. « Demain » est donc le
 * jour UTC suivant, quel que soit le fuseau du joueur — sinon deux joueurs
 * achèteraient, à la même seconde, deux prévisions différentes d'un même monde.
 */
export function forecastDayFor(now: Date): string {
  const next = new Date(now.getTime() + DAY_MS);
  return next.toISOString().slice(0, 10);
}

/** Jour UTC courant au même format, pour comparer avec `forecastDayFor`. */
export function currentDayFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Premier instant d'un jour `yyyy-MM-dd` : son minuit UTC. C'est l'instant
 * auquel le job `world` fixe la météo, donc celui auquel la saison et les
 * événements à météo imposée doivent être évalués pour prévoir juste.
 */
export function dayStartOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Prix de la prévision : une base fixe plus une part proportionnelle au niveau.
 *
 * Le niveau est la meilleure approximation du revenu horaire d'un joueur (le
 * profit par parcelle croît strictement avec le niveau requis des cultures).
 * Indexer le prix dessus garde la prévision anecdotique pour un débutant sans
 * qu'elle devienne gratuite pour un vétéran ; l'ordre de grandeur est justifié
 * dans le commentaire de `balance.almanac`.
 */
export function almanacPrice(level: number, balance: Balance): number {
  const safeLevel = Math.max(0, Math.floor(level));
  return addMoney(balance.almanac.priceCoins, scaleMoney(balance.almanac.pricePerLevel, safeLevel));
}

/**
 * Prévision EXACTE d'un jour donné : le même tirage que celui que le monde fera
 * à minuit. Aucun bruit ajouté — une prévision approximative serait un produit
 * trompeur, et le joueur qui paie doit pouvoir s'y fier pour planter.
 *
 * La saison est celle du premier instant du jour visé : les saisons changent
 * à minuit UTC (époque alignée, longueur en jours entiers), et c'est
 * précisément là que `getWorldState` tirera la météo réelle.
 */
export function forecastWeather(day: string, balance: Balance): WeatherState {
  const season = seasonAt(dayStartOf(day), balance).season;
  return rollWeather(day, season, balance);
}

/**
 * Échéance de la mémorisation d'une prévision achetée.
 *
 * La règle voulue est « jusqu'à minuit chez le joueur », mais le monde change
 * de jour à minuit UTC. Pour un joueur dont le minuit local tombe AVANT le
 * minuit UTC (Amériques), appliquer la règle seule ferait expirer la prévision
 * alors qu'elle concerne toujours demain — et le joueur repaierait la même
 * information. On garde donc la plus tardive des deux échéances : la
 * prévision reste lisible tant qu'elle est une prévision.
 */
export function forecastExpiry(now: Date, localMidnight: Date): Date {
  const utcMidnight = new Date(`${forecastDayFor(now)}T00:00:00.000Z`);
  return localMidnight.getTime() > utcMidnight.getTime() ? localMidnight : utcMidnight;
}

export type AlmanacTipKey =
  | 'free_watering'
  | 'water_double'
  | 'yield_up'
  | 'yield_down'
  | 'growth_up'
  | 'growth_down'
  | 'damage'
  | 'pests_high'
  | 'pests_none'
  | 'neutral';

export interface AlmanacTip {
  key: AlmanacTipKey;
  params: Record<string, number>;
}

/** Seuil à partir duquel une pression de nuisibles mérite un avertissement. */
const PEST_WARNING_THRESHOLD = 0.08;

/**
 * Lecture ACTIONNABLE de la météo prévue : chaque effet chiffré de la table
 * devient un conseil (« pluie demain : arrosage gratuit, plantez ce soir »).
 *
 * Les conseils sont des clés + paramètres, traduits par l'appelant : le moteur
 * ne connaît pas la langue du joueur. L'ordre est celui de l'utilité — ce qui
 * fait gagner de l'eau ou de l'argent d'abord, les risques ensuite.
 */
export function almanacTips(
  weather: Pick<
    WeatherState,
    'weather' | 'yieldModifier' | 'growthModifier' | 'freeWatering' | 'damageChance' | 'pestChance'
  >,
  balance: Balance,
): AlmanacTip[] {
  const tips: AlmanacTip[] = [];
  const percentOf = (ratio: number): number => Math.round(Math.abs(ratio) * 100);

  if (weather.freeWatering) tips.push({ key: 'free_watering', params: {} });

  const waterMultiplier = waterMultiplierFor(weather.weather, balance);
  if (waterMultiplier > 1) {
    tips.push({ key: 'water_double', params: { multiplier: waterMultiplier } });
  }

  if (weather.yieldModifier > 1) {
    tips.push({ key: 'yield_up', params: { percent: percentOf(weather.yieldModifier - 1) } });
  } else if (weather.yieldModifier < 1) {
    tips.push({ key: 'yield_down', params: { percent: percentOf(1 - weather.yieldModifier) } });
  }

  if (weather.growthModifier > 1) {
    tips.push({ key: 'growth_up', params: { percent: percentOf(weather.growthModifier - 1) } });
  } else if (weather.growthModifier < 1) {
    tips.push({ key: 'growth_down', params: { percent: percentOf(1 - weather.growthModifier) } });
  }

  if (weather.damageChance > 0) {
    tips.push({ key: 'damage', params: { percent: percentOf(weather.damageChance) } });
  }

  if (weather.pestChance <= 0) {
    tips.push({ key: 'pests_none', params: {} });
  } else if (weather.pestChance >= PEST_WARNING_THRESHOLD) {
    tips.push({ key: 'pests_high', params: { percent: percentOf(weather.pestChance) } });
  }

  if (tips.length === 0) tips.push({ key: 'neutral', params: {} });
  return tips;
}
