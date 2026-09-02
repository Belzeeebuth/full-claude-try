import { describe, expect, it } from 'vitest';
import { translatorFor } from '../src/i18n';
import {
  MAX_MENTIONS_PER_MESSAGE,
  REMINDER_TYPES,
  groupByChannel,
  isReminderType,
  planReminderMessage,
  reminderAllowed,
  type ReminderEntry,
  type ReminderType,
} from '../src/services/reminder.service';

/**
 * Rappels groupés dans un salon : toute la logique de regroupement et de mise
 * en forme est pure, donc testée ici sans Discord, sans base et sans Redis.
 * Le job ne fait qu'enchaîner réservation → plan → envoi → marquage.
 */

let nextId = 1;

function entry(
  discordId: string,
  type: ReminderType = 'crop_ready',
  overrides: Partial<ReminderEntry> = {},
): ReminderEntry {
  return {
    id: nextId++,
    type,
    discordId,
    guildId: 'g1',
    channelId: 'c1',
    locale: 'fr',
    batchMinutes: 10,
    ...overrides,
  };
}

const fr = translatorFor('fr');
const en = translatorFor('en');

describe('famille « rappel »', () => {
  it('reconnaît exactement les huit types livrables en salon', () => {
    expect(REMINDER_TYPES).toHaveLength(8);
    for (const type of REMINDER_TYPES) expect(isReminderType(type)).toBe(true);
    // Les informations personnelles restent en message privé.
    for (const type of ['auction_sold', 'trade_request', 'coop_objective', 'admin_message', 'price_alert']) {
      expect(isReminderType(type)).toBe(false);
    }
  });

  it('respecte les préférences fines du joueur, comme le chemin MP', () => {
    const all = { notifyCrops: true, notifyAnimals: true, notifyEnergy: true, dailyReminder: true };
    const none = { notifyCrops: false, notifyAnimals: false, notifyEnergy: false, dailyReminder: false };

    for (const type of REMINDER_TYPES) expect(reminderAllowed(type, all)).toBe(true);

    expect(reminderAllowed('crop_ready', none)).toBe(false);
    expect(reminderAllowed('crop_withering', none)).toBe(false);
    expect(reminderAllowed('animal_hungry', none)).toBe(false);
    expect(reminderAllowed('animal_sick', none)).toBe(false);
    expect(reminderAllowed('animal_product', none)).toBe(false);
    expect(reminderAllowed('energy_full', none)).toBe(false);
    expect(reminderAllowed('daily_reminder', none)).toBe(false);
    // Une fabrication terminée n'a pas de réglage dédié : toujours livrée.
    expect(reminderAllowed('craft_done', none)).toBe(true);

    expect(reminderAllowed('animal_hungry', { ...none, notifyAnimals: true })).toBe(true);
    expect(reminderAllowed('crop_ready', { ...none, notifyAnimals: true })).toBe(false);
  });
});

describe('regroupement par salon', () => {
  it('fait un groupe par (serveur, salon), dans l\'ordre de première apparition', () => {
    const entries = [
      entry('a'),
      entry('b', 'animal_hungry', { guildId: 'g2', channelId: 'c2', locale: 'en', batchMinutes: 30 }),
      entry('c', 'energy_full'),
      entry('d', 'crop_ready', { guildId: 'g2', channelId: 'c2', locale: 'en', batchMinutes: 30 }),
    ];

    const groups = groupByChannel(entries);

    expect(groups.map((group) => group.channelId)).toEqual(['c1', 'c2']);
    expect(groups[0]).toMatchObject({ guildId: 'g1', locale: 'fr', batchMinutes: 10 });
    expect(groups[0]?.entries.map((e) => e.discordId)).toEqual(['a', 'c']);
    expect(groups[1]).toMatchObject({ guildId: 'g2', locale: 'en', batchMinutes: 30 });
    expect(groups[1]?.entries.map((e) => e.discordId)).toEqual(['b', 'd']);
  });

  it('distingue deux serveurs qui auraient le même identifiant de salon', () => {
    const groups = groupByChannel([entry('a'), entry('b', 'crop_ready', { guildId: 'g2' })]);
    expect(groups).toHaveLength(2);
  });

  it('ne produit rien sans entrée', () => {
    expect(groupByChannel([])).toEqual([]);
  });
});

