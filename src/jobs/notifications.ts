import { EmbedBuilder, type Client } from 'discord.js';
import { balance as getBalance } from '../config';
import { env } from '../config/env';
import { getRedis, key as redisKey } from '../db/redis';
import { COLORS } from '../framework/ui';
import { translatorFor, DEFAULT_LOCALE } from '../i18n';
import * as playerRepo from '../repositories/player.repo';
import * as systemRepo from '../repositories/system.repo';
import {
  REMINDER_TYPES,
  groupByChannel,
  isReminderType,
  planReminderMessage,
  reminderAllowed,
  type ReminderEntry,
  type ReminderGroup,
} from '../services/reminder.service';
import { moduleLogger } from '../utils/logger';
import { toError } from '../utils/errors';

const log = moduleLogger('notifications');

/**
 * Distribution des notifications : en message privé, ou — pour la famille
 * « rappel » et sur double opt-in — groupées dans un salon du serveur.
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
 *
 * Les rappels en salon existent précisément à cause du point 3 : beaucoup de
 * joueurs ferment leurs MP, et la fonctionnalité était muette pour eux. Mais
 * un bot qui mentionne trente personnes toutes les dix minutes se fait
 * expulser — d'où un message par salon et par lot, jamais un par joueur.
 */

let timer: NodeJS.Timeout | undefined;
/** Un lot à la fois : `setInterval` n'attend pas la fin du précédent. */
let inFlight = false;

/**
 * Identifiant du process, écrit dans `notifications.claimed_by`.
 * Sert au diagnostic (« quel shard a envoyé ce MP ? ») autant qu'à la
 * réservation elle-même.
 */
const WORKER_ID = `${env.SHARDS ?? 'mono'}#${process.pid}`.slice(0, 64);

/**
 * Rappels réservés par passage pour les salons. Bien plus que le débit des MP :
 * un salon reçoit UN message par lot, qui doit contenir tout ce qui attend.
 * Dix salons pleins (20 mentions chacun) tiennent dans un seul passage.
 */
const CHANNEL_CLAIM_LIMIT = 200;

/**
 * Codes Discord qui signifient « ce salon ne recevra plus jamais rien » :
 * salon supprimé (10003), accès retiré (50001), permissions retirées (50013).
 * Réessayer serait inutile ; on retire le salon de la configuration, et les
 * rappels retombent d'eux-mêmes sur le chemin MP au tick suivant.
 */
const CHANNEL_GONE_CODES = new Set([10003, 50001, 50013]);

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
      .then(() => dispatchChannelReminders(client))
      .catch((error: unknown) => log.error({ err: error }, 'distribution des notifications en échec'))
      .finally(() => {
        inFlight = false;
      });
  }, 1_000);

  log.info({ rate, worker: WORKER_ID }, 'worker de notifications démarré');
}

