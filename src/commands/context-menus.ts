import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  type UserContextMenuCommandInteraction,
} from 'discord.js';
import { farmView } from '../framework/views';
import { tradeView } from './trade';
import * as playerRepo from '../repositories/player.repo';
import * as tradeService from '../services/trade.service';
import { gameError } from '../utils/errors';
import type { CommandContext, ContextMenuCommand } from '../types';

/**
 * Menus contextuels (clic droit sur un utilisateur → Applications).
 *
 * Ils offrent un raccourci sans taper de commande, ce qui compte beaucoup sur
 * mobile où la saisie est pénible.
 */

const voirLaFerme: ContextMenuCommand = {
  data: new ContextMenuCommandBuilder()
    .setName('View farm')
    .setType(ApplicationCommandType.User)
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const menu = interaction as UserContextMenuCommandInteraction;
    await menu.deferReply({ flags: MessageFlags.Ephemeral });
    const target = menu.targetUser;

    const bundle = await playerRepo.loadPlayerBundle(target.id);
    if (!bundle) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);
    if (bundle.settings.privacy === 'private' && target.id !== menu.user.id) {
      throw gameError('privacy_blocked', `${target.displayName} a rendu sa ferme privée.`);
    }

    const viewContext: CommandContext = {
      ...context,
      player: {
        ...context.player,
        id: bundle.user.id,
        farmId: bundle.farm.id,
        level: bundle.user.level,
        coins: bundle.user.coins,
        gems: bundle.user.gems,
        xp: bundle.user.xp,
        prestige: bundle.user.prestige,
        username: bundle.user.displayName ?? bundle.user.username,
      },
    };

    const view = await farmView(viewContext, {
      targetName: target.displayName,
      avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }),
      readOnly: true,
    });

    await menu.editReply({ embeds: view.embeds ?? [], files: view.files ?? [] });
  },
};

const proposerEchange: ContextMenuCommand = {
  data: new ContextMenuCommandBuilder()
    .setName('Propose a trade')
    .setType(ApplicationCommandType.User)
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const menu = interaction as UserContextMenuCommandInteraction;
    await menu.deferReply();
    const target = menu.targetUser;

    if (target.bot) throw gameError('target_invalid', 'Les robots ne troquent pas.');
    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);

    const trade = await tradeService.openTrade(context.player, targetUser.id);
    await menu.editReply(await tradeView(context, trade, target.displayName));
  },
};

export const contextMenus: ContextMenuCommand[] = [voirLaFerme, proposerEchange];