describe('composition du message', () => {
  it('regroupe par type, dans l\'ordre fixe des types, une mention par joueur et par type', () => {
    const entries = [
      entry('3', 'animal_hungry'),
      entry('1', 'crop_ready'),
      entry('1', 'crop_ready'), // trois parcelles prêtes = une seule mention
      entry('2', 'crop_ready'),
      entry('1', 'crop_ready'),
    ];

    const plan = planReminderMessage(entries, fr);

    expect(plan.deferred).toEqual([]);
    expect(plan.message).not.toBeNull();
    expect(plan.message?.content).toContain('🌾 Récoltes prêtes : <@1> <@2> · 🐄 À nourrir : <@3>');
    expect(plan.message?.mentionIds).toEqual(['3', '1', '2']);
    expect(plan.message?.notificationIds).toEqual(entries.map((e) => e.id));
  });

  it('formate en anglais avec la ponctuation anglaise', () => {
    const plan = planReminderMessage([entry('1', 'crop_ready'), entry('2', 'animal_hungry')], en);
    expect(plan.message?.content).toContain('🌾 Crops ready: <@1> · 🐄 Animals to feed: <@2>');
    expect(plan.message?.content).toContain('/settings channel-reminders:false');
  });

  it('n\'autorise à sonner que les joueurs concernés, jamais @everyone', () => {
    const plan = planReminderMessage([entry('1'), entry('2', 'craft_done')], fr);
    const mentioned = [...(plan.message?.content.matchAll(/<@(\d+)>/g) ?? [])].map((m) => m[1]);
    expect(new Set(mentioned)).toEqual(new Set(plan.message?.mentionIds));
    expect(plan.message?.content).not.toContain('@everyone');
    expect(plan.message?.content).not.toContain('@here');
  });

  it('plafonne à 20 joueurs par message et reporte le reste', () => {
    const entries = Array.from({ length: 25 }, (_, index) => entry(`u${index + 1}`));

    const plan = planReminderMessage(entries, fr);

    expect(plan.message?.mentionIds).toHaveLength(MAX_MENTIONS_PER_MESSAGE);
    expect(plan.message?.mentionIds).toEqual(entries.slice(0, 20).map((e) => e.discordId));
    expect(plan.message?.notificationIds).toEqual(entries.slice(0, 20).map((e) => e.id));
    expect(plan.deferred.map((e) => e.discordId)).toEqual(['u21', 'u22', 'u23', 'u24', 'u25']);
  });

  it('emporte TOUS les rappels d\'un joueur retenu, même au-delà du plafond', () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(`u${index + 1}`));
    // Arrivés après le plafond : u1 est déjà retenu (il reste avec ses vaches),
    // u99 ne l'est pas (il attend le lot suivant).
    entries.push(entry('u1', 'animal_hungry'), entry('u99', 'animal_hungry'));

    const plan = planReminderMessage(entries, fr);

    expect(plan.message?.mentionIds).toHaveLength(20);
    expect(plan.message?.content).toContain('🐄 À nourrir : <@u1>');
    expect(plan.deferred.map((e) => e.discordId)).toEqual(['u99']);
  });

  it('respecte un plafond personnalisé', () => {
    const plan = planReminderMessage([entry('a'), entry('b'), entry('c')], fr, 2);
    expect(plan.message?.mentionIds).toEqual(['a', 'b']);
    expect(plan.deferred.map((e) => e.discordId)).toEqual(['c']);
  });

  it('tient dans la limite de 2 000 caractères de Discord au pire cas', () => {
    const entries: ReminderEntry[] = [];
    for (let index = 0; index < MAX_MENTIONS_PER_MESSAGE; index += 1) {
      for (const type of REMINDER_TYPES) entries.push(entry(`${100000000000000000 + index}`, type));
    }
    const plan = planReminderMessage(entries, fr);
    expect(plan.deferred).toEqual([]);
    expect(plan.message?.content.length ?? 0).toBeLessThanOrEqual(2_000);
  });

  it('ne compose rien sans entrée', () => {
    expect(planReminderMessage([], fr)).toEqual({ message: null, deferred: [] });
  });
});
