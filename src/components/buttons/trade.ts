import type { ButtonInteraction } from 'discord.js';
import { tradeView } from '../../commands/trade';
import { COLORS, baseEmbed, quantityModal, select, selectRow, successEmbed } from '../../framework/ui';
import { followUpEphemeral, replyEphemeral } from '../../framework/interaction';
import * as tradeService from '../../services/trade.service';
import * as inventoryRepo from '../../repositories/inventory.repo';
import * as playerRepo from '../../repositories/player.repo';
import { paramInt, paramString } from '../../utils/custom-id';
import { qualityIcon, truncate } from '../../utils/format';
import type { ButtonHandler } from '../../types';

/**
 * Échanges directs : ajout d'objets, de pièces, confirmation et annulation.
 *
 * La confirmation transporte la RÉVISION de l'échange dans son custom_id. Si
 * l'offre a changé depuis l'affichage du bouton, la révision ne correspond plus
 * et le service refuse : impossible de faire valider une offre puis de la
 * remplacer avant la validation de l'autre joueur.
 */
const tradeButtons: ButtonHandler = {
  namespace: 'trade',
  actions: ['add_item', 'add_coins', 'confirm', 'cancel'],
  lockKey: 'trade-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    const tradeId = paramString(parsed, 0);

    switch (parsed.action) {
      case 'add_coins': {
        await interaction.showModal(
          quantityModal(
            {
              namespace: 'trade',
              action: 'coins_qty',
              ownerId: interaction.user.id,
              params: [tradeId],
              title: context.t('trade.add_coins_modal_title'),
              label: context.t('trade.add_coins_modal_label'),
              placeholder: context.t('trade.add_coins_modal_placeholder'),
            },
            context.locale,
            context.t,
          ),
        );
        return;
      }

      case 'add_item': {
        const entries = await inventoryRepo.listInventory(context.player.id, {});
        const tradable = entries.filter((entry) => entry.tradable && !entry.locked).slice(0, 25);
        if (tradable.length === 0) {
          await replyEphemeral(interaction, {
            embeds: [
              baseEmbed({
                title: context.t('trade.no_item_title'),
                description: context.t('trade.no_item_body'),
                color: COLORS.warning,
              }),
            ],
          });
          return;
        }

        await replyEphemeral(interaction, {
          embeds: [baseEmbed({ title: context.t('trade.pick_item_title'), color: COLORS.info })],
          components: [
            selectRow(
              select({
                namespace: 'trade',
                action: 'pick_item',
                ownerId: interaction.user.id,
                params: [tradeId],
                placeholder: context.t('trade.pick_item_placeholder'),
                choices: tradable.map((entry) => ({
                  label: truncate(`${entry.name}${qualityIcon(entry.quality)} ×${entry.quantity}`, 90),
                  value: entry.itemKey,
                  emoji: entry.emoji,
                })),
              }),
            ),
          ],
        });
        return;
      }

      case 'confirm': {
        await interaction.deferUpdate();
        const revision = paramInt(parsed, 1, { min: 0, fallback: 0 });
        const result = await tradeService.confirmTrade(context.player, tradeId, revision);

        if (result.completed) {
          await interaction.editReply({
            embeds: [successEmbed(context.t('trade.completed_title'), context.t('trade.completed_body'))],
            components: [],
          });
          return;
        }

        const partnerId =
          result.trade.initiatorId === context.player.id
            ? result.trade.partnerId
            : result.trade.initiatorId;
        const partner = await playerRepo.findUserById(partnerId);
        await interaction.editReply(
          tradeView(context, result.trade, partner?.username ?? context.t('trade.partner_fallback')),
        );
        await followUpEphemeral(interaction, {
          content: context.t('trade.confirm_recorded'),
        });
        return;
      }

      case 'cancel': {
        await interaction.deferUpdate();
        await tradeService.cancelTrade(context.player, tradeId);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: context.t('trade.cancelled_title'),
              description: context.t('trade.cancelled_body'),
              color: COLORS.neutral,
            }),
          ],
          components: [],
        });
        return;
      }

      default:
        await interaction.deferUpdate();
    }
  },
};

export const handlers: ButtonHandler[] = [tradeButtons];
