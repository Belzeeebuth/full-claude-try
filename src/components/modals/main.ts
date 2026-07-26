import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../../framework/ui';
import { coopView } from '../../framework/views';
import { replyEphemeral } from '../../framework/interaction';
import * as coopService from '../../services/coop.service';
import * as marketService from '../../services/market.service';
import * as tradeService from '../../services/trade.service';
import { env } from '../../config/env';
import { gameError } from '../../utils/errors';
import { paramString } from '../../utils/custom-id';
import { formatCoins, formatNumber } from '../../utils/format';
import { moduleLogger } from '../../utils/logger';
import type { ModalHandler } from '../../types';

const log = moduleLogger('modals');

/**
 * Gestionnaires de fenêtres modales.
 *
 * Un modal est le seul moyen d'obtenir une saisie libre depuis un composant.
 * Les valeurs sont TOUJOURS revalidées ici : le client peut envoyer n'importe
 * quelle chaîne, y compris depuis un script.
 */

function parseQuantity(raw: string, max = 100_000): number {
  const cleaned = raw.trim().toLowerCase().replace(/\s|_/g, '');
  if (cleaned === 'tout' || cleaned === 'all' || cleaned === 'max') return max;
  const value = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw gameError('quantity_invalid', 'Invalid quantity: enter a positive number or "all".');
  }
  return Math.min(value, max);
}

const shopQuantity: ModalHandler = {
  namespace: 'shop',
  actions: ['buy_qty'],
  lockKey: 'shop-buy',

  async execute(interaction: ModalSubmitInteraction, parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const itemKey = paramString(parsed, 0);
    const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'), 999);

    const result = await marketService.buy(context.player, {
      itemKey,
      quantity,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🛒 Purchase complete',
          `${result.quantity}× ${result.emoji} **${result.name}** for **${
            result.currency === 'gems' ? `${formatNumber(result.total)} 💎` : formatCoins(result.total)
          }**.`,
        ),
      ],
    });
  },
};

const coopCreate: ModalHandler = {
  namespace: 'coop',
  actions: ['create'],
  lockKey: 'coop-action',

  async execute(interaction: ModalSubmitInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const name = interaction.fields.getTextInputValue('name').trim();
    // L'étiquette est dérivée du nom : trois premières lettres alphanumériques.
    const tag = name
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 4)
      .toUpperCase() || 'COOP';

    const info = await coopService.createCoop(context.player, { name, tag });
    await interaction.editReply({
      embeds: [
        successEmbed(
          `${info.emblem} ${info.name} [${info.tag}] founded!`,
          `Cost: ${formatCoins(context.balance.coop.creationCostCoins)}\nInvite friends with \`/coop invite\`.`,
        ),
      ],
    });
  },
};

const coopContribute: ModalHandler = {
  namespace: 'coop',
  actions: ['contribute'],
  lockKey: 'coop-action',

  async execute(interaction: ModalSubmitInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const amount = parseQuantity(
      interaction.fields.getTextInputValue('quantity'),
      Math.max(1, context.player.coins),
    );

    const result = await coopService.contribute(context.player, amount);
    await interaction.editReply({
      embeds: [
        successEmbed(
          '💰 Contribution',
          `${formatCoins(amount)} paid in.\nTreasury: **${formatCoins(result.treasury)}**\n+${formatNumber(result.coopXp)} co-op XP${result.levelsGained > 0 ? ` — 🎉 level **${result.level}**!` : ''}`,
        ),
      ],
    });
  },
};

const tradeCoins: ModalHandler = {
  namespace: 'trade',
  actions: ['coins_qty'],
  lockKey: 'trade-action',

  async execute(interaction: ModalSubmitInteraction, parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tradeId = paramString(parsed, 0);
    const amount = parseQuantity(
      interaction.fields.getTextInputValue('quantity'),
      Math.max(1, context.player.coins),
    );

    await tradeService.offerCoins(context.player, { tradeId, amount });
    await interaction.editReply({
      embeds: [
        successEmbed(
          '🪙 Offer updated',
          `You are offering **${formatCoins(amount)}**.\n⚠️ Both confirmations were reset: each player must validate again.`,
        ),
      ],
    });
  },
};

const tradeItem: ModalHandler = {
  namespace: 'trade',
  actions: ['item_qty'],
  lockKey: 'trade-action',

  async execute(interaction: ModalSubmitInteraction, parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tradeId = paramString(parsed, 0);
    const itemKey = paramString(parsed, 1);
    const quantity = parseQuantity(interaction.fields.getTextInputValue('quantity'), 9_999);

    await tradeService.offerItem(context.player, { tradeId, itemKey, quantity });
    await interaction.editReply({
      embeds: [
        successEmbed(
          '📦 Offer updated',
          `Item added to the trade.\n⚠️ Both confirmations were reset.`,
        ),
      ],
    });
  },
};

const adminAnnounce: ModalHandler = {
  namespace: 'admin',
  actions: ['announce'],
  adminOnly: true,

  async execute(interaction: ModalSubmitInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const message = interaction.fields.getTextInputValue('message');

    if (!env.DISCORD_ANNOUNCE_CHANNEL_ID) {
      throw gameError(
        'invalid_state',
        'No announcement channel configured (`DISCORD_ANNOUNCE_CHANNEL_ID`).',
      );
    }

    const channel = await interaction.client.channels.fetch(env.DISCORD_ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw gameError('invalid_state', "The announcement channel is missing or is not a text channel.");
    }

    await channel.send({
      embeds: [
        baseEmbed({
          title: '📢 Greenvale announcement',
          description: message,
          color: COLORS.gold,
          footer: `Posted by ${interaction.user.username}`,
        }),
      ],
    });

    log.warn({ actor: interaction.user.id, length: message.length }, 'annonce globale publiée');
    await interaction.editReply({ content: '✅ Announcement posted.' });
  },
};

export const handlers: ModalHandler[] = [
  shopQuantity,
  coopCreate,
  coopContribute,
  tradeCoins,
  tradeItem,
  adminAnnounce,
];

export { coopView, replyEphemeral };
