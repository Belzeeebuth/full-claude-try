import { EmbedBuilder, type Client } from 'discord.js';
import { balance as getBalance } from '../config';
import { COLORS } from '../framework/ui';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
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
/** Un lot à la fois : `setInterval` n'attend pas la fin du précédent. */
let inFlight = false;

/**
 * Identifiant du process, écrit dans `notifications.claimed_by`.
 * Sert au diagnostic (« quel shard a envoyé ce MP ? ») autant qu'à la
 * réservation elle-même.
 */
const WORKER_ID = `${process.env.SHARDS ?? 'mono'}#${process.pid}`.slice(0, 64);

export function startNotificationWorker(client: Client): void {
  const balance = getBalance();
  const rate = Math.max(1, balance.notifications.dispatchRatePerSecond);

  // Un tick par seconde, `rate` envois par tick : la cadence demandée est donc
  // respectée telle quelle. L'ancien calcul multipliait un intervalle déjà
  // planchonné à 250 ms par le débit, ce qui plafonnait silencieusement à 4/s
  // quelle que soit la valeur configurée.
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void dispatchBatch(client, rate)
      .catch((error: unknown) => log.error({ err: error }, 'distribution des notifications en échec'))
      .finally(() => {
        inFlight = false;
      });
  }, 1_000);

  log.info({ rate, worker: WORKER_ID }, 'worker de notifications démarré');
}

export async function dispatchBatch(client: Client, limit: number): Promise<number> {
  const balance = getBalance();
  const pending = await systemRepo.claimPendingNotifications(new Date(), limit, WORKER_ID);
  if (pending.length === 0) return 0;

  // Plafond quotidien : un seul comptage groupé pour tout le lot, au lieu d'une
  // requête par notification.
  const since = new Date(Date.now() - 86_400_000);
  const dailyCounts = await systemRepo.countNotificationsTodayFor(
    [...new Set(pending.map((entry) => entry.notification.userId))],
    since,
  );

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
        [
          'craft_done',
          'auction_sold',
          'auction_won',
          'auction_outbid',
          'trade_request',
          'coop_objective',
          'event_start',
          'admin_message',
        ].includes(notification.type);

      if (!allowed) {
        await systemRepo.markNotificationDelivered(notification.id);
        continue;
      }

      const todayCount = dailyCounts.get(notification.userId) ?? 0;
      if (todayCount >= balance.notifications.maxPerUserPerDay) {
        await systemRepo.markNotificationDelivered(notification.id);
        continue;
      }

      const t = translatorFor(settings.locale ?? DEFAULT_LOCALE);
      const payload = notification.payload as
        | { titleKey?: string; bodyKey?: string; params?: Record<string, string | number> }
        | undefined;
      const title = payload?.titleKey ? t(payload.titleKey, payload.params) : notification.title ?? t('notifications.default_title');
      const body = payload?.bodyKey ? t(payload.bodyKey, payload.params) : notification.body ?? '';

      const user = await client.users.fetch(entry.discordId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.primary)
            .setTitle(title)
            .setDescription(body)
            .setFooter({ text: t('notifications.footer') }),
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

      // La réservation est relâchée : l'échec peut être transitoire (coupure
      // réseau), et une notification réservée par un process mort resterait
      // sinon bloquée jusqu'à l'expiration du délai de péremption.
      await systemRepo.markNotificationFailed(notification.id, normalized.message);
      await systemRepo.releaseNotificationClaim(notification.id);
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
