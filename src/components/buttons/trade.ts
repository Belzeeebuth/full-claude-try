import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { tradeView } from '../../commands/trade';
import { COLORS, baseEmbed, quantityModal, select, selectRow, successEmbed } from '../../framework/ui';
import { replyEphemeral } from '../../framework/interaction';
import * as tradeService from '../../services/trade.service';
import * as inventoryRepo from '../../repositories/inventory.repo';
import * as playerRepo from '../../repositories/player.repo';
import { paramInt, paramString } from '../../utils/custom-id';
import { qualityIcon, truncate } from '../../utils/format';
import type { ButtonHandler, SelectHandler } from '../../types';

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
          quantityModal({
            namespace: 'trade',
            action: 'coins_qty',
            ownerId: interaction.user.id,
            params: [tradeId],
            title: 'Coins to offer',
            label: 'Amount in coins',
            placeholder: 'Ex. 2500',
          }),
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
                title: '📦 Nothing to trade',
                description: 'Your inventory holds no tradable item.',
                color: COLORS.warning,
              }),
            ],
          });
          return;
        }

        await replyEphemeral(interaction, {
          embeds: [baseEmbed({ title: '📦 Which item do you want to offer?', color: COLORS.info })],
          components: [
            selectRow(
              select({
                namespace: 'trade',
                action: 'pick_item',
                ownerId: interaction.user.id,
                params: [tradeId],
                placeholder: 'Pick an item',
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
            embeds: [
              successEmbed(
                '🤝 Trade completed',
                'Items and coins have been transferred. A transfer tax was taken on the coins exchanged.',
              ),
            ],
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
          await tradeView(context, result.trade, partner?.username ?? 'your partner'),
        );
        await interaction.followUp({
          content: '✅ Your confirmation is recorded. Waiting for your partner.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'cancel': {
        await interaction.deferUpdate();
        await tradeService.cancelTrade(context.player, tradeId);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: '✖️ Trade cancelled',
              description: 'No item changed hands.',
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
