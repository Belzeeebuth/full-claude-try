import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { eventSchema } from '../src/config/gameplay/schemas';
import {
  currentEventWindow,
  lastOccurrenceAtOrBefore,
  nextOccurrenceAfter,
  parseCron,
} from '../src/game/events';
import { getActiveEvents } from '../src/services/world.service';

/**
 * Ces tests existent à cause d'un défaut qui a vécu longtemps sans se voir :
 * `events.json` décrivait cinq évènements par un `recurringCron`, mais la
 * fenêtre d'activité était censée être écrite dans la configuration par un
 * ordonnanceur qui n'a jamais existé. Résultat : cinq évènements sur six ne se
 * sont jamais déclenchés, sans la moindre erreur nulle part.
 *
 * Le calcul est désormais fait à la lecture. Un test qui vérifie « il existe
 * des jours où l'évènement est actif » aurait attrapé le défaut d'origine.
 */

const UTC = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  new Date(Date.UTC(y, m - 1, d, h, min));

describe('analyse du cron', () => {
  it('lit les cinq champs', () => {
    const cron = parseCron('0 18 * * 5');
    expect(cron.minutes).toEqual([0]);
    expect(cron.hours).toEqual([18]);
    expect(cron.daysOfMonth).toBeNull();
    expect(cron.months).toHaveLength(12);
    expect(cron.daysOfWeek).toEqual([5]);
  });

  it('accepte listes, plages et pas', () => {
    expect(parseCron('0,30 */6 1-3 * *').minutes).toEqual([0, 30]);
    expect(parseCron('0,30 */6 1-3 * *').hours).toEqual([0, 6, 12, 18]);
    expect(parseCron('0,30 */6 1-3 * *').daysOfMonth).toEqual([1, 2, 3]);
  });

  it('traite 7 comme dimanche, à l\'égal de 0', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
  });

  it('refuse une expression qui n\'a pas cinq champs ou sort des bornes', () => {
    expect(() => parseCron('0 18 * *')).toThrow();
    expect(() => parseCron('0 99 * * *')).toThrow();
    expect(() => parseCron('0 18 * * 9')).toThrow();
  });
});

describe('fenêtre d\'occurrence', () => {
  it('trouve la dernière occurrence à ou avant l\'instant donné', () => {
    // Vendredi 20 mars 2026, 18 h : l'occurrence commence à cet instant précis.
    const cron = parseCron('0 18 * * 5');
    expect(lastOccurrenceAtOrBefore(cron, UTC(2026, 3, 20, 18, 0), 7)?.toISOString())
      .toBe('2026-03-20T18:00:00.000Z');
    // Une minute avant, c'est le vendredi PRÉCÉDENT.
    expect(lastOccurrenceAtOrBefore(cron, UTC(2026, 3, 20, 17, 59), 7)?.toISOString())
      .toBe('2026-03-13T18:00:00.000Z');
  });

  it('ouvre et referme le week-end doublé à la minute près', () => {
    const active = (d: Date): boolean => currentEventWindow('0 18 * * 5', 54, d) !== null;
    expect(active(UTC(2026, 3, 20, 17, 59))).toBe(false);
    expect(active(UTC(2026, 3, 20, 18, 0))).toBe(true);
    expect(active(UTC(2026, 3, 22, 23, 59))).toBe(true);
    // Dimanche minuit : 54 h après vendredi 18 h, la fenêtre est close.
    expect(active(UTC(2026, 3, 23, 0, 0))).toBe(false);
  });

  it('gère le 29 février d\'une année bissextile', () => {
    expect(currentEventWindow('0 0 29 2 *', 24, UTC(2028, 2, 29, 5))).not.toBeNull();
    expect(currentEventWindow('0 0 29 2 *', 24, UTC(2027, 3, 1, 5))).toBeNull();
  });

  it('refuse une durée nulle ou négative plutôt que d\'ouvrir une fenêtre vide', () => {
    expect(currentEventWindow('0 18 * * 5', 0, UTC(2026, 3, 21))).toBeNull();
    expect(currentEventWindow('0 18 * * 5', -3, UTC(2026, 3, 21))).toBeNull();
  });

  it('annonce la prochaine occurrence', () => {
    expect(nextOccurrenceAfter(parseCron('0 0 20 3 *'), UTC(2026, 3, 20, 12))?.toISOString())
      .toBe('2027-03-20T00:00:00.000Z');
  });
});

describe('évènements de la configuration', () => {
  const events = getConfig('fr').eventList;

  it('donne une durée à tout évènement récurrent', () => {
    for (const event of events) {
      if (event.recurringCron) expect(event.durationHours, event.key).toBeGreaterThan(0);
    }
  });

  it('refuse au chargement un cron sans durée', () => {
    const base = {
      key: 'test_event',
      name: 'Test',
      description: 'Test',
      recurringCron: '0 0 1 1 *',
    };
    expect(eventSchema.safeParse(base).success).toBe(false);
    expect(eventSchema.safeParse({ ...base, durationHours: 24 }).success).toBe(true);
  });

  it('rend chaque évènement récurrent actif au moins un jour dans l\'année', () => {
    // Le défaut d'origine : AUCUN jour actif, pour cinq évènements sur six.
    for (const event of events) {
      if (!event.recurringCron || !event.durationHours) continue;
      let activeDays = 0;
      for (let day = 0; day < 365; day += 1) {
        const now = new Date(UTC(2026, 1, 1, 12).getTime() + day * 86_400_000);
        if (currentEventWindow(event.recurringCron, event.durationHours, now)) activeDays += 1;
      }
      expect(activeDays, event.key).toBeGreaterThan(0);
    }
  });

  it('active la fête du printemps le 20 mars et la referme dix jours plus tard', () => {
    const during = getActiveEvents(UTC(2026, 3, 22, 12), 'fr').map((e) => e.key);
    expect(during).toContain('spring_festival');
    const after = getActiveEvents(UTC(2026, 4, 15, 12), 'fr').map((e) => e.key);
    expect(after).not.toContain('spring_festival');
  });

  it('donne à l\'évènement actif les dates de son occurrence en cours', () => {
    const spring = getActiveEvents(UTC(2026, 3, 22, 12), 'fr').find((e) => e.key === 'spring_festival');
    expect(spring?.startsAt).toBe('2026-03-20T00:00:00.000Z');
    expect(spring?.endsAt).toBe('2026-03-30T00:00:00.000Z');
  });

  it('laisse un évènement sans cron ni dates actif en permanence', () => {
    const permanent = events.filter((e) => e.enabled && !e.recurringCron && !e.startsAt);
    for (const event of permanent) {
      expect(getActiveEvents(UTC(2026, 7, 4, 12), 'fr').map((e) => e.key)).toContain(event.key);
    }
  });
});
