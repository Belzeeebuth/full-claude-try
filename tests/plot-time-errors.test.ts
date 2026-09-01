import { describe, expect, it } from 'vitest';
import { balance as getBalance } from '../src/config';
import {
  applyFertilizer,
  describeFertility,
  fallowRecovery,
  pestConsequence,
  rollPest,
  rollWeatherDamage,
  weedGrowth,
} from '../src/game/plot';
import { findPet, isPetUnlocked, PET_CATALOG, unlockedPetKeys } from '../src/game/pets';
import { createRng } from '../src/game/rng';
import {
  CooldownError,
  GameError,
  MaintenanceError,
  ValidationError,
  gameError,
  isGameError,
  toError,
} from '../src/utils/errors';
import {
  addSeconds,
  calendarDaysBetween,
  clampDate,
  currentWeekStart,
  dailyCycleKey,
  days,
  hours,
  isPast,
  isValidTimezone,
  isWeekend,
  minutes,
  msSince,
  msUntil,
  nextMidnight,
  nextMondayMidnight,
  seconds,
  toSqlDate,
  weeklyCycleKey,
} from '../src/utils/time';
import { LockBusyError } from '../src/utils/lock';

/**
 * Ces trois modules étaient les moins couverts du périmètre déclaré dans
 * `vitest.config.ts` — `game/plot.ts` à 3 %, `utils/errors.ts` à 0 % — alors que
 * le seuil de 70 % annoncé par le README n'a jamais pu s'appliquer : le paquet
 * `@vitest/coverage-v8` manquait, et `npm run test:coverage` échouait avant même
 * de mesurer quoi que ce soit. Tout est ici de la logique pure : aucune base,
 * aucun Redis, RNG à graine fixe.
 */

const balance = getBalance();

describe('parcelles : fertilité, herbes et nuisibles', () => {
  it('remonte la fertilité pendant la jachère sans dépasser le maximum', () => {
    const oneHour = 3_600_000;
    expect(fallowRecovery(50, 0, balance)).toBe(50);
    expect(fallowRecovery(50, oneHour, balance)).toBe(
      Math.round(50 + balance.fertility.fallowRecoveryPerHour),
    );
    // Une jachère d'un an ne dépasse jamais le plafond.
    expect(fallowRecovery(50, 365 * 24 * oneHour, balance)).toBe(balance.fertility.max);
  });

  it('traite une durée de jachère négative comme nulle', () => {
    expect(fallowRecovery(40, -50_000, balance)).toBe(40);
  });

  it('fait pousser les herbes de façon monotone, plafonnées à 100', () => {
    const oneHour = 3_600_000;
    expect(weedGrowth(0, 0, balance)).toBe(0);
    expect(weedGrowth(0, 10 * oneHour, balance)).toBeGreaterThan(weedGrowth(0, oneHour, balance));
    expect(weedGrowth(90, 1_000 * oneHour, balance)).toBe(100);
  });

  it('n\'invoque aucun nuisible quand le répulsif est actif', () => {
    const pest = rollPest(
      { windowMs: 86_400_000, weatherPestChance: 1, repelActive: true, weedLevel: 100 },
      balance,
      createRng('repel'),
    );
    expect(pest).toBeUndefined();
  });

  it('finit par invoquer un nuisible connu quand la probabilité est maximale', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      const pest = rollPest(
        { windowMs: 86_400_000, weatherPestChance: 1, repelActive: false, weedLevel: 100 },
        balance,
        createRng(`pest-${seed}`),
      );
      if (pest) seen.add(pest);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const pest of seen) {
      expect(['insects', 'crows', 'fungus', 'mole']).toContain(pest);
    }
  });

  it('ne fait jamais apparaître de nuisible sur une fenêtre de temps nulle', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const pest = rollPest(
        { windowMs: 0, weatherPestChance: 1, repelActive: false, weedLevel: 100 },
        balance,
        createRng(`zero-${seed}`),
      );
      expect(pest).toBeUndefined();
    }
  });

  it('ne flétrit pas systématiquement une culture dont le nuisible est ignoré', () => {
    let withered = 0;
    let damaged = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const outcome = pestConsequence(balance, createRng(`consequence-${seed}`));
      if (outcome.withered) {
        expect(outcome.damagePenalty).toBe(1);
        withered += 1;
      } else {
        expect(outcome.damagePenalty).toBe(balance.pests.yieldLossIfIgnored);
        damaged += 1;
      }
    }
    // Le flétrissement est l'exception, pas la règle : c'est tout l'intérêt du
    // tirage, et une inversion accidentelle du sens du test se verrait ici.
    expect(damaged).toBeGreaterThan(withered);
  });

  it('annule les dégâts météo quand la serre les réduit totalement', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      expect(
        rollWeatherDamage({ damageChance: 1, damageReduction: 1 }, createRng(`greenhouse-${seed}`)),
      ).toBe(0);
    }
  });

  it('borne les dégâts météo entre 15 % et 45 % quand ils surviennent', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const damage = rollWeatherDamage(
        { damageChance: 1, damageReduction: 0 },
        createRng(`storm-${seed}`),
      );
      expect(damage).toBeGreaterThanOrEqual(0.15);
      expect(damage).toBeLessThanOrEqual(0.45);
    }
  });

  it('plafonne la fertilité apportée par un engrais', () => {
    const applied = applyFertilizer(balance.fertility.max, { fertility: 50, yieldBoost: 0.2 }, balance);
    expect(applied.fertility).toBe(balance.fertility.max);
    expect(applied.yieldBoost).toBe(0.2);
    expect(applied.qualityBoost).toBe(0);
  });

  it('décrit la fertilité par paliers strictement décroissants', () => {
    expect(describeFertility(100, balance)).toBe('common.fertility.excellent');
    expect(describeFertility(balance.fertility.start, balance)).toBe('common.fertility.good');
    expect(describeFertility(balance.fertility.lowThreshold, balance)).toBe(
      'common.fertility.average',
    );
    expect(describeFertility(1, balance)).toBe('common.fertility.depleted');
    expect(describeFertility(0, balance)).toBe('common.fertility.barren');
  });
});

