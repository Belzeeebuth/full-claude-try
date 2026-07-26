import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed, textModal } from '../framework/ui';
import * as miscService from '../services/misc.service';
import * as economyService from '../services/economy.service';
import * as marketService from '../services/market.service';
import { incidentStats } from '../events/error-reporter';
import { gameError } from '../utils/errors';
import { discordTimestamp, formatCoins, formatCompact, formatNumber, formatPercent, truncate } from '../utils/format';
import type { Command } from '../types';

/**
 * Commandes d'administration.
 *
 * Double barrière : `adminOnly` (vérifié par le pipeline d'interaction contre
 * `BOT_OWNER_IDS` et le drapeau `users.is_admin`) ET
 * `setDefaultMemberPermissions(Administrator)` pour que la commande n'apparaisse
 * même pas aux membres ordinaires. Chaque action écrit dans `audit_logs`.
 */
const admin: Command = {
  category: 'admin',
  adminOnly: true,
  cooldown: { seconds: 0 },
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Harvester administration commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('give')
        .setDescription('Grant a resource to a player')
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('resource')
            .setDescription('Resource type')
            .setRequired(true)
            .addChoices(
              { name: 'Coins', value: 'coins' },
              { name: 'Gems', value: 'gems' },
              { name: 'XP', value: 'xp' },
              { name: 'Energy', value: 'energy' },
              { name: 'Item', value: 'item' },
            ),
        )
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Quantity').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) => option.setName('item').setDescription("Item key (when resource is an item)"))
        .addStringOption((option) => option.setName('reason').setDescription('Reason (logged)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('take')
        .setDescription('Take a resource away from a player')
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('resource')
            .setDescription('Resource type')
            .setRequired(true)
            .addChoices(
              { name: 'Coins', value: 'coins' },
              { name: 'Gems', value: 'gems' },
              { name: 'Item', value: 'item' },
            ),
        )
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Quantity').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) => option.setName('item').setDescription("Item key"))
        .addStringOption((option) => option.setName('reason').setDescription('Reason (logged)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Reset a player (soft delete)')
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true))
        .addStringOption((option) =>
          option.setName('reason').setDescription('Reason (required)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('eco-ban')
        .setDescription("Suspend access to the economy")
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true))
        .addIntegerOption((option) =>
          option.setName('duration').setDescription('Duration in hours').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('Reason').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('maintenance')
        .setDescription('Toggle maintenance mode')
        .addStringOption((option) =>
          option
            .setName('enabled')
            .setDescription('Turn on or off')
            .setRequired(true)
            .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }),
        )
        .addStringOption((option) => option.setName('message').setDescription('Message shown to players')),
    )
    .addSubcommand((sub) => sub.setName('announce').setDescription('Post a global announcement'))
    .addSubcommand((sub) =>
      sub.setName('reload-config').setDescription('Hot-reload the gameplay configuration'),
    )
    .addSubcommand((sub) => sub.setName('stats').setDescription('Bot dashboard'))
    .addSubcommand((sub) =>
      sub
        .setName('lookup')
        .setDescription("Audit log for a player")
        .addUserOption((option) => option.setName('user').setDescription('The player').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('market-update').setDescription('Force a market update'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const sub = interaction.options.getSubcommand();

    if (sub === 'announce') {
      await interaction.showModal(
        textModal({
          namespace: 'admin',
          action: 'announce',
          ownerId: interaction.user.id,
          title: 'Annonce globale',
          fieldId: 'message',
          label: 'Message à diffuser',
          placeholder: 'Le marché de Noël ouvre ses portes !',
          maxLength: 1800,
          paragraph: true,
        }),
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (sub) {
      case 'give':
      case 'take': {
        const target = interaction.options.getUser('user', true);
        const result = await miscService.adminGrant(
          {
            actor: context.player,
            targetDiscordId: target.id,
            resource: interaction.options.getString('resource', true) as
              | 'coins'
              | 'gems'
              | 'xp'
              | 'item'
              | 'energy',
            amount: interaction.options.getInteger('amount', true),
            itemKey: interaction.options.getString('item') ?? undefined,
            reason: interaction.options.getString('reason') ?? undefined,
          },
          sub === 'take',
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              sub === 'give' ? '✅ Ressource attribuée' : '✅ Ressource retirée',
              `${target} — **${formatNumber(result.applied)}** ${interaction.options.getString('resource', true)}\nAction journalisée dans l'audit.`,
            ),
          ],
        });
        break;
      }

      case 'reset': {
        const target = interaction.options.getUser('user', true);
        await miscService.adminResetPlayer(
          context.player,
          target.id,
          interaction.options.getString('reason', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              '🗑️ Joueur réinitialisé',
              `${target} a été supprimé (suppression douce : le journal comptable est conservé).\nIl pourra recommencer avec \`/start\`.`,
            ),
          ],
        });
        break;
      }

      case 'eco-ban': {
        const target = interaction.options.getUser('user', true);
        const result = await miscService.adminEcoBan(
          context.player,
          target.id,
          interaction.options.getInteger('duration', true),
          interaction.options.getString('reason', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              '🚫 Bannissement économique',
              `${target} ne peut plus interagir avec l'économie jusqu'au ${discordTimestamp(result.until, 'F')}.`,
            ),
          ],
        });
        break;
      }

      case 'maintenance': {
        const enabled = interaction.options.getString('enabled', true) === 'on';
        await miscService.setMaintenance(
          context.player,
          enabled,
          interaction.options.getString('message') ?? undefined,
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              enabled ? '🛠️ Maintenance activée' : '✅ Maintenance désactivée',
              enabled
                ? 'Seuls les administrateurs peuvent utiliser le bot.'
                : 'Le bot est de nouveau accessible à tous.',
            ),
          ],
        });
        break;
      }

      case 'reload-config': {
        try {
          const result = await miscService.adminReloadConfig(context.player);
          await interaction.editReply({
            embeds: [
              successEmbed(
                '♻️ Configuration rechargée',
                `${result.crops} cultures • ${result.items} objets • ${result.recipes} recettes • ${result.quests} quêtes\nChargée le ${result.loadedAt.toLocaleString('fr-FR')}.`,
              ),
            ],
          });
        } catch (error) {
          const issues =
            error && typeof error === 'object' && 'issues' in error
              ? (error as { issues: string[] }).issues
              : [];
          throw gameError(
            'invalid_state',
            `Rechargement refusé : la configuration est invalide. **L'ancienne reste active.**\n\`\`\`\n${truncate(issues.slice(0, 10).join('\n') || String(error), 900)}\n\`\`\``,
          );
        }
        break;
      }

      case 'stats': {
        const stats = await miscService.adminStats();
        const incidents = incidentStats();
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: '📊 Tableau de bord Harvester',
              color: COLORS.info,
              fields: [
                {
                  name: '👥 Joueurs',
                  value: [
                    `Total : **${formatNumber(stats.counts.users)}**`,
                    `Actifs 24 h : **${formatNumber(stats.counts.activeToday)}**`,
                    `Serveurs : **${formatNumber(stats.counts.guilds)}**`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '💰 Économie',
                  value: [
                    `Masse monétaire : **${formatCompact(stats.economy.snapshot?.totalCoins ?? 0)}** 🪙`,
                    `En banque : **${formatCompact(stats.economy.snapshot?.totalBankCoins ?? 0)}**`,
                    `Inflation 24 h : **${formatPercent(stats.economy.inflationRate)}**`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '⚙️ Configuration',
                  value: [
                    `Chargée : ${discordTimestamp(stats.config.loadedAt, 'R')}`,
                    `${stats.config.crops} cultures • ${stats.config.items} objets`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '🔄 Flux monétaires (24 h)',
                  value:
                    stats.economy.flows
                      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
                      .slice(0, 8)
                      .map((flow) => `${flow.total > 0 ? '➕' : '➖'} \`${flow.type}\` ${formatCompact(Math.abs(flow.total))}`)
                      .join('\n') || 'Aucun mouvement.',
                  inline: false,
                },
                {
                  name: '🗓️ Tâches planifiées',
                  value:
                    stats.tasks
                      .slice(0, 6)
                      .map((task) => `\`${task.taskKey}\` — ${task.status} • ${discordTimestamp(task.runAt, 'R')}`)
                      .join('\n') || 'Aucune tâche.',
                  inline: false,
                },
                ...(incidents.length > 0
                  ? [
                      {
                        name: '🚨 Incidents récents',
                        value: incidents
                          .slice(0, 5)
                          .map((incident) => `×${incident.count} — \`${truncate(incident.signature, 80)}\``)
                          .join('\n'),
                      },
                    ]
                  : []),
              ],
            }),
          ],
        });
        break;
      }

      case 'lookup': {
        const target = interaction.options.getUser('user', true);
        const result = await miscService.adminLookup(target.id, 12);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: `🔍 ${result.target.username}`,
              description: [
                `ID : \`${result.target.id}\``,
                `Niveau **${result.target.level}** • ${formatCoins(result.target.coins)} • ${result.target.gems} 💎`,
                `Score de suspicion : **${result.target.suspicionScore}**`,
                result.target.ecoBannedUntil
                  ? `🚫 Banni jusqu'au ${discordTimestamp(result.target.ecoBannedUntil, 'F')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
              color: result.target.suspicionScore > 50 ? COLORS.warning : COLORS.info,
              fields: [
                {
                  name: "Journal d'audit",
                  value:
                    result.logs
                      .map((entry) => `\`${entry.action}\` — ${discordTimestamp(entry.createdAt, 'R')}`)
                      .join('\n') || 'Aucune entrée.',
                  inline: true,
                },
                {
                  name: 'Dernières transactions',
                  value:
                    result.transactions
                      .slice(0, 10)
                      .map(
                        (entry) =>
                          `${entry.amount > 0 ? '➕' : '➖'} ${formatCompact(Math.abs(entry.amount))} \`${entry.type}\``,
                      )
                      .join('\n') || 'Aucune transaction.',
                  inline: true,
                },
              ],
            }),
          ],
        });
        break;
      }

      case 'market-update': {
        const updated = await marketService.updateMarket();
        const audit = await economyService.auditLedger(20);
        await interaction.editReply({
          embeds: [
            successEmbed(
              '📈 Marché mis à jour',
              `${updated} prix recalculés.\n${audit.length === 0 ? '✅ Aucun écart comptable détecté.' : `⚠️ **${audit.length} écart(s) comptable(s)** — voir les logs.`}`,
            ),
          ],
        });
        break;
      }

      default:
        await interaction.editReply({ content: 'Sous-commande inconnue.' });
    }
  },
};

export const commands: Command[] = [admin];
