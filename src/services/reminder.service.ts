import * as systemRepo from '../repositories/system.repo';
import type { Translator } from '../types';

/**
 * Rappels groupés dans un salon de serveur (récoltes prêtes, animaux à
 * nourrir, énergie pleine…), à la place du message privé.
 *
 * Tout ce qui décide QUOI poster vit ici sous forme de fonctions pures —
 * regroupement par salon, plafond de mentions, mise en forme — pour être
 * testable sans Discord ni base (`tests/reminders.test.ts`). Le job
 * `notifications` ne fait qu'orchestrer : réserver en base, ouvrir la fenêtre
 * de lot, envoyer, marquer.
 *
 * Pourquoi autant de garde-fous : un bot qui mentionne trente personnes toutes
 * les dix minutes se fait expulser, et l'expulsion coupe le jeu à TOUS les
 * membres du serveur. D'où le double opt-in (le serveur désigne un salon, le
 * joueur accepte d'y être mentionné), UN message par salon et par lot, et au
 * plus vingt joueurs mentionnés par message — le reste attend le lot suivant.
 */

/**
 * Famille « rappel » : les seuls types livrables en salon, dans l'ordre
 * d'affichage (urgence décroissante). Tout le reste — enchères, échanges,
 * coopérative, messages d'administration — reste en message privé : ce sont
 * des informations personnelles, pas des rappels qu'un voisin peut lire.
 */
export const REMINDER_TYPES = [
  'crop_ready',
  'crop_withering',
  'animal_hungry',
  'animal_sick',
  'animal_product',
  'energy_full',
  'daily_reminder',
  'craft_done',
] as const;

export type ReminderType = (typeof REMINDER_TYPES)[number];

export function isReminderType(type: string): type is ReminderType {
  return (REMINDER_TYPES as readonly string[]).includes(type);
}

/** Au-delà, un message de rappel devient un mur de mentions : on scinde en lots. */
export const MAX_MENTIONS_PER_MESSAGE = 20;

const TYPE_EMOJI: Record<ReminderType, string> = {
  crop_ready: '🌾',
  crop_withering: '🥀',
  animal_hungry: '🐄',
  animal_sick: '🤒',
  animal_product: '🥚',
  energy_full: '⚡',
  daily_reminder: '📅',
  craft_done: '🔨',
};

/** Réglages fins du joueur, les mêmes que ceux qui filtrent les MP. */
export interface ReminderPreferences {
  notifyCrops: boolean;
  notifyAnimals: boolean;
  notifyEnergy: boolean;
  dailyReminder: boolean;
}

/**
 * Le salon remplace le MP, il ne contourne pas les préférences : un joueur qui
 * a coupé les alertes d'animaux ne doit pas être mentionné pour une vache
 * affamée. Même grille que le chemin MP de `dispatchBatch`.
 */
export function reminderAllowed(type: ReminderType, prefs: ReminderPreferences): boolean {
  switch (type) {
    case 'crop_ready':
    case 'crop_withering':
      return prefs.notifyCrops;
    case 'animal_hungry':
    case 'animal_sick':
    case 'animal_product':
      return prefs.notifyAnimals;
    case 'energy_full':
      return prefs.notifyEnergy;
    case 'daily_reminder':
      return prefs.dailyReminder;
    case 'craft_done':
      return true;
  }
}

/** Un rappel réservé en base, prêt à être regroupé. */
export interface ReminderEntry {
  /** `notifications.id`, pour marquer livré ou reporter. */
  id: number;
  type: ReminderType;
  discordId: string;
  guildId: string;
  channelId: string;
  /** Langue du SERVEUR : le message est lu par plusieurs joueurs. */
  locale: string;
  batchMinutes: number;
}

export interface ReminderGroup {
  guildId: string;
  channelId: string;
  locale: string;
  batchMinutes: number;
  entries: ReminderEntry[];
}

/**
 * Regroupe par salon, dans l'ordre de première apparition (donc par ancienneté
 * de rappel, la réservation étant triée par `deliver_at`). La langue et
 * l'espacement sont ceux du serveur : identiques pour tout le groupe, on les
 * lit sur la première entrée.
 */
export function groupByChannel(entries: readonly ReminderEntry[]): ReminderGroup[] {
  const groups = new Map<string, ReminderGroup>();
  for (const entry of entries) {
    const key = `${entry.guildId}:${entry.channelId}`;
    const group = groups.get(key);
    if (group) {
      group.entries.push(entry);
    } else {
      groups.set(key, {
        guildId: entry.guildId,
        channelId: entry.channelId,
        locale: entry.locale,
        batchMinutes: entry.batchMinutes,
        entries: [entry],
      });
    }
  }
  return [...groups.values()];
}

export interface ReminderMessage {
  content: string;
  /**
   * Seuls identifiants autorisés dans `allowedMentions.users`. Discord ne fait
   * sonner que ceux-là, quoi que contienne le texte : c'est la garantie qu'un
   * joueur non concerné n'est jamais notifié.
   */
  mentionIds: string[];
  /** Rappels couverts par ce message, à marquer livrés après l'envoi. */
  notificationIds: number[];
}

