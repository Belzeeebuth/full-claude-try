import { describe, expect, it } from 'vitest';
import { balance as getBalance, getConfig } from '../src/config';
import {
  almanacPrice,
  almanacTips,
  currentDayFor,
  forecastDayFor,
  forecastExpiry,
  forecastWeather,
  dayStartOf,
  type AlmanacTipKey,
} from '../src/game/almanac';
import { rollWeather, seasonAt, type WeatherState } from '../src/game/world';
import { nextMidnight } from '../src/utils/time';

/**
 * Almanach : tout ce qui est décidable sans base ni Redis. Le service ne
 * fait que brancher ces règles sur le solde, le verrou et le cache.
 */

const balance = getBalance();
const config = getConfig();

/** Météo synthétique : seuls les champs lus par `almanacTips` comptent. */
function weatherLike(overrides: Partial<WeatherState>): WeatherState {
  return {
    weather: 'cloudy',
    emoji: '☁️',
    label: 'Cloudy',
    description: '',
    yieldModifier: 1,
    growthModifier: 1,
    freeWatering: false,
    damageChance: 0,
    pestChance: 0.05,
    temperature: 16,
    season: 'spring',
    day: '2026-07-27',
    ...overrides,
  };
}

const keysOf = (tips: ReturnType<typeof almanacTips>): AlmanacTipKey[] => tips.map((tip) => tip.key);

