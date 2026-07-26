import { EmbedBuilder, type Client } from 'discord.js';
import { balance as getBalance } from '../config';
import { COLORS } from '../framework/ui';
import * as playerRepo from '../repositories/player.repo';
import * as systemRepo from '../repositories/system.repo';
import { moduleLogger } from '../utils/logger';
import { toError } from '../utils/errors';

const log = moduleLogger('notifications');

/**
 * Distribution des notifications en messages privés.
 *
 * Trois contraintes gouvernent ce worker :
 *  1. RESPECT DU CHOIX DU JOUEUR — on relit ses paramètres au moment de l'envoi,
 *     pas au moment de la mise en file : un joueur qui désactive les alertes ne
 *     doit pas recevoir la file déjà constituée.
 *  2. RATE LIMIT DISCORD — les MP sont limités ; on envoie à un rythme fixe
 *     (`dispatchRatePerSecond`, 4/s par défaut) plutôt qu'en rafale.
 *  3. MP FERMÉS — l'erreur 50007 (« Cannot send messages to this user ») est
 *     définitive : on désactive alors ses notifications pour ne pas réessayer
 *     indéfiniment, et on le lui dira à sa prochaine commande.
 */

let timer: NodeJS.Timeout | undefined;

export function startNotificationWorker(client: Client): void {
  const balance = getBalance();
  const intervalMs = Math.max(250, Math.floor(1_000 / balance.notifications.dispatchRatePerSecond));

  timer = setInterval(() => {
    void dispatchBatch(client, balance.notifications.dispatchRatePerSecond).catch((error: unknown) =>
      log.error({ err: error }, 'distribution des notifications en échec'),
    );
  }, intervalMs * balance.notifications.dispatchRatePerSecond);

  log.info({ rate: balance.notifications.dispatchRatePerSecond }, 'worker de notifications démarré');
}

export async function dispatchBatch(client: Client, limit: number): Promise<number> {
  const balance = getBalance();
  const pending = await systemRepo.claimPendingNotifications(new Date(), limit);
  if (pending.length === 0) return 0;

  let sent = 0;
  for (const entry of pending) {
    const notification = entry.notification;

    try {
      const settings = await playerRepo.getSettings(notification.userId);
      if (!settings?.dmNotifications) {
        // Le joueur ne veut pas de MP : on marque comme livré pour vider la file.
        await systemRepo.markNotificationDelivered(notification.id);
        continue;
      }

      const allowed =
        (notification.type === 'crop_ready' && settings.notifyCrops) ||
        (notification.type === 'crop_withering' && settings.notifyCrops) ||
        (notification.type.startsWith('animal') && settings.notifyAnimals) ||
        (notification.type === 'energy_full' && settings.notifyEnergy) ||
        (notification.type === 'daily_reminder' && settings.dailyReminder) ||
        ['craft_done', 'auction_sold', 'auction_outbid', 'trade_request', 'coop_objective', 'event_start', 'admin_message'].includes(
          notification.type,
        );

      if (!allowed) {
        await systemRepo.markNotificationDelivered(notification.id);
        continue;
      }

      const today = new Date(Date.now() - 86_400_000);
      const todayCount = await systemRepo.countNotificationsToday(notification.userId, today);
      if (todayCount > balance.notifications.maxPerUserPerDay) {
        await systemRepo.markNotificationDelivered(notification.id);
        continue;
      }

      const user = await client.users.fetch(entry.discordId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.primary)
            .setTitle(notification.title ?? '🌾 Harvester')
            .setDescription(notification.body ?? '')
            .setFooter({ text: 'Manage your alerts with /settings' }),
        ],
      });

      await systemRepo.markNotificationDelivered(notification.id);
      sent += 1;
    } catch (error) {
      const normalized = toError(error);
      const code = (error as { code?: number }).code;

      if (code === 50007) {
        // MP fermés : on coupe définitivement les notifications de ce joueur.
        await playerRepo.updateSettings(notification.userId, { dmNotifications: false });
        await systemRepo.markNotificationDelivered(notification.id);
        log.debug({ userId: notification.userId }, 'MP fermés, notifications désactivées');
        continue;
      }

      await systemRepo.markNotificationFailed(notification.id, normalized.message);
      log.warn({ err: normalized, id: notification.id }, 'notification non délivrée');
    }
  }

  if (sent > 0) log.debug({ sent }, 'notifications envoyées');
  return sent;
}

export function stopNotificationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
