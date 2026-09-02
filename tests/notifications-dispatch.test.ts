import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

/**
 * Distribution des notifications — les deux décisions que le job prend SEUL,
 * et qu'aucun test ne couvrait :
 *
 *  1. QUI a le droit de recevoir un message privé (`dispatchBatch`), et en
 *     particulier les alertes de prix : elles sont un opt-in unitaire du
 *     joueur, pas un réglage de famille.
 *  2. QUAND le salon de rappels d'un serveur peut être effacé
 *     (`dispatchChannelReminders`) : jamais celui qu'un administrateur vient
 *     de reconfigurer pendant que le lot était en vol.
 *
 * Base, Redis et Discord sont remplacés par des doubles : ce qui est testé ici
 * est l'enchaînement des décisions, pas le SQL (couvert par les tests
 * d'intégration).
 */

vi.mock('../src/repositories/system.repo', () => ({
  claimPendingNotifications: vi.fn(),
  countNotificationsTodayFor: vi.fn(),
  markNotificationDelivered: vi.fn(),
  markNotificationFailed: vi.fn(),
  releaseNotificationClaim: vi.fn(),
  claimPendingChannelReminders: vi.fn(),
  markNotificationsDelivered: vi.fn(),
  markNotificationsFailed: vi.fn(),
  releaseNotificationClaims: vi.fn(),
  postponeNotifications: vi.fn(),
  getGuildSettings: vi.fn(),
  updateGuildSettings: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../src/repositories/player.repo', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../src/db/redis', () => ({
  getRedis: vi.fn(),
  key: (...parts: string[]) => parts.join(':'),
}));

import { getRedis } from '../src/db/redis';
import * as playerRepo from '../src/repositories/player.repo';
import * as systemRepo from '../src/repositories/system.repo';
import { dispatchBatch, dispatchChannelReminders } from '../src/jobs/notifications';

/** Réglages par défaut d'un joueur, tels que les pose la migration initiale. */
function defaultSettings(overrides: Record<string, unknown> = {}) {
  return {
    dmNotifications: false,
    notifyCrops: true,
    notifyAnimals: true,
    notifyEnergy: false,
    notifyMarket: false,
    notifyCoop: true,
    dailyReminder: false,
    channelReminders: false,
    locale: 'fr',
    ...overrides,
  } as never;
}

function fakeDmClient(): { client: Client; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  const client = { users: { fetch: vi.fn().mockResolvedValue({ send }) } } as unknown as Client;
  return { client, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(systemRepo.claimPendingNotifications).mockResolvedValue([]);
  vi.mocked(systemRepo.claimPendingChannelReminders).mockResolvedValue([]);
  vi.mocked(systemRepo.countNotificationsTodayFor).mockResolvedValue(new Map());
  vi.mocked(getRedis).mockReturnValue({
    set: vi.fn().mockResolvedValue('OK'),
    pttl: vi.fn().mockResolvedValue(60_000),
    del: vi.fn().mockResolvedValue(1),
  } as never);
});

describe('messages privés — alertes de prix', () => {
  const alert = {
    notification: {
      id: 42,
      userId: 'u1',
      type: 'price_alert',
      title: 'Blé à 12',
      body: 'Le seuil est franchi.',
      payload: null,
    },
    discordId: '1',
    locale: 'fr',
  };

  it('envoie une alerte déclenchée avec les réglages par défaut', async () => {
    // Régression : `notify_market` vaut `false` par défaut et n'est exposé par
    // aucune commande ni aucun bouton. Le filtrer marquait l'alerte « livrée »
    // sans rien envoyer, alors que `/alert create` avait promis un MP et que
    // l'alerte, consommée, disparaissait de `/alert list`.
    vi.mocked(systemRepo.claimPendingNotifications).mockResolvedValue([alert] as never);
    vi.mocked(playerRepo.getSettings).mockResolvedValue(defaultSettings({ dmNotifications: true }));
    const { client, send } = fakeDmClient();

    expect(await dispatchBatch(client, 5)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(systemRepo.markNotificationDelivered).toHaveBeenCalledWith(42);
  });

  it('respecte malgré tout le refus global des messages privés', async () => {
    vi.mocked(systemRepo.claimPendingNotifications).mockResolvedValue([alert] as never);
    vi.mocked(playerRepo.getSettings).mockResolvedValue(defaultSettings({ dmNotifications: false }));
    const { client, send } = fakeDmClient();

    expect(await dispatchBatch(client, 5)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(systemRepo.markNotificationDelivered).toHaveBeenCalledWith(42);
  });

  it('continue de filtrer les familles réglables : énergie coupée, récoltes gardées', async () => {
    vi.mocked(systemRepo.claimPendingNotifications).mockResolvedValue([
      { ...alert, notification: { ...alert.notification, id: 7, type: 'energy_full' } },
      { ...alert, notification: { ...alert.notification, id: 8, type: 'crop_ready' } },
    ] as never);
    vi.mocked(playerRepo.getSettings).mockResolvedValue(
      defaultSettings({ dmNotifications: true, notifyEnergy: false, notifyCrops: true }),
    );
    const { client, send } = fakeDmClient();

    expect(await dispatchBatch(client, 5)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(systemRepo.markNotificationDelivered).toHaveBeenCalledWith(7);
  });
});

describe('rappels en salon — salon devenu inaccessible', () => {
  const OLD_CHANNEL = '111111111111111111';
  const NEW_CHANNEL = '222222222222222222';

  function claimedReminder() {
    return [
      {
        notification: { id: 1, userId: 'u1', type: 'crop_ready' },
        discordId: '1',
        guildId: 'g1',
        channelId: OLD_CHANNEL,
        batchMinutes: 10,
        guildLocale: 'fr',
        preferences: {
          notifyCrops: true,
          notifyAnimals: true,
          notifyEnergy: true,
          dailyReminder: true,
        },
      },
    ];
  }

  /** Salon supprimé : `channel.send` échoue avec 10003. */
  function goneChannelClient(): Client {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Channel'), { code: 10003 }));
    return {
      channels: {
        fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send }),
      },
    } as unknown as Client;
  }

  beforeEach(() => {
    vi.mocked(systemRepo.claimPendingChannelReminders).mockResolvedValue(claimedReminder());
  });

  it('désactive le salon quand la configuration porte encore celui du lot', async () => {
    vi.mocked(systemRepo.getGuildSettings).mockResolvedValue({
      reminderChannelId: OLD_CHANNEL,
    } as never);

    expect(await dispatchChannelReminders(goneChannelClient())).toBe(0);
    expect(systemRepo.updateGuildSettings).toHaveBeenCalledWith('g1', { reminderChannelId: null });
    // La désactivation automatique laisse une trace : sinon `/audit` montre des
    // rappels actifs alors qu'ils sont muets.
    expect(systemRepo.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'server.reminders.auto_disable', targetId: 'g1' }),
    );
    expect(systemRepo.releaseNotificationClaims).toHaveBeenCalledWith([1]);
  });

  it("n'efface pas un salon reconfiguré pendant que le lot était en vol", async () => {
    // L'administrateur a exécuté `/server reminders channel:#nouveau` entre la
    // réservation du lot (#ancien) et l'échec d'envoi : effacer sans condition
    // lui rendait « désactivé » juste après un « activé » confirmé.
    vi.mocked(systemRepo.getGuildSettings).mockResolvedValue({
      reminderChannelId: NEW_CHANNEL,
    } as never);

    expect(await dispatchChannelReminders(goneChannelClient())).toBe(0);
    expect(systemRepo.updateGuildSettings).not.toHaveBeenCalled();
    expect(systemRepo.audit).not.toHaveBeenCalled();
    // Les rappels repartent quand même : libérés, ils suivront le nouveau salon.
    expect(systemRepo.releaseNotificationClaims).toHaveBeenCalledWith([1]);
  });
});
