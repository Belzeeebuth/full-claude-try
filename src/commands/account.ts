import {
  AttachmentBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { checkAndSet, clear as clearCooldown, cooldownSecondsFor } from '../framework/cooldown';
import { button, row, successEmbed, warningEmbed } from '../framework/ui';
import * as accountService from '../services/account.service';
import { CooldownError } from '../utils/errors';
import type { Command, CommandContext } from '../types';

/**
 * `/account export` et `/account delete` — droits d'accès et d'effacement (RGPD).
 *
 * Tout est éphémère : un export contient l'intégralité des données du joueur,
 * et un avertissement de suppression n'a rien à faire dans un salon public.
 */

const EXPORT_BUCKET = 'account_export';
const EXPORT_COOLDOWN_SECONDS = 3_600;

/**
 * Le cooldown d'export est posé ICI, par sous-commande, et non déclaré sur la
 * commande : un cooldown déclaré s'applique à toutes les sous-commandes, et
 * une heure sur `/account` entière aurait rendu `/account delete` inutilisable
 * juste après un export — qui est pourtant l'enchaînement attendu. Le seau
 * garde le nom `account_export` pour rester réglable dans `balance.cooldowns`.
 */
async function runExport(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> {
  const seconds = cooldownSecondsFor(EXPORT_BUCKET, EXPORT_COOLDOWN_SECONDS);
  const cooldown = await checkAndSet(context.player.id, EXPORT_BUCKET, seconds);
  if (cooldown.active) {
    throw new CooldownError(cooldown.retryAt, 'account export');
  }

  let result: accountService.AccountExportResult;
  try {
    result = await accountService.buildAccountExport(context.player, context.now);
  } catch (error) {
    // Un export qui échoue ne doit pas consommer l'heure d'attente : le joueur
    // n'a rien reçu, il doit pouvoir réessayer tout de suite.
    await clearCooldown(context.player.id, EXPORT_BUCKET);
    throw error;
  }

  const t = context.t;
  const lines = [
    t('account.export_body', { transactions: result.transactions }),
    ...(result.truncated.length > 0
      ? [t('account.export_truncated', { sections: result.truncated.join(', ') })]
      : []),
    '',
    t('account.export_privacy'),
  ];

  await interaction.editReply({
    embeds: [successEmbed(t('account.export_title'), lines.join('\n'))],
    files: [new AttachmentBuilder(Buffer.from(result.json, 'utf8'), { name: result.fileName })],
  });
}

/**
 * Premier temps de la suppression : avertissement et boutons. Les blocages
 * sont contrôlés dès maintenant, pour que le joueur sache immédiatement ce
 * qu'il doit régler — pas après avoir cliqué sur un bouton rouge.
 */
async function runDeletePrompt(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<void> {
  await accountService.assertDeletable(context.player, context.now);

  const t = context.t;
  const issuedAt = Math.floor(context.now.getTime() / 1000);
  const minutes = Math.floor(accountService.DELETE_CONFIRMATION_TTL_SECONDS / 60);

  await interaction.editReply({
    embeds: [
      warningEmbed(
        t('account.delete_title'),
        [
          t('account.delete_body'),
          '',
          t('account.delete_effects'),
          '',
          t('account.delete_keeps'),
          '',
          t('account.delete_expires', { minutes }),
        ].join('\n'),
      ),
    ],
    components: [
      row(
        button({
          namespace: 'account',
          action: 'confirm_delete',
          ownerId: interaction.user.id,
          params: [issuedAt],
          label: t('account.delete_confirm_button'),
          emoji: '🗑️',
          style: ButtonStyle.Danger,
        }),
        button({
          namespace: 'account',
          action: 'cancel_delete',
          ownerId: interaction.user.id,
          label: t('account.delete_cancel_button'),
          emoji: '✖️',
          style: ButtonStyle.Secondary,
        }),
      ),
    ],
  });
}

const account: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3, bucket: 'account' },
  data: new SlashCommandBuilder()
    .setName('account')
    .setDescription('Export or delete your Harvester account data')
    .addSubcommand((sub) =>
      sub.setName('export').setDescription('Download everything Harvester stores about you (JSON)'),
    )
    .addSubcommand((sub) =>
      sub.setName('delete').setDescription('Permanently delete your farm and personal data'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (interaction.options.getSubcommand()) {
      case 'export':
        await runExport(interaction, context);
        break;
      case 'delete':
        await runDeletePrompt(interaction, context);
        break;
      default:
        break;
    }
  },
};

export const commands: Command[] = [account];