export interface ReminderPlan {
  /** `null` si aucune entrée n'a pu être retenue. */
  message: ReminderMessage | null;
  /** Rappels reportés au lot suivant (plafond de mentions atteint). */
  deferred: ReminderEntry[];
}

/**
 * Compose UN message pour un salon, en respectant le plafond de joueurs
 * mentionnés.
 *
 * Le plafond compte des PERSONNES, pas des lignes : un joueur retenu emporte
 * tous ses rappels (récolte + animal) dans le même message, même s'ils
 * arrivent après que le plafond est atteint. Le découper en deux messages à
 * dix minutes d'écart serait exactement le harcèlement qu'on cherche à éviter.
 * Un joueur apparaît au plus une fois par type, même avec trois parcelles
 * prêtes.
 */
export function planReminderMessage(
  entries: readonly ReminderEntry[],
  t: Translator,
  maxMentions = MAX_MENTIONS_PER_MESSAGE,
): ReminderPlan {
  const included = new Set<string>();
  const kept: ReminderEntry[] = [];
  const deferred: ReminderEntry[] = [];

  for (const entry of entries) {
    if (included.has(entry.discordId) || included.size < maxMentions) {
      included.add(entry.discordId);
      kept.push(entry);
    } else {
      deferred.push(entry);
    }
  }

  if (kept.length === 0) return { message: null, deferred };

  const byType = new Map<ReminderType, string[]>();
  for (const entry of kept) {
    const ids = byType.get(entry.type) ?? [];
    if (!ids.includes(entry.discordId)) ids.push(entry.discordId);
    byType.set(entry.type, ids);
  }

  // L'ordre d'affichage est celui de REMINDER_TYPES, pas celui d'arrivée : le
  // lecteur retrouve toujours les récoltes en tête, les fabrications en queue.
  const segments = REMINDER_TYPES.flatMap((type) => {
    const ids = byType.get(type);
    if (!ids) return [];
    return [
      t('reminders.segment', {
        emoji: TYPE_EMOJI[type],
        label: t(`reminders.types.${type}`),
        mentions: ids.map((id) => `<@${id}>`).join(' '),
      }),
    ];
  });

  const content = [t('reminders.header'), segments.join(t('reminders.separator')), t('reminders.footer')]
    .join('\n');

  return {
    message: {
      content,
      mentionIds: [...included],
      notificationIds: kept.map((entry) => entry.id),
    },
    deferred,
  };
}

// ---------------------------------------------------------------------------
// Configuration côté serveur (`/server reminders`)
// ---------------------------------------------------------------------------

export interface GuildIdentity {
  name: string;
  memberCount: number;
  locale: string;
}

export interface ReminderActor {
  userId: string;
  discordId: string;
}

/**
 * Active (ou déplace) le salon des rappels d'un serveur. La vérification que
 * le bot PEUT écrire dans le salon appartient à la commande : elle seule voit
 * discord.js. Ici on persiste et on trace — un salon qui se met à mentionner
 * des gens doit pouvoir être relié à l'administrateur qui l'a choisi.
 */
export async function enableReminderChannel(
  guildId: string,
  guild: GuildIdentity,
  channelId: string,
  batchMinutes: number | undefined,
  actor: ReminderActor,
): Promise<{ channelId: string; batchMinutes: number }> {
  // `ensure` plutôt que `update` : un serveur qui a invité le bot avant la
  // création de la table n'a pas de ligne, et un UPDATE muet aurait laissé
  // l'administrateur croire que c'était réglé.
  const current = await systemRepo.ensureGuildSettings(guildId, guild);
  const minutes = batchMinutes ?? current.reminderBatchMinutes;
  await systemRepo.updateGuildSettings(guildId, {
    reminderChannelId: channelId,
    reminderBatchMinutes: minutes,
  });
  await systemRepo.audit({
    actorId: actor.userId,
    actorDiscordId: actor.discordId,
    action: 'server.reminders.enable',
    targetType: 'guild',
    targetId: guildId,
    discordGuildId: guildId,
    payload: { channelId, batchMinutes: minutes, previousChannelId: current.reminderChannelId },
  });
  return { channelId, batchMinutes: minutes };
}

export async function disableReminderChannel(
  guildId: string,
  guild: GuildIdentity,
  actor: ReminderActor,
): Promise<void> {
  const current = await systemRepo.ensureGuildSettings(guildId, guild);
  await systemRepo.updateGuildSettings(guildId, { reminderChannelId: null });
  await systemRepo.audit({
    actorId: actor.userId,
    actorDiscordId: actor.discordId,
    action: 'server.reminders.disable',
    targetType: 'guild',
    targetId: guildId,
    discordGuildId: guildId,
    payload: { previousChannelId: current.reminderChannelId },
  });
}

/** Un salon de rappels est-il configuré sur ce serveur ? (affiché par `/settings`) */
export async function hasReminderChannel(guildId: string): Promise<boolean> {
  const row = await systemRepo.getGuildSettings(guildId);
  return Boolean(row?.reminderChannelId) && row?.leftAt === null;
}