export async function dispatchBatch(client: Client, limit: number): Promise<number> {
  const balance = getBalance();
  // Les rappels routés vers un salon sont laissés à `dispatchChannelReminders`.
  const pending = await systemRepo.claimPendingNotifications(
    new Date(),
    limit,
    WORKER_ID,
    REMINDER_TYPES,
  );
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
        // `price_alert` est comparé comme chaîne : le type SQL est créé par une
        // autre migration, et ce code doit compiler même si l'enum TypeScript
        // ne porte pas encore la valeur.
        (notification.type === 'price_alert' && settings.notifyMarket) ||
        [
          'craft_done',
          'auction_sold',
          'auction_won',
          'auction_outbid',
          'trade_request',
          'coop_objective',
          'event_start',
          'admin_message',
          'order_filled',
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

// ---------------------------------------------------------------------------
// Rappels groupés en salon
// ---------------------------------------------------------------------------

/**
 * Distribue les rappels routés vers un salon : réservation groupée, filtrage
 * (préférences, plafond quotidien), puis UN message par salon.
 *
 * Renvoie le nombre de messages postés. La logique de regroupement et de mise
 * en forme est dans `reminder.service` ; ici on n'enchaîne que les effets.
 */
export async function dispatchChannelReminders(client: Client, now = new Date()): Promise<number> {
  const balance = getBalance();
  const claimed = await systemRepo.claimPendingChannelReminders(
    now,
    CHANNEL_CLAIM_LIMIT,
    WORKER_ID,
    REMINDER_TYPES,
  );
  if (claimed.length === 0) return 0;

  // Même plafond quotidien qu'en MP : le salon change le canal, pas le contrat.
  const since = new Date(now.getTime() - 86_400_000);
  const dailyCounts = await systemRepo.countNotificationsTodayFor(
    [...new Set(claimed.map((entry) => entry.notification.userId))],
    since,
  );

  const dropped: number[] = [];
  const entries: ReminderEntry[] = [];
  for (const entry of claimed) {
    const { id, type, userId } = entry.notification;
    const overCap = (dailyCounts.get(userId) ?? 0) >= balance.notifications.maxPerUserPerDay;
    if (!isReminderType(type) || !reminderAllowed(type, entry.preferences) || overCap) {
      // Comme en MP : un rappel refusé est marqué livré pour vider la file.
      dropped.push(id);
      continue;
    }
    entries.push({
      id,
      type,
      discordId: entry.discordId,
      guildId: entry.guildId,
      channelId: entry.channelId,
      locale: entry.guildLocale,
      batchMinutes: entry.batchMinutes,
    });
  }
  await systemRepo.markNotificationsDelivered(dropped);

  let posted = 0;
  for (const group of groupByChannel(entries)) {
    posted += await postReminderGroup(client, group, now);
  }
  if (posted > 0) log.debug({ posted }, 'rappels postés en salon');
  return posted;
}

async function postReminderGroup(client: Client, group: ReminderGroup, now: Date): Promise<number> {
  const ids = group.entries.map((entry) => entry.id);

  let window: ReminderWindow;
  try {
    window = await openReminderWindow(group.channelId, group.batchMinutes, now);
  } catch (error) {
    // Redis injoignable : sans fenêtre, impossible de garantir « un message par
    // lot ». On rend le lot plutôt que de poster à l'aveugle, et on réessaie
    // au tick suivant — les réservations ne restent pas bloquées cinq minutes.
    await systemRepo.releaseNotificationClaims(ids);
    log.warn({ err: error, channelId: group.channelId }, 'fenêtre de rappel indisponible');
    return 0;
  }
  if (!window.opened) {
    // Le salon a reçu un message il y a moins de `batchMinutes` : tout le lot
    // est reporté à la réouverture, où il sera réservé d'un bloc avec ce qui
    // arrive entre-temps — c'est ce qui fait qu'un message en contient vingt
    // et non un seul.
    await systemRepo.postponeNotifications(ids, window.reopensAt);
    return 0;
  }

  const plan = planReminderMessage(group.entries, translatorFor(group.locale));
  if (!plan.message) {
    await systemRepo.releaseNotificationClaims(ids);
    return 0;
  }
  const { message, deferred } = plan;

  try {
    const channel = await client.channels.fetch(group.channelId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw Object.assign(new Error('reminder channel is not a text channel'), { code: 10003 });
    }

    await channel.send({
      content: message.content,
      // Seuls les joueurs concernés sonnent, quoi que contienne le texte —
      // et `parse: []` interdit tout @everyone/@here, même injecté.
      allowedMentions: { users: message.mentionIds, parse: [] },
    });

    await systemRepo.markNotificationsDelivered(message.notificationIds);
    if (deferred.length > 0) {
      // Au-delà du plafond de mentions : le reste attend le lot suivant.
      await systemRepo.postponeNotifications(
        deferred.map((entry) => entry.id),
        new Date(now.getTime() + group.batchMinutes * 60_000),
      );
    }
    return 1;
  } catch (error) {
    const normalized = toError(error);
    const code = (error as { code?: number }).code;

    // La fenêtre a été ouverte pour rien : on la referme pour ne pas faire
    // attendre le lot suivant dix minutes après un échec.
    await closeReminderWindow(group.channelId);

    if (code !== undefined && CHANNEL_GONE_CODES.has(code)) {
      // Salon supprimé ou permissions retirées : on désactive le salon. Les
      // rappels libérés cessent de remplir la condition « routé vers un
      // salon » et repartent en MP au tick suivant, sans autre intervention.
      await systemRepo.updateGuildSettings(group.guildId, { reminderChannelId: null });
      await systemRepo.releaseNotificationClaims(ids);
      log.warn(
        { guildId: group.guildId, channelId: group.channelId, code },
        'salon de rappels inaccessible, désactivé',
      );
      return 0;
    }

    // Échec transitoire (coupure réseau, 5xx) : une minute de recul avant de
    // réessayer. Relâcher immédiatement, comme pour un MP, ferait consommer les
    // quatre tentatives du lot en quatre secondes sur une simple coupure.
    await systemRepo.markNotificationsFailed(ids, normalized.message);
    await systemRepo.postponeNotifications(ids, new Date(now.getTime() + 60_000));
    log.warn({ err: normalized, channelId: group.channelId }, 'rappels en salon non délivrés');
    return 0;
  }
}

type ReminderWindow = { opened: true } | { opened: false; reopensAt: Date };

/**
 * Fenêtre « un message par salon et par lot », partagée entre shards via
 * `SET NX PX` : le premier passage qui l'ouvre poste, les autres reportent.
 * La clé porte sur le salon, pas le serveur — deux serveurs ne partagent
 * jamais un salon, et c'est le salon que Discord surveille.
 */
async function openReminderWindow(channelId: string, minutes: number, now: Date): Promise<ReminderWindow> {
  const ttlMs = Math.max(1, minutes) * 60_000;
  const cacheKey = redisKey('reminders', 'window', channelId);
  const redis = getRedis();

  const result = await redis.set(cacheKey, String(now.getTime()), 'PX', ttlMs, 'NX');
  if (result === 'OK') return { opened: true };

  const remaining = await redis.pttl(cacheKey);
  // Une clé expirée entre les deux commandes (PTTL négatif) : on réessaie au
  // tick suivant plutôt que de reporter d'une fenêtre entière.
  return { opened: false, reopensAt: new Date(now.getTime() + Math.max(remaining, 1_000)) };
}

async function closeReminderWindow(channelId: string): Promise<void> {
  try {
    await getRedis().del(redisKey('reminders', 'window', channelId));
  } catch (error) {
    log.debug({ err: error, channelId }, 'fenêtre de rappel non refermée');
  }
}

export function stopNotificationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
