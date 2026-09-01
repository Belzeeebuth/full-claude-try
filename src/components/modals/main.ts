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
import type { ModalHandler, Translator } from '../../types';

const log = moduleLogger('modals');

/**
 * Gestionnaires de fenêtres modales.
 *
 * Un modal est le seul moyen d'obtenir une saisie libre depuis un composant.
 * Les valeurs sont TOUJOURS revalidées ici : le client peut envoyer n'importe
 * quelle chaîne, y compris depuis un script.
 */

/**
 * Étiquette de coopérative dérivée du nom.
 *
 * Le nom accepte tout l'alphabet Unicode (`\p{L}`), mais l'étiquette est limitée
 * à 2-5 caractères alphanumériques ASCII. Un nom entièrement cyrillique ou
 * arabe se réduisait donc à une chaîne vide, et TOUTES ces coopératives
 * retombaient sur le même repli « COOP » : la deuxième échouait sur « étiquette
 * déjà prise », avec un message parlant d'un champ que le joueur n'a jamais vu.
 *
 * On translittère d'abord les diacritiques, puis on complète par des chiffres
 * aléatoires quand il ne reste pas assez de caractères utilisables.
 */
export function deriveTag(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 5)
    .toUpperCase();

  if (ascii.length >= 2) return ascii;

  const filler = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0');
  return `${ascii}${filler}`.slice(0, 5);
}

function parseQuantity(t: Translator, raw: string, max = 100_000): number {
  const cleaned = raw.trim().toLowerCase().replace(/\s|_/g, '');
  if (cleaned === 'tout' || cleaned === 'all' || cleaned === 'max') return max;
  const value = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw gameError('quantity_invalid', t('economy.invalid_quantity_or_all'));
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
    const quantity = parseQuantity(context.t, interaction.fields.getTextInputValue('quantity'), 999);

    const result = await marketService.buy(context.player, {
      itemKey,
      quantity,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('shop.purchase_title'),
          context.t('shop.buy_qty_result_body', {
            quantity: result.quantity,
            emoji: result.emoji,
            name: result.name,
            amount:
              result.currency === 'gems'
                ? `${formatNumber(result.total, context.locale)} 💎`
                : formatCoins(result.total, false, context.locale),
          }),
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
    const info = await coopService.createCoop(context.player, { name, tag: deriveTag(name) });
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('coop.create_title', { emblem: info.emblem, name: info.name, tag: info.tag }),
          context.t('coop.create_modal_result_body', {
            cost: formatCoins(context.balance.coop.creationCostCoins, false, context.locale),
          }),
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
      context.t,
      interaction.fields.getTextInputValue('quantity'),
      Math.max(1, context.player.coins),
    );

    const result = await coopService.contribute(context.player, amount);
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('coop.contribute_title'),
          context.t('coop.contribute_body', {
            amount: formatCoins(amount, false, context.locale),
            treasury: formatCoins(result.treasury, false, context.locale),
            xp: formatNumber(result.coopXp, context.locale),
            levelUp:
              result.levelsGained > 0
                ? context.t('coop.contribute_level_up', { level: result.level })
                : '',
          }),
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
      context.t,
      interaction.fields.getTextInputValue('quantity'),
      Math.max(1, context.player.coins),
    );

    await tradeService.offerCoins(context.player, { tradeId, amount });
    await interaction.editReply({
      embeds: [
        successEmbed(
          context.t('trade.coins_updated_title'),
          context.t('trade.coins_updated_body', { amount: formatCoins(amount, false, context.locale) }),
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
    const quantity = parseQuantity(context.t, interaction.fields.getTextInputValue('quantity'), 9_999);

    await tradeService.offerItem(context.player, { tradeId, itemKey, quantity });
    await interaction.editReply({
      embeds: [successEmbed(context.t('trade.item_updated_title'), context.t('trade.item_updated_body'))],
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
      throw gameError('invalid_state', context.t('admin.no_announce_channel'));
    }

    const channel = await interaction.client.channels.fetch(env.DISCORD_ANNOUNCE_CHANNEL_ID);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw gameError('invalid_state', context.t('admin.announce_channel_invalid'));
    }

    await channel.send({
      embeds: [
        baseEmbed({
          title: context.t('admin.announce_posted_title'),
          description: message,
          color: COLORS.gold,
          footer: context.t('admin.announce_posted_footer', { username: interaction.user.username }),
        }),
      ],
    });

    log.warn({ actor: interaction.user.id, length: message.length }, 'annonce globale publiée');
    await interaction.editReply({ content: context.t('admin.announce_posted_content') });
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
