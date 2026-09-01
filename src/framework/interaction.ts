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
import { translate, translatorFor, normalizeLocale } from '../i18n';
import { assertNotEcoBanned, ensurePlayer } from '../services/player.service';
import { getMaintenance } from '../services/misc.service';
import { MaintenanceError, isGameError, toError } from '../utils/errors';
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

/**
 * Commandes restant accessibles à un joueur banni de l'économie.
 *
 * Le bannissement doit couper les ACTIONS, pas l'information : quelqu'un de
 * sanctionné doit pouvoir lire pourquoi, consulter son profil et la
 * documentation de jeu. Tout le reste — y compris les composants, qui sont des
 * actions déguisées en boutons — est refusé.
 */
const ECO_BAN_READONLY = new Set([
  'help',
  'profile',
  'stats',
  'settings',
  'lang',
  'crops',
  'encyclopedia',
  'recipes',
  'item',
  'leaderboard',
  'season',
  'weather',
  'tutorial',
  'achievements',
]);

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

  // Bannissement économique. `assertNotEcoBanned` existait mais n'avait aucun
  // appelant : `/admin eco-ban` comme les bannissements automatiques de
  // `flagSuspicion` n'écrivaient qu'une date en base, sans le moindre effet.
  const commandName = interaction.isChatInputCommand() ? interaction.commandName : undefined;
  if (!commandName || !ECO_BAN_READONLY.has(commandName)) {
    assertNotEcoBanned(result.player);
  }

  const locale = normalizeLocale(result.player.locale);
  return {
    player: result.player,
    config: getConfig(locale),
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
    compactMode: false,
    equippedPetKey: null,
    ecoBannedUntil: null,
    farmId: '',
    coopId: null,
    coopRole: null,
    created: false,
  };
  return {
    player: guest,
    config: getConfig(locale),
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

/**
 * Traducteur de repli quand aucun `CommandContext` n'est encore disponible
 * (échec de propriété d'un composant, verrou pris avant la résolution du
 * joueur…) : on retombe sur la locale Discord de l'interaction plutôt que sur
 * le français fixe, pour qu'un client anglophone ne voie pas du français.
 */
function resolveTranslator(context: CommandContext | undefined, fallbackLocale?: string | null) {
  return context?.t ?? translatorFor(normalizeLocale(fallbackLocale));
}

export function classifyError(
  error: unknown,
  context?: CommandContext,
  fallbackLocale?: string | null,
): ErrorReport {
  const t = resolveTranslator(context, fallbackLocale ?? context?.locale);

  if (error instanceof MaintenanceError) {
    return {
      userMessage: t('common.maintenance', { message: error.message }).trim(),
      report: false,
      code: 'maintenance',
    };
  }
  if (error instanceof NotOwnerError) {
    return {
      userMessage: t('common.not_your_button'),
      report: false,
      code: 'not_owner',
    };
  }
  if (error instanceof LockBusyError) {
    return {
      userMessage: t('common.action_in_progress'),
      report: false,
      code: 'busy',
    };
  }
  if (isGameError(error)) {
    const message = error.i18nKey ? t(error.i18nKey, error.params) : error.message;
    const hintText = error.hintKey ? t(error.hintKey, error.params) : error.hint;
    const hint = hintText ? `\n💡 ${hintText}` : '';
    return { userMessage: `${message}${hint}`, report: false, code: error.code };
  }

  const normalized = toError(error);
  log.error({ err: normalized, userId: context?.player.discordId }, 'erreur non gérée');
  return {
    userMessage: t('common.unknown_error'),
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
  const report = classifyError(error, context, interaction.locale);
  const t = resolveTranslator(context, interaction.locale);
  const embed = isGameError(error)
    ? warningEmbed(t('common.action_failed_title'), report.userMessage)
    : errorEmbed(t('common.internal_error_title'), report.userMessage);

  const components =
    isGameError(error) && error.suggestedCommand
      ? [suggestionRow(error.suggestedCommand, interaction.user.id, undefined, t)].filter(
          (component): component is NonNullable<typeof component> => component !== undefined,
        )
      : [];

  await replyEphemeral(interaction, { embeds: [embed], components });
  return report;
}

/** Embed « vous n'avez pas encore de ferme ». */
export function noAccountEmbed(locale?: string | null) {
  const t = translatorFor(normalizeLocale(locale));
  return baseEmbed({
    title: `🌱 ${t('common.no_account_title')}`,
    description: t('common.no_account'),
    color: COLORS.info,
  });
}

/** Message de cooldown lisible. */
export function cooldownMessage(retryAt: Date, locale?: string | null): string {
  const normalized = normalizeLocale(locale);
  return translate(normalized, 'common.cooldown', {
    when: `${discordTimestamp(retryAt, 'R')} (${formatDuration(retryAt.getTime() - Date.now(), normalized)})`,
  });
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
