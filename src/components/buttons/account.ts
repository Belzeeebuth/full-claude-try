import type { ButtonInteraction } from 'discord.js';
import { COLORS, baseEmbed, successEmbed, warningEmbed } from '../../framework/ui';
import * as accountService from '../../services/account.service';
import { paramInt } from '../../utils/custom-id';
import type { ButtonHandler } from '../../types';

/**
 * Confirmation et annulation de `/account delete`.
 *
 * `checkOwner` reste à sa valeur par défaut : seul l'auteur de la commande peut
 * confirmer. Le custom_id porte l'instant d'émission (`issuedAt`) pour qu'une
 * confirmation périmée soit refusée — un bouton rouge oublié dans un message
 * éphémère ne doit pas rester armé indéfiniment.
 */
const accountButtons: ButtonHandler = {
  namespace: 'account',
  actions: ['confirm_delete', 'cancel_delete'],
  lockKey: 'account-delete',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const t = context.t;

    if (parsed.action === 'cancel_delete') {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: t('account.cancelled_title'),
            description: t('account.cancelled_body'),
            color: COLORS.neutral,
          }),
        ],
        components: [],
      });
      return;
    }

    const issuedAt = paramInt(parsed, 0, { min: 0, fallback: 0 });
    if (!accountService.isConfirmationFresh(issuedAt, context.now)) {
      // Pas une erreur au sens du pipeline : on remplace simplement le bouton
      // périmé par l'explication, sans supprimer le message.
      await interaction.editReply({
        embeds: [warningEmbed(t('account.expired_title'), t('account.expired_body'))],
        components: [],
      });
      return;
    }

    const report = await accountService.deleteAccount(context.player, context.now);

    await interaction.editReply({
      embeds: [
        successEmbed(
          t('account.deleted_title'),
          t('account.deleted_body', {
            apiKeys: report.apiKeysRevoked,
            webhooks: report.webhooksDeleted,
            orders: report.ordersCancelled,
          }),
        ),
      ],
      components: [],
    });
  },
};

export const handlers: ButtonHandler[] = [accountButtons];
