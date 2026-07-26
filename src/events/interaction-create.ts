import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { balance as getBalance, getConfig } from '../config';
import { env } from '../config/env';
import { checkAndSet, checkGlobalRate, cooldownSecondsFor } from '../framework/cooldown';
import {
  buildContext,
  cooldownMessage,
  noAccountEmbed,
  replyEphemeral,
  replyError,
} from '../framework/interaction';
import { findHandler, getCommand, getContextMenu } from '../framework/registry';
import { warningEmbed } from '../framework/ui';
import * as playerRepo from '../repositories/player.repo';
import { assertOwner, parseCustomId } from '../utils/custom-id';
import { withUserLock } from '../utils/lock';
import { moduleLogger } from '../utils/logger';
import { reportIncident } from './error-reporter';
import type { CommandContext } from '../types';

const log = moduleLogger('interactions');

/**
 * Point d'entrée unique de toutes les interactions Discord.
 *
 * Pipeline, dans cet ordre — l'ordre compte :
 *   1. Limitation de débit (avant tout accès base : c'est le bouclier).
 *   2. Résolution du gestionnaire (commande, bouton, menu, modal).
 *   3. Vérification du propriétaire du composant (anti-clic sur le message d'autrui).
 *   4. Construction du contexte joueur (création éventuelle du compte).
 *   5. Cooldown de commande.
 *   6. Verrou anti-double-clic pour les actions mutantes.
 *   7. Exécution, puis gestion centralisée des erreurs.
 */
export function registerInteractionHandler(client: Client): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    void handleInteraction(interaction).catch((error: unknown) => {
      log.error({ err: error }, 'échec du traitement de l\'interaction');
    });
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  // --- 1. Limitation de débit -------------------------------------------
  const rate = await checkGlobalRate(interaction.user.id);
  if (rate.limited && interaction.isRepliable()) {
    await replyEphemeral(interaction, {
      embeds: [
        warningEmbed(
          'Slow down!',
          `🚦 You are sending too many commands. Try again in ${Math.ceil(rate.resetInMs / 1000)} s.`,
        ),
      ],
    });
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton()) {
    await handleComponent(interaction, 'button');
  } else if (interaction.isStringSelectMenu()) {
    await handleComponent(interaction, 'select');
  } else if (interaction.isModalSubmit()) {
    await handleComponent(interaction, 'modal');
  } else if (interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
    await handleContextMenu(interaction);
  }
}

// ---------------------------------------------------------------------------
// Commandes slash
// ---------------------------------------------------------------------------

