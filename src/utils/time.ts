import { DateTime } from 'luxon';

/**
 * Utilitaires temporels. Aucun accès à l'environnement ni à la base : toutes
 * les fonctions prennent l'instant de référence en paramètre (`now`), ce qui les
 * rend déterministes et testables sans figer l'horloge globale.
 *
 * Convention : la base stocke du TIMESTAMPTZ (donc de l'UTC), et l'on ne
 * convertit dans le fuseau du joueur qu'au moment de calculer une « journée de
 * jeu » (récompense quotidienne, quêtes journalières). Sans cela, un joueur à
 * Nouméa verrait sa journée basculer en plein après-midi.
 */

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function seconds(count: number): number {
  return count * SECOND;
}

export function minutes(count: number): number {
  return count * MINUTE;
}

export function hours(count: number): number {
  return count * HOUR;
}

export function days(count: number): number {
  return count * DAY;
}

export function addSeconds(date: Date, count: number): Date {
  return new Date(date.getTime() + count * SECOND);
}

export function isPast(date: Date | null | undefined, now: Date = new Date()): boolean {
  return date !== null && date !== undefined && date.getTime() <= now.getTime();
}

export function msUntil(date: Date, now: Date = new Date()): number {
  return Math.max(0, date.getTime() - now.getTime());
}

export function msSince(date: Date, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - date.getTime());
}

export function clampDate(date: Date, min: Date, max: Date): Date {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

/** Clé de cycle journalier dans le fuseau du joueur : `2026-07-26`. */
export function dailyCycleKey(now: Date = new Date(), timezone = 'Europe/Paris'): string {
  return DateTime.fromJSDate(now, { zone: timezone }).toFormat('yyyy-MM-dd');
}

/** Clé de cycle hebdomadaire ISO : `2026-W30` (semaine commençant le lundi). */
export function weeklyCycleKey(now: Date = new Date(), timezone = 'Europe/Paris'): string {
  const dt = DateTime.fromJSDate(now, { zone: timezone });
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, '0')}`;
}

/** Prochain minuit dans le fuseau du joueur — échéance des quêtes journalières. */
export function nextMidnight(now: Date = new Date(), timezone = 'Europe/Paris'): Date {
  return DateTime.fromJSDate(now, { zone: timezone })
    .plus({ days: 1 })
    .startOf('day')
    .toJSDate();
}

/** Prochain lundi 00:00 — échéance des quêtes hebdomadaires et des objectifs de coop. */
export function nextMondayMidnight(now: Date = new Date(), timezone = 'Europe/Paris'): Date {
  const dt = DateTime.fromJSDate(now, { zone: timezone });
  return dt.plus({ weeks: 1 }).startOf('week').toJSDate();
}

/** Lundi de la semaine courante, au format `yyyy-MM-dd` (clé des objectifs de coop). */
export function currentWeekStart(now: Date = new Date(), timezone = 'Europe/Paris'): string {
  return DateTime.fromJSDate(now, { zone: timezone }).startOf('week').toFormat('yyyy-MM-dd');
}

/** Vrai du vendredi 00:00 au dimanche 23:59 (bonus de vote week-end). */
export function isWeekend(now: Date = new Date(), timezone = 'Europe/Paris'): boolean {
  const weekday = DateTime.fromJSDate(now, { zone: timezone }).weekday;
  return weekday >= 5;
}

/** Nombre de jours calendaires entre deux dates dans un fuseau donné. */
export function calendarDaysBetween(
  from: Date,
  to: Date,
  timezone = 'Europe/Paris',
): number {
  const a = DateTime.fromJSDate(from, { zone: timezone }).startOf('day');
  const b = DateTime.fromJSDate(to, { zone: timezone }).startOf('day');
  return Math.round(b.diff(a, 'days').days);
}

export function isValidTimezone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

/** Date SQL `yyyy-MM-dd` en UTC (colonnes `date`). */
export function toSqlDate(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('yyyy-MM-dd');
}
