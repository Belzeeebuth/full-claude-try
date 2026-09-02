import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n';
import {
  MAX_CONTENT_LENGTH,
  MAX_MENTIONS_PER_MESSAGE,
  MAX_MESSAGE_LENGTH,
  REMINDER_TYPES,
  planReminderMessage,
  type ReminderEntry,
} from '../src/services/reminder.service';

/**
 * Rappels en salon : la LONGUEUR du message groupé.
 *
 * Le plafond de vingt ne compte que des personnes ; la longueur, elle, croît
 * avec les couples (joueur, type) — jusqu'à huit mentions de dix-neuf chiffres
 * par joueur. Vingt joueurs × cinq types faisaient ~2 400 caractères : Discord
 * refuse le message (50035), le worker le recompose à l'identique, et après
 * quatre tentatives les rappels du lot ne sont plus réservables ni en salon ni
 * en message privé. Perte définitive et silencieuse.
 *
 * Le test qui existait ne pouvait pas le voir : il fabriquait ses identifiants
 * avec `${100000000000000000 + index}`, une addition de `Number` au-delà de
 * 2^53 (ULP = 16) qui ne produit que deux chaînes distinctes. Deux mentions,
 * 640 caractères, plafond jamais atteint. D'où `snowflake()` ci-dessous, en
 * `BigInt`, et l'assertion qui vérifie d'abord que les identifiants SONT
 * distincts.
 */

const fr = translatorFor('fr');
const en = translatorFor('en');

/** Identifiant Discord plausible : 18 chiffres, réellement distinct. */
function snowflake(index: number): string {
  return String(100_000_000_000_000_000n + BigInt(index));
}

let nextId = 1;

function entry(discordId: string, type: ReminderEntry['type']): ReminderEntry {
  return {
    id: nextId++,
    type,
    discordId,
    guildId: 'g1',
    channelId: 'c1',
    locale: 'fr',
    batchMinutes: 10,
  };
}

/** `players` joueurs distincts, chacun avec ses `types` premiers types. */
function batch(players: number, types: number): ReminderEntry[] {
  const entries: ReminderEntry[] = [];
  for (let index = 0; index < players; index += 1) {
    for (const type of REMINDER_TYPES.slice(0, types)) entries.push(entry(snowflake(index), type));
  }
  return entries;
}

describe('rappels en salon : longueur du message', () => {
  it('fabrique bien des identifiants distincts (le piège du test précédent)', () => {
    const ids = Array.from({ length: MAX_MENTIONS_PER_MESSAGE }, (_, index) => snowflake(index));
    expect(new Set(ids).size).toBe(MAX_MENTIONS_PER_MESSAGE);
    // La forme fautive, gardée comme repère : deux valeurs pour vingt joueurs.
    const naive = Array.from({ length: MAX_MENTIONS_PER_MESSAGE }, (_, index) =>
      String(100000000000000000 + index),
    );
    expect(new Set(naive).size).toBeLessThan(MAX_MENTIONS_PER_MESSAGE);
  });

  it('tient sous la limite de Discord au pire cas, en français comme en anglais', () => {
    for (const t of [fr, en]) {
      const plan = planReminderMessage(batch(MAX_MENTIONS_PER_MESSAGE, REMINDER_TYPES.length), t);
      expect(plan.message).not.toBeNull();
      expect(plan.message!.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(plan.message!.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
      // Le pire cas NE TIENT PAS en un message : le reste doit être reporté,
      // pas tronqué en silence.
      expect(plan.deferred.length).toBeGreaterThan(0);
    }
  });

  it('tient aussi sur le cas décrit : vingt joueurs, cinq types', () => {
    const plan = planReminderMessage(batch(MAX_MENTIONS_PER_MESSAGE, 5), fr);
    expect(plan.message!.content.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
  });

  it('ne coupe jamais un joueur en deux : mentionné, il emporte tous ses rappels', () => {
    const entries = batch(MAX_MENTIONS_PER_MESSAGE, REMINDER_TYPES.length);
    const plan = planReminderMessage(entries, fr);

    const mentioned = new Set(plan.message!.mentionIds);
    for (const deferredEntry of plan.deferred) {
      expect(mentioned.has(deferredEntry.discordId)).toBe(false);
      expect(plan.message!.content).not.toContain(`<@${deferredEntry.discordId}>`);
    }
    for (const id of mentioned) expect(plan.message!.content).toContain(`<@${id}>`);
  });

  it('ne perd aucun rappel : tout est livré ou reporté, une seule fois', () => {
    const entries = batch(MAX_MENTIONS_PER_MESSAGE, REMINDER_TYPES.length);
    const plan = planReminderMessage(entries, fr);

    const seen = [...plan.message!.notificationIds, ...plan.deferred.map((item) => item.id)];
    expect(new Set(seen).size).toBe(entries.length);
    expect(seen).toHaveLength(entries.length);
  });

  it('garde toujours au moins un joueur, même avec un budget absurde', () => {
    // Sinon le lot ne partirait jamais : réservé, reporté, réservé…
    const plan = planReminderMessage(batch(3, 2), fr, MAX_MENTIONS_PER_MESSAGE, 10);
    expect(plan.message).not.toBeNull();
    expect(plan.message!.mentionIds).toHaveLength(1);
    expect(plan.deferred.map((item) => item.discordId)).toEqual([
      snowflake(1),
      snowflake(1),
      snowflake(2),
      snowflake(2),
    ]);
  });

  it('le plafond de personnes reste prioritaire quand la longueur, elle, tient', () => {
    const plan = planReminderMessage(batch(MAX_MENTIONS_PER_MESSAGE + 3, 1), fr);
    expect(plan.message!.mentionIds).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
    expect(plan.deferred.map((item) => item.discordId)).toEqual([
      snowflake(MAX_MENTIONS_PER_MESSAGE),
      snowflake(MAX_MENTIONS_PER_MESSAGE + 1),
      snowflake(MAX_MENTIONS_PER_MESSAGE + 2),
    ]);
  });
});
