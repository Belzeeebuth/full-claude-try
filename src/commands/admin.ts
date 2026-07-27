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
          title: 'Global announcement',
          fieldId: 'message',
          label: 'Message to broadcast',
          placeholder: 'The Christmas market is now open!',
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
              sub === 'give' ? '✅ Resource granted' : '✅ Resource removed',
              `${target} — **${formatNumber(result.applied)}** ${interaction.options.getString('resource', true)}\nAction written to the audit log.`,
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
              '🗑️ Player reset',
              `${target} has been removed (soft delete: the ledger is preserved).\nThey can start over with \`/start\`.`,
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
              '🚫 Economic ban',
              `${target} can no longer interact with the economy until ${discordTimestamp(result.until, 'F')}.`,
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
              enabled ? '🛠️ Maintenance enabled' : '✅ Maintenance disabled',
              enabled
                ? 'Only bot administrators can use this bot.'
                : 'The bot is available to everyone again.',
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
                '♻️ Configuration reloaded',
                `${result.crops} crops • ${result.items} items • ${result.recipes} recipes • ${result.quests} quests\nLoaded on ${result.loadedAt.toLocaleString('en-US')}.`,
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
            context.t('admin.reload_failed', {
              issues: truncate(issues.slice(0, 10).join('\n') || String(error), 900),
            }),
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
              title: '📊 Harvester dashboard',
              color: COLORS.info,
              fields: [
                {
                  name: '👥 Players',
                  value: [
                    `Total : **${formatNumber(stats.counts.users)}**`,
                    `Active 24 h: **${formatNumber(stats.counts.activeToday)}**`,
                    `Servers: **${formatNumber(stats.counts.guilds)}**`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '💰 Economy',
                  value: [
                    `Money supply: **${formatCompact(stats.economy.snapshot?.totalCoins ?? 0)}** 🪙`,
                    `In the bank: **${formatCompact(stats.economy.snapshot?.totalBankCoins ?? 0)}**`,
                    `Inflation 24 h : **${formatPercent(stats.economy.inflationRate)}**`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '⚙️ Configuration',
                  value: [
                    `Loaded: ${discordTimestamp(stats.config.loadedAt, 'R')}`,
                    `${stats.config.crops} crops • ${stats.config.items} items`,
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: '🔄 Money flows (24 h)',
                  value:
                    stats.economy.flows
                      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
                      .slice(0, 8)
                      .map((flow) => `${flow.total > 0 ? '➕' : '➖'} \`${flow.type}\` ${formatCompact(Math.abs(flow.total))}`)
                      .join('\n') || 'No movement.',
                  inline: false,
                },
                {
                  name: '🗓️ Scheduled tasks',
                  value:
                    stats.tasks
                      .slice(0, 6)
                      .map((task) => `\`${task.taskKey}\` — ${task.status} • ${discordTimestamp(task.runAt, 'R')}`)
                      .join('\n') || 'No jobs.',
                  inline: false,
                },
                ...(incidents.length > 0
                  ? [
                      {
                        name: '🚨 Recent incidents',
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
                `Level **${result.target.level}** • ${formatCoins(result.target.coins)} • ${result.target.gems} 💎`,
                `Score de suspicion : **${result.target.suspicionScore}**`,
                result.target.ecoBannedUntil
                  ? `🚫 Banned until ${discordTimestamp(result.target.ecoBannedUntil, 'F')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
              color: result.target.suspicionScore > 50 ? COLORS.warning : COLORS.info,
              fields: [
                {
                  name: "Audit log",
                  value:
                    result.logs
                      .map((entry) => `\`${entry.action}\` — ${discordTimestamp(entry.createdAt, 'R')}`)
                      .join('\n') || 'No entry.',
                  inline: true,
                },
                {
                  name: 'Latest transactions',
                  value:
                    result.transactions
                      .slice(0, 10)
                      .map(
                        (entry) =>
                          `${entry.amount > 0 ? '➕' : '➖'} ${formatCompact(Math.abs(entry.amount))} \`${entry.type}\``,
                      )
                      .join('\n') || 'No transactions.',
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
              '📈 Market updated',
              `${updated} prices recalculated.\n${audit.length === 0 ? '✅ No ledger drift detected.' : `⚠️ **${audit.length} ledger drift(s)** — see the logs.`}`,
            ),
          ],
        });
        break;
      }

      default:
        await interaction.editReply({ content: 'Unknown subcommand.' });
    }
  },
};

export const commands: Command[] = [admin];