describe('almanach : jour visé', () => {
  it('vise le jour UTC suivant, quel que soit le moment de la journée', () => {
    expect(forecastDayFor(new Date('2026-07-26T00:00:00.000Z'))).toBe('2026-07-27');
    expect(forecastDayFor(new Date('2026-07-26T23:59:59.999Z'))).toBe('2026-07-27');
    expect(currentDayFor(new Date('2026-07-26T23:59:59.999Z'))).toBe('2026-07-26');
  });

  it('passe correctement les fins de mois et d\'année', () => {
    expect(forecastDayFor(new Date('2026-02-28T12:00:00.000Z'))).toBe('2026-03-01');
    expect(forecastDayFor(new Date('2026-12-31T05:00:00.000Z'))).toBe('2027-01-01');
  });

  it('représente un jour par son minuit UTC, l\'instant où le job fixe la météo', () => {
    expect(dayStartOf('2026-07-27').toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });
});

describe('almanach : prévision', () => {
  it('est stable : deux appels pour la même date donnent le même résultat', () => {
    const first = forecastWeather('2026-07-27', balance);
    const second = forecastWeather('2026-07-27', balance);
    expect(second).toEqual(first);
  });

  it('est exactement le tirage que le monde fera ce jour-là', () => {
    // C'est le produit vendu : aucune approximation. Si `forecastWeather`
    // divergeait du tirage réel, le joueur paierait une information fausse.
    for (let day = 1; day <= 28; day += 1) {
      const key = `2026-11-${String(day).padStart(2, '0')}`;
      const season = seasonAt(dayStartOf(key), balance).season;
      expect(forecastWeather(key, balance)).toEqual(rollWeather(key, season, balance));
    }
  });

  it('porte la saison du jour visé, pas celle du jour d\'achat', () => {
    // Un achat la veille d'un changement de saison doit prévoir avec la
    // nouvelle table de poids : c'est la seule qui sera tirée à minuit.
    const lengthMs = balance.seasons.lengthDays * 86_400_000;
    const boundary = new Date(new Date('2026-01-01T00:00:00.000Z').getTime() + lengthMs);
    const eve = new Date(boundary.getTime() - 3_600_000);
    const forecast = forecastWeather(forecastDayFor(eve), balance);
    expect(forecast.season).toBe(seasonAt(boundary, balance).season);
    expect(forecast.season).not.toBe(seasonAt(eve, balance).season);
  });
});

describe('almanach : prix', () => {
  it('reste un puits monétaire configuré', () => {
    expect(balance.almanac.priceCoins).toBeGreaterThan(0);
    expect(balance.almanac.pricePerLevel).toBeGreaterThan(0);
  });

  it('croît strictement avec le niveau', () => {
    let previous = almanacPrice(0, balance);
    for (let level = 1; level <= balance.progression.maxLevel; level += 1) {
      const price = almanacPrice(level, balance);
      expect(price).toBeGreaterThan(previous);
      expect(Number.isInteger(price)).toBe(true);
      previous = price;
    }
  });

  it('vaut la base plus la part par niveau', () => {
    expect(almanacPrice(1, balance)).toBe(balance.almanac.priceCoins + balance.almanac.pricePerLevel);
    expect(almanacPrice(20, balance)).toBe(
      balance.almanac.priceCoins + 20 * balance.almanac.pricePerLevel,
    );
  });

  it('tolère un niveau négatif ou fractionnaire sans créer de prix cassé', () => {
    expect(almanacPrice(-3, balance)).toBe(balance.almanac.priceCoins);
    expect(almanacPrice(4.9, balance)).toBe(almanacPrice(4, balance));
  });

  it('reste marginal face au revenu d\'une ferme de niveau 20', () => {
    // Contrat du commentaire de `balance.almanac` : la prévision d'un niveau
    // 20 coûte moins qu'UNE parcelle-heure de sa meilleure culture, alors
    // qu'il en cultive des dizaines. Sinon l'almanach deviendrait un impôt.
    const bestPerHour = Math.max(
      ...config.cropList
        .filter((crop) => crop.enabled && crop.requiredLevel <= 20)
        .map((crop) => {
          const cycles = 1 + crop.regrowCycles;
          const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
          return ((crop.sellPrice * crop.baseYield * cycles - crop.seedPrice) / totalSeconds) * 3_600;
        }),
    );
    expect(almanacPrice(20, balance)).toBeLessThan(bestPerHour);
  });
});

describe('almanach : échéance de lecture', () => {
  it('ne fait jamais expirer une prévision avant qu\'elle devienne la météo du jour', () => {
    // 02:00 UTC à São Paulo (UTC-3) : minuit local tombe dans une heure, mais
    // « demain » ne commence qu'au prochain minuit UTC. Expirer à minuit local
    // ferait repayer la même prévision.
    const now = new Date('2026-07-26T02:00:00.000Z');
    const local = nextMidnight(now, 'America/Sao_Paulo');
    expect(local.toISOString()).toBe('2026-07-26T03:00:00.000Z');
    expect(forecastExpiry(now, local).toISOString()).toBe('2026-07-27T00:00:00.000Z');
  });

  it('garde le minuit local quand il est plus tardif que le minuit UTC', () => {
    const now = new Date('2026-07-26T22:30:00.000Z');
    const local = nextMidnight(now, 'Europe/Paris');
    expect(local.toISOString()).toBe('2026-07-27T22:00:00.000Z');
    expect(forecastExpiry(now, local)).toEqual(local);
  });

  it('est toujours dans le futur', () => {
    for (const zone of ['Pacific/Auckland', 'Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
      for (const hour of [0, 6, 12, 18, 23]) {
        const now = new Date(Date.UTC(2026, 6, 26, hour, 30));
        expect(forecastExpiry(now, nextMidnight(now, zone)).getTime()).toBeGreaterThan(
          now.getTime(),
        );
      }
    }
  });
});

describe('almanach : astuces', () => {
  it('reflète chaque effet de la table météo', () => {
    // Le conseil doit suivre la configuration, pas une liste figée : un game
    // designer qui rend la pluie dangereuse doit voir l'avertissement
    // apparaître sans toucher au code.
    for (const entry of balance.weather.table) {
      const keys = keysOf(almanacTips(entry, balance));
      expect(keys.includes('free_watering'), entry.weather).toBe(entry.freeWatering);
      expect(keys.includes('damage'), entry.weather).toBe(entry.damageChance > 0);
      expect(keys.includes('yield_up'), entry.weather).toBe(entry.yieldModifier > 1);
      expect(keys.includes('yield_down'), entry.weather).toBe(entry.yieldModifier < 1);
      expect(keys.includes('growth_up'), entry.weather).toBe(entry.growthModifier > 1);
      expect(keys.includes('growth_down'), entry.weather).toBe(entry.growthModifier < 1);
      expect(keys.includes('pests_none'), entry.weather).toBe(entry.pestChance <= 0);
      expect(keys.includes('water_double'), entry.weather).toBe(entry.weather === 'heatwave');
      expect(keys.length).toBeGreaterThan(0);
    }
  });

  it('chiffre les pourcentages tels que le joueur les lira', () => {
    const storm = almanacTips(
      weatherLike({ weather: 'storm', yieldModifier: 0.9, freeWatering: true, damageChance: 0.12 }),
      balance,
    );
    expect(storm).toEqual([
      { key: 'free_watering', params: {} },
      { key: 'yield_down', params: { percent: 10 } },
      { key: 'damage', params: { percent: 12 } },
    ]);
  });

  it('annonce le multiplicateur d\'eau de la canicule depuis la configuration', () => {
    const tips = almanacTips(
      weatherLike({ weather: 'heatwave', yieldModifier: 0.85, growthModifier: 1.15, damageChance: 0.08 }),
      balance,
    );
    expect(tips).toContainEqual({
      key: 'water_double',
      params: { multiplier: balance.weather.heatwaveWaterMultiplier },
    });
    expect(keysOf(tips)).toEqual(['water_double', 'yield_down', 'growth_up', 'damage']);
  });

  it('prévient d\'une forte pression de nuisibles, et d\'une journée sans', () => {
    expect(keysOf(almanacTips(weatherLike({ pestChance: 0.09 }), balance))).toEqual(['pests_high']);
    expect(keysOf(almanacTips(weatherLike({ pestChance: 0 }), balance))).toEqual(['pests_none']);
  });

  it('a toujours quelque chose à dire, même par temps ordinaire', () => {
    expect(keysOf(almanacTips(weatherLike({}), balance))).toEqual(['neutral']);
  });
});
