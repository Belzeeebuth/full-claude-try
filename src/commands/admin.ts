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
              { name: 'XP', value: 'xp' },
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
          title: context.t('admin.announce_modal_title'),
          fieldId: 'message',
          label: context.t('admin.announce_field_label'),
          placeholder: context.t('admin.announce_placeholder'),
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
        const resource = interaction.options.getString('resource', true) as
          | 'coins'
          | 'gems'
          | 'xp'
          | 'item'
          | 'energy';
        const result = await miscService.adminGrant(
          {
            actor: context.player,
            targetDiscordId: target.id,
            resource,
            amount: interaction.options.getInteger('amount', true),
            itemKey: interaction.options.getString('item') ?? undefined,
            reason: interaction.options.getString('reason') ?? undefined,
          },
          sub === 'take',
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              sub === 'give' ? context.t('admin.grant_title') : context.t('admin.take_title'),
              context.t('admin.grant_body', {
                target: `${target}`,
                amount: formatNumber(result.applied, context.locale),
                resource: context.t(`common.${resource}`),
              }),
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
              context.t('admin.reset_title'),
              context.t('admin.reset_body', { target: `${target}` }),
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
              context.t('admin.ecoban_title'),
              context.t('admin.ecoban_body', {
                target: `${target}`,
                date: discordTimestamp(result.until, 'F'),
              }),
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
              enabled ? context.t('admin.maintenance_on_title') : context.t('admin.maintenance_off_title'),
              enabled ? context.t('admin.maintenance_on_body') : context.t('admin.maintenance_off_body'),
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
                context.t('admin.reload_title'),
                context.t('admin.reload_body', {
                  crops: result.crops,
                  items: result.items,
                  recipes: result.recipes,
                  quests: result.quests,
                  date: discordTimestamp(result.loadedAt, 'F'),
                }),
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
              title: context.t('admin.stats_title'),
              color: COLORS.info,
              fields: [
                {
                  name: context.t('admin.stats_players_field'),
                  value: [
                    context.t('admin.stats_total_line', {
                      count: formatNumber(stats.counts.users, context.locale),
                    }),
                    context.t('admin.stats_active_line', {
                      count: formatNumber(stats.counts.activeToday, context.locale),
                    }),
                    context.t('admin.stats_servers_line', {
                      count: formatNumber(stats.counts.guilds, context.locale),
                    }),
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: context.t('admin.stats_economy_field'),
                  value: [
                    context.t('admin.stats_supply_line', {
                      value: formatCompact(stats.economy.snapshot?.totalCoins ?? 0, context.locale),
                    }),
                    context.t('admin.stats_bank_line', {
                      value: formatCompact(stats.economy.snapshot?.totalBankCoins ?? 0, context.locale),
                    }),
                    context.t('admin.stats_inflation_line', {
                      value: formatPercent(stats.economy.inflationRate, undefined, context.locale),
                    }),
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: context.t('admin.stats_config_field'),
                  value: [
                    context.t('admin.stats_loaded_line', {
                      relative: discordTimestamp(stats.config.loadedAt, 'R'),
                    }),
                    context.t('admin.stats_counts_line', {
                      crops: stats.config.crops,
                      items: stats.config.items,
                    }),
                  ].join('\n'),
                  inline: true,
                },
                {
                  name: context.t('admin.stats_flows_field'),
                  value:
                    stats.economy.flows
                      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
                      .slice(0, 8)
                      .map((flow) =>
                        context.t('admin.stats_flow_line', {
                          sign: flow.total > 0 ? '➕' : '➖',
                          type: flow.type,
                          amount: formatCompact(Math.abs(flow.total), context.locale),
                        }),
                      )
                      .join('\n') || context.t('admin.stats_no_movement'),
                  inline: false,
                },
                {
                  name: context.t('admin.stats_tasks_field'),
                  value:
                    stats.tasks
                      .slice(0, 6)
                      .map((task) =>
                        context.t('admin.stats_task_line', {
                          key: task.taskKey,
                          status: task.status,
                          relative: discordTimestamp(task.runAt, 'R'),
                        }),
                      )
                      .join('\n') || context.t('admin.stats_no_jobs'),
                  inline: false,
                },
                ...(incidents.length > 0
                  ? [
                      {
                        name: context.t('admin.stats_incidents_field'),
                        value: incidents
                          .slice(0, 5)
                          .map((incident) =>
                            context.t('admin.stats_incident_line', {
                              count: incident.count,
                              signature: truncate(incident.signature, 80),
                            }),
                          )
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
                context.t('admin.lookup_id_line', { id: result.target.id }),
                context.t('admin.lookup_level_line', {
                  level: result.target.level,
                  coins: formatCoins(result.target.coins, false, context.locale),
                  gems: result.target.gems,
                }),
                context.t('admin.lookup_suspicion_line', { score: result.target.suspicionScore }),
                result.target.ecoBannedUntil
                  ? context.t('admin.lookup_banned_line', {
                      date: discordTimestamp(result.target.ecoBannedUntil, 'F'),
                    })
                  : '',
              ]
                .filter(Boolean)
                .join('\n'),
              color: result.target.suspicionScore > 50 ? COLORS.warning : COLORS.info,
              fields: [
                {
                  name: context.t('admin.lookup_audit_field'),
                  value:
                    result.logs
                      .map((entry) =>
                        context.t('admin.lookup_audit_line', {
                          action: entry.action,
                          relative: discordTimestamp(entry.createdAt, 'R'),
                        }),
                      )
                      .join('\n') || context.t('admin.lookup_no_entry'),
                  inline: true,
                },
                {
                  name: context.t('admin.lookup_transactions_field'),
                  value:
                    result.transactions
                      .slice(0, 10)
                      .map((entry) =>
                        context.t('admin.lookup_transaction_line', {
                          sign: entry.amount > 0 ? '➕' : '➖',
                          amount: formatCompact(Math.abs(entry.amount), context.locale),
                          type: entry.type,
                        }),
                      )
                      .join('\n') || context.t('admin.lookup_no_transactions'),
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
              context.t('admin.market_update_title'),
              context.t('admin.market_update_body', {
                count: updated,
                driftPart:
                  audit.length === 0
                    ? context.t('admin.market_no_drift')
                    : context.t('admin.market_drift', { count: audit.length }),
              }),
            ),
          ],
        });
        break;
      }

      default:
        await interaction.editReply({ content: context.t('admin.unknown_subcommand') });
    }
  },
};

export const commands: Command[] = [admin];
