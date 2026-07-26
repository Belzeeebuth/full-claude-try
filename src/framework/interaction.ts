import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { balance as getBalance, getConfig } from '../config';
import { env } from '../config/env';
import { translatorFor, normalizeLocale } from '../i18n';
import { ensurePlayer } from '../services/player.service';
import { getMaintenance } from '../services/misc.service';
import { CooldownError, GameError, MaintenanceError, isGameError, toError } from '../utils/errors';
import { LockBusyError } from '../utils/lock';
import { NotOwnerError } from '../utils/custom-id';
import { moduleLogger } from '../utils/logger';
import { discordTimestamp, formatDuration } from '../utils/format';
import { COLORS, baseEmbed, errorEmbed, suggestionRow, warningEmbed } from './ui';
import type { CommandContext, PlayerContext } from '../types';

const log = moduleLogger('interaction');

/**
 * Construction du contexte et gestion centralisée des erreurs.
 *
 * Toute interaction passe par ici. C'est le seul endroit qui sait :
 *  - créer/charger le joueur,
 *  - vérifier maintenance, bannissement économique et limitation de débit,
 *  - transformer une exception en message utilisateur compréhensible,
 *  - décider si l'incident mérite un rapport dans le salon d'erreurs.
 */

export interface BuildContextOptions {
  createIfMissing?: boolean;
  requiresAccount?: boolean;
  referralCode?: string;
}

export async function buildContext(
  interaction: Interaction,
  options: BuildContextOptions = {},
): Promise<CommandContext | null> {
  const maintenance = getMaintenance();
  if (maintenance.enabled && !env.BOT_OWNER_IDS.includes(interaction.user.id)) {
    throw new MaintenanceError(maintenance.message);
  }

  const result = await ensurePlayer({
    discordId: interaction.user.id,
    username: interaction.user.username,
    displayName: interaction.user.displayName ?? undefined,
    avatarHash: interaction.user.avatar ?? undefined,
    discordLocale: interaction.locale,
    discordGuildId: interaction.guildId ?? undefined,
    createIfMissing: options.createIfMissing ?? false,
    referralCode: options.referralCode,
  });

  if (!result) {
    if (options.requiresAccount === false) {
      // Contexte « invité » : suffisant pour /help, /crops, /encyclopedia.
      return guestContext(interaction);
    }
    return null;
  }

  const locale = normalizeLocale(result.player.locale);
  return {
    player: result.player,
    config: getConfig(),
    balance: getBalance(),
    discordGuildId: interaction.guildId ?? undefined,
    locale,
    t: translatorFor(locale),
    now: new Date(),
  };
}

function guestContext(interaction: Interaction): CommandContext {
  const locale = normalizeLocale(interaction.locale);
  const guest: PlayerContext = {
    id: '00000000-0000-0000-0000-000000000000',
    discordId: interaction.user.id,
    username: interaction.user.username,
    level: 1,
    xp: 0,
    coins: 0,
    gems: 0,
    prestige: 0,
    energy: 0,
    energyMax: 100,
    locale,
    isAdmin: env.BOT_OWNER_IDS.includes(interaction.user.id),
    ecoBannedUntil: null,
    farmId: '',
    coopId: null,
    coopRole: null,
    created: false,
  };
  return {
    player: guest,
    config: getConfig(),
    balance: getBalance(),
    discordGuildId: interaction.guildId ?? undefined,
    locale,
    t: translatorFor(locale),
    now: new Date(),
  };
}

/** Le joueur est-il réellement enregistré ? (le contexte invité a un id nul) */
export function isGuest(context: CommandContext): boolean {
  return context.player.farmId === '';
}

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

export async function safeReply(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({
        embeds: payload.embeds,
        components: payload.components,
        files: payload.files,
        content: payload.content ?? undefined,
      });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    // Interaction expirée (10062) ou déjà acquittée (40060) : rien à faire de
    // plus, on journalise en debug pour ne pas polluer les alertes.
    log.debug({ err: error }, 'réponse impossible (interaction expirée ?)');
  }
}

export async function replyEphemeral(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  await safeReply(interaction, { ...payload, flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

export interface ErrorReport {
  /** Message affiché au joueur. */
  userMessage: string;
  /** Faut-il remonter l'incident dans le salon d'erreurs ? */
  report: boolean;
  code: string;
}

export function classifyError(error: unknown, context?: CommandContext): ErrorReport {
  if (error instanceof MaintenanceError) {
    return { userMessage: `🛠️ ${error.message}`, report: false, code: 'maintenance' };
  }
  if (error instanceof NotOwnerError) {
    return {
      userMessage: "Ce bouton n'est pas le vôtre — lancez la commande pour obtenir le vôtre.",
      report: false,
      code: 'not_owner',
    };
  }
  if (error instanceof LockBusyError) {
    return {
      userMessage: '⏳ An action is already running, give it a second.',
      report: false,
      code: 'busy',
    };
  }
  if (error instanceof CooldownError) {
    return {
      userMessage: `⏳ Easy! Try again ${discordTimestamp(error.retryAt, 'R')}.`,
      report: false,
      code: 'cooldown',
    };
  }
  if (isGameError(error)) {
    const hint = error.hint ? `\n💡 ${error.hint}` : '';
    return { userMessage: `${error.message}${hint}`, report: false, code: error.code };
  }

  const normalized = toError(error);
  log.error({ err: normalized, userId: context?.player.discordId }, 'erreur non gérée');
  return {
    userMessage:
      "😵 Une erreur inattendue est survenue. L'incident a été enregistré, réessayez dans un instant.",
    report: true,
    code: 'internal',
  };
}

/** Répond à une interaction en erreur, avec un éventuel bouton de rattrapage. */
export async function replyError(
  interaction: RepliableInteraction,
  error: unknown,
  context?: CommandContext,
): Promise<ErrorReport> {
  const report = classifyError(error, context);
  const embed = isGameError(error)
    ? warningEmbed('Action impossible', report.userMessage)
    : errorEmbed('Oups', report.userMessage);

  const components =
    isGameError(error) && error.suggestedCommand
      ? [suggestionRow(error.suggestedCommand, interaction.user.id)].filter(
          (component): component is NonNullable<typeof component> => component !== undefined,
        )
      : [];

  await replyEphemeral(interaction, { embeds: [embed], components });
  return report;
}

/** Embed « vous n'avez pas encore de ferme ». */
export function noAccountEmbed() {
  return baseEmbed({
    title: '🌱 Welcome!',
    description:
      "You do not have a farm yet.\nRun **`/start`** to receive your first plots, " +
      'your bag of seeds and your 500 🪙 to get going.',
    color: COLORS.info,
  });
}

/** Message de cooldown lisible. */
export function cooldownMessage(retryAt: Date): string {
  return `⏳ Easy! You can use this command again ${discordTimestamp(retryAt, 'R')} (in ${formatDuration(retryAt.getTime() - Date.now())}).`;
}

/** Type-guard utilitaire pour les interactions de composant que l'on gère. */
export function isComponentInteraction(
  interaction: Interaction,
): interaction is ButtonInteraction | StringSelectMenuInteraction {
  return interaction.isButton() || interaction.isStringSelectMenu();
}

export function isModal(interaction: Interaction): interaction is ModalSubmitInteraction {
  return interaction.isModalSubmit();
}

export function isChatCommand(interaction: Interaction): interaction is ChatInputCommandInteraction {
  return interaction.isChatInputCommand();
}