describe('compagnons de ferme', () => {
  it('ne débloque un compagnon qu\'à partir de son niveau', () => {
    for (const pet of PET_CATALOG) {
      expect(isPetUnlocked(pet.key, pet.unlockLevel)).toBe(true);
      if (pet.unlockLevel > 1) {
        expect(isPetUnlocked(pet.key, pet.unlockLevel - 1)).toBe(false);
      }
    }
  });

  it('ignore une clé de compagnon inconnue', () => {
    expect(findPet('griffon')).toBeUndefined();
    expect(isPetUnlocked('griffon', 999)).toBe(false);
  });

  it('élargit la liste des compagnons au fil des niveaux, sans jamais la réduire', () => {
    let previous = 0;
    for (let level = 1; level <= 80; level += 1) {
      const unlocked = unlockedPetKeys(level).length;
      expect(unlocked).toBeGreaterThanOrEqual(previous);
      previous = unlocked;
    }
    expect(unlockedPetKeys(100)).toHaveLength(PET_CATALOG.length);
  });
});

describe('utilitaires de temps', () => {
  it('convertit les durées', () => {
    expect(seconds(90)).toBe(90_000);
    expect(minutes(2)).toBe(120_000);
    expect(hours(1)).toBe(3_600_000);
    expect(days(1)).toBe(86_400_000);
  });

  it('décale une date sans muter l\'originale', () => {
    const origin = new Date('2026-03-01T10:00:00Z');
    const shifted = addSeconds(origin, 60);
    expect(shifted.toISOString()).toBe('2026-03-01T10:01:00.000Z');
    expect(origin.toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('compare des instants', () => {
    const now = new Date('2026-03-01T10:00:00Z');
    expect(isPast(new Date('2026-02-28T10:00:00Z'), now)).toBe(true);
    expect(isPast(new Date('2026-03-02T10:00:00Z'), now)).toBe(false);
    expect(isPast(null, now)).toBe(false);
    expect(isPast(undefined, now)).toBe(false);
    expect(msUntil(new Date('2026-03-01T10:00:10Z'), now)).toBe(10_000);
    // Jamais négatif : un délai dépassé vaut zéro, pas « moins trois secondes ».
    expect(msUntil(new Date('2026-03-01T09:00:00Z'), now)).toBe(0);
    expect(msSince(new Date('2026-03-01T09:00:00Z'), now)).toBe(3_600_000);
  });

  it('borne une date dans un intervalle', () => {
    const min = new Date('2026-03-01T00:00:00Z');
    const max = new Date('2026-03-31T00:00:00Z');
    expect(clampDate(new Date('2026-01-01T00:00:00Z'), min, max).toISOString()).toBe(
      min.toISOString(),
    );
    expect(clampDate(new Date('2026-12-01T00:00:00Z'), min, max).toISOString()).toBe(
      max.toISOString(),
    );
    expect(clampDate(new Date('2026-03-15T00:00:00Z'), min, max).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('produit des clés de cycle stables et ordonnables', () => {
    const key = dailyCycleKey(new Date('2026-03-01T12:00:00Z'));
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dailyCycleKey(new Date('2026-03-01T13:00:00Z'))).toBe(key);
    expect(dailyCycleKey(new Date('2026-03-02T13:00:00Z'))).not.toBe(key);
    expect(weeklyCycleKey(new Date('2026-03-01T12:00:00Z'))).toMatch(/^\d{4}-W\d{1,2}$/);
    expect(currentWeekStart(new Date('2026-03-04T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('place le prochain minuit et le prochain lundi dans le futur', () => {
    const now = new Date('2026-03-04T12:00:00Z');
    expect(nextMidnight(now).getTime()).toBeGreaterThan(now.getTime());
    const monday = nextMondayMidnight(now);
    expect(monday.getTime()).toBeGreaterThan(now.getTime());
    expect(monday.getTime() - now.getTime()).toBeLessThanOrEqual(8 * 86_400_000);
  });

  it('compte les jours calendaires du FUSEAU, pas les tranches de 24 h', () => {
    // Deux minutes d'écart à cheval sur minuit à Paris (23:59 puis 00:01 heure
    // locale, soit 22:59Z et 23:01Z en mars) font bien UN jour d'écart : c'est
    // ce qui distingue une série quotidienne d'un compteur d'heures. Le fuseau
    // compte vraiment — les mêmes instants raisonnés en UTC donnent 0.
    expect(
      calendarDaysBetween(new Date('2026-03-01T22:59:00Z'), new Date('2026-03-01T23:01:00Z')),
    ).toBe(1);
    expect(
      calendarDaysBetween(new Date('2026-03-01T22:59:00Z'), new Date('2026-03-01T23:01:00Z'), 'utc'),
    ).toBe(0);
    expect(
      calendarDaysBetween(new Date('2026-03-01T08:00:00Z'), new Date('2026-03-01T20:00:00Z')),
    ).toBe(0);
  });

  it('reconnaît le week-end', () => {
    // 7 mars 2026 = samedi, 9 mars 2026 = lundi.
    expect(isWeekend(new Date('2026-03-07T12:00:00Z'))).toBe(true);
    expect(isWeekend(new Date('2026-03-09T12:00:00Z'))).toBe(false);
  });

  it('valide les fuseaux horaires', () => {
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });

  it('formate une date SQL', () => {
    expect(toSqlDate(new Date('2026-03-04T22:30:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('hiérarchie d\'erreurs', () => {
  it('distingue une erreur de jeu d\'une erreur technique', () => {
    const game = gameError('insufficient_funds', 'Pas assez.', {
      i18nKey: 'common.insufficient_funds',
      params: { missing: 10 },
      suggestedCommand: 'shop',
    });
    expect(isGameError(game)).toBe(true);
    expect(game.code).toBe('insufficient_funds');
    expect(game.suggestedCommand).toBe('shop');
    expect(game.params).toEqual({ missing: 10 });

    expect(isGameError(new Error('boom'))).toBe(false);
    expect(isGameError('boom')).toBe(false);
    expect(isGameError(null)).toBe(false);
  });

  it('donne un code utile à chaque sous-classe', () => {
    expect(new ValidationError('nope').code).toBe('quantity_invalid');
    expect(new MaintenanceError('en travaux').code).toBe('maintenance');

    const retryAt = new Date(Date.now() + 60_000);
    const cooldown = new CooldownError(retryAt, 'daily');
    expect(cooldown.code).toBe('cooldown');
    expect(cooldown.retryAt).toBe(retryAt);
    // Le paramètre porte un timestamp Discord, pas une durée figée à la levée.
    expect(String(cooldown.params?.when)).toMatch(/^<t:\d+:R>$/);

    for (const error of [new ValidationError('x'), new MaintenanceError('x'), cooldown]) {
      expect(error).toBeInstanceOf(GameError);
      expect(isGameError(error)).toBe(true);
    }
  });

  it('normalise n\'importe quelle valeur attrapée en Error', () => {
    const original = new Error('déjà une erreur');
    expect(toError(original)).toBe(original);
    expect(toError('texte').message).toBe('texte');
    expect(toError({ code: 42 }).message).toBe('{"code":42}');

    // Une référence circulaire casse JSON.stringify : le repli doit tenir.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toError(circular)).toBeInstanceOf(Error);
    // `JSON.stringify(undefined)` ne lève pas : il renvoie `undefined`, et
    // `new Error(undefined)` donne un message vide. On fige le comportement
    // réel plutôt que celui qu'on aurait pu supposer.
    expect(toError(undefined)).toBeInstanceOf(Error);
    expect(toError(undefined).message).toBe('');
  });

  it('expose la clé du verrou occupé', () => {
    const busy = new LockBusyError('cmd:harvest');
    expect(busy.lockKey).toBe('cmd:harvest');
    expect(busy.name).toBe('LockBusyError');
  });
});
