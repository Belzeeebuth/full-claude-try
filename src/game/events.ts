/**
 * Fenêtres d'occurrence des évènements récurrents.
 *
 * POURQUOI CE MODULE : `events.json` décrit cinq évènements par un `recurringCron`
 * (« le 20 mars », « vendredi 18 h ») mais la configuration est un fichier JSON en
 * lecture seule : personne n'y écrit jamais `startsAt`/`endsAt`. `getActiveEvents`
 * écartait donc tout évènement à cron — cinq des six ne se sont jamais déclenchés.
 *
 * La fenêtre courante se CALCULE à la lecture, sans état ni E/S : dernière
 * occurrence du cron à ou avant `now`, plus `durationHours`. Déterministe, donc
 * testable et identique sur tous les shards.
 *
 * Le cron est évalué en UTC, comme toutes les cadences du projet
 * (`src/jobs/definitions.ts`).
 */

/** Sous-ensemble de cron à 5 champs : minute heure jour-du-mois mois jour-de-semaine. */
export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[] | null; // null = `*` (non restreint)
  months: number[];
  daysOfWeek: number[] | null; // null = `*` (non restreint)
}

function parseField(spec: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step: ${part}`);
    let from = min;
    let to = max;
    if (range !== '*' && range !== undefined) {
      const bounds = range.split('-');
      from = Number.parseInt(bounds[0] ?? '', 10);
      to = bounds.length > 1 ? Number.parseInt(bounds[1] ?? '', 10) : from;
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`invalid field: ${part}`);
      if (from < min || to > max || to < from) throw new Error(`field out of range: ${part}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error(`expected a 5-field cron expression: "${expression}"`);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: dom === '*' ? null : parseField(dom, 1, 31),
    months: parseField(month, 1, 12),
    // 7 et 0 désignent tous deux dimanche, comme dans cron.
    daysOfWeek: dow === '*' ? null : parseField(dow, 0, 7).map((d) => (d === 7 ? 0 : d)),
  };
}

/** Le jour (UTC) tombe-t-il dans le calendrier du cron ? */
function dayMatches(cron: CronFields, date: Date): boolean {
  if (!cron.months.includes(date.getUTCMonth() + 1)) return false;
  const domOk = cron.daysOfMonth === null || cron.daysOfMonth.includes(date.getUTCDate());
  const dowOk = cron.daysOfWeek === null || cron.daysOfWeek.includes(date.getUTCDay());
  // Sémantique cron : deux champs restreints se combinent en OU, pas en ET.
  if (cron.daysOfMonth !== null && cron.daysOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * Dernière occurrence du cron à ou avant `now`, ou `null` si aucune dans la
 * fenêtre de recherche. `lookbackDays` borne le coût : inutile de remonter
 * au-delà de la durée d'un évènement.
 */
export function lastOccurrenceAtOrBefore(
  cron: CronFields,
  now: Date,
  lookbackDays: number,
): Date | null {
  for (let offset = 0; offset <= lookbackDays; offset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - offset);
    if (!dayMatches(cron, day)) continue;
    // On parcourt les heures/minutes du plus tard au plus tôt : la première
    // qui n'est pas dans le futur est la dernière occurrence de ce jour.
    for (let h = cron.hours.length - 1; h >= 0; h -= 1) {
      for (let m = cron.minutes.length - 1; m >= 0; m -= 1) {
        const candidate = new Date(day.getTime());
        candidate.setUTCHours(cron.hours[h]!, cron.minutes[m], 0, 0);
        if (candidate.getTime() <= now.getTime()) return candidate;
      }
    }
  }
  return null;
}

export interface EventWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Fenêtre en cours d'un évènement récurrent, ou `null` s'il est entre deux
 * occurrences.
 */
export function currentEventWindow(
  recurringCron: string,
  durationHours: number,
  now: Date,
): EventWindow | null {
  if (!(durationHours > 0)) return null;
  const cron = parseCron(recurringCron);
  const lookbackDays = Math.ceil(durationHours / 24) + 1;
  const start = lastOccurrenceAtOrBefore(cron, now, lookbackDays);
  if (!start) return null;
  const endsAt = new Date(start.getTime() + durationHours * 3_600_000);
  return now.getTime() < endsAt.getTime() ? { startsAt: start, endsAt } : null;
}

/** Prochaine occurrence après `now` (affichage « revient dans … »). */
export function nextOccurrenceAfter(
  cron: CronFields,
  now: Date,
  lookaheadDays = 400,
): Date | null {
  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    day.setUTCDate(day.getUTCDate() + offset);
    if (!dayMatches(cron, day)) continue;
    for (const h of cron.hours) {
      for (const m of cron.minutes) {
        const candidate = new Date(day.getTime());
        candidate.setUTCHours(h, m, 0, 0);
        if (candidate.getTime() > now.getTime()) return candidate;
      }
    }
  }
  return null;
}