async function handleCommand(
  interaction: import('discord.js').ChatInputCommandInteraction,
): Promise<void> {
  const command = getCommand(interaction.commandName);
  if (!command) {
    await replyEphemeral(interaction, {
      embeds: [warningEmbed('Unknown command', 'This command no longer exists. Try again later.')],
    });
    return;
  }

  const started = Date.now();
  let context: CommandContext | null = null;

  try {
    if (!interaction.inGuild() && command.dmAllowed === false) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed('Server required', 'This command only works inside a server.')],
      });
      return;
    }

    context = await buildContext(interaction, {
      createIfMissing: interaction.commandName === 'start',
      requiresAccount: command.requiresAccount,
      referralCode: interaction.options.getString('code') ?? undefined,
    });

    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed()] });
      return;
    }

    if (command.adminOnly && !context.player.isAdmin) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed('Access denied', 'This command is reserved for bot administrators.')],
      });
      return;
    }

    // --- 5. Cooldown ------------------------------------------------------
    const bucket = command.cooldown?.bucket ?? interaction.commandName;
    const seconds = command.cooldown?.seconds ?? cooldownSecondsFor(interaction.commandName);
    if (seconds > 0) {
      const cooldown = await checkAndSet(context.player.id, bucket, seconds);
      if (cooldown.active) {
        await replyEphemeral(interaction, {
          embeds: [warningEmbed('Temps de recharge', cooldownMessage(cooldown.retryAt))],
        });
        return;
      }
    }

    // --- 6/7. Exécution sous verrou --------------------------------------
    await withUserLock(context.player.id, `cmd:${interaction.commandName}`, async () => {
      await command.execute(interaction, context!);
    });

    log.debug(
      {
        command: interaction.commandName,
        userId: context.player.discordId,
        ms: Date.now() - started,
      },
      'commande exécutée',
    );
  } catch (error) {
    const report = await replyError(interaction, error, context ?? undefined);
    if (report.report) {
      await reportIncident(interaction.client, error, {
        command: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Composants (boutons, menus, modals)
// ---------------------------------------------------------------------------

async function handleComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  kind: 'button' | 'select' | 'modal',
): Promise<void> {
  let context: CommandContext | null = null;

  try {
    const parsed = parseCustomId(interaction.customId);
    const handler = findHandler(kind, parsed.namespace, parsed.action);

    if (!handler) {
      await replyEphemeral(interaction, {
        embeds: [
          warningEmbed(
            'Component expired',
            'This message comes from an older version of the bot. Run the command again.',
          ),
        ],
      });
      return;
    }

    // --- 3. Propriété du composant ---------------------------------------
    if (handler.checkOwner !== false) {
      assertOwner(parsed, interaction.user.id);
    }

    context = await buildContext(interaction, {
      requiresAccount: handler.requiresAccount,
    });
    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed()] });
      return;
    }

    if (handler.adminOnly && !context.player.isAdmin) {
      await replyEphemeral(interaction, {
        embeds: [warningEmbed('Access denied', 'Action reserved for administrators.')],
      });
      return;
    }

    const lockKey = handler.lockKey ?? `${parsed.namespace}:${parsed.action}`;
    await withUserLock(context.player.id, lockKey, async () => {
      // Le cast est nécessaire car un gestionnaire est enregistré pour un type
      // précis d'interaction, garanti par le dossier dont il provient.
      await (handler.execute as (
        i: typeof interaction,
        p: typeof parsed,
        c: CommandContext,
      ) => Promise<void>)(interaction, parsed, context!);
    });
  } catch (error) {
    const report = await replyError(interaction, error, context ?? undefined);
    if (report.report) {
      await reportIncident(interaction.client, error, {
        command: `component:${interaction.customId}`,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Menus contextuels
// ---------------------------------------------------------------------------

async function handleContextMenu(
  interaction:
    | import('discord.js').UserContextMenuCommandInteraction
    | import('discord.js').MessageContextMenuCommandInteraction,
): Promise<void> {
  const menu = getContextMenu(interaction.commandName);
  if (!menu) return;

  let context: CommandContext | null = null;
  try {
    context = await buildContext(interaction, {});
    if (!context) {
      await replyEphemeral(interaction, { embeds: [noAccountEmbed()] });
      return;
    }
    await menu.execute(interaction, context);
  } catch (error) {
    await replyError(interaction, error, context ?? undefined);
  }
}

// ---------------------------------------------------------------------------
// Autocomplétion
// ---------------------------------------------------------------------------

/**
 * L'autocomplétion a un budget de 3 secondes et ne doit JAMAIS créer de compte
 * ni écrire en base. On lui donne un contexte allégé et on répond vide en cas
 * d'erreur : un menu vide est infiniment préférable à une commande cassée.
 */
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const command = getCommand(interaction.commandName);
  if (!command?.autocomplete) {
    await interaction.respond([]);
    return;
  }

  try {
    const user = await playerRepo.findUserByDiscordId(interaction.user.id);
    await command.autocomplete(interaction, {
      playerId: user?.id ?? null,
      discordId: interaction.user.id,
      config: getConfig(),
      balance: getBalance(),
    });
  } catch (error) {
    log.debug({ err: error, command: interaction.commandName }, 'autocomplétion en échec');
    try {
      await interaction.respond([]);
    } catch {
      /* interaction déjà expirée */
    }
  }
}

export { MessageFlags, env };
