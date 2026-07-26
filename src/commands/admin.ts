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
    .setDescription('Commandes d\'administration de Harvester')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('donner')
        .setDescription('Attribuer une ressource à un joueur')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('ressource')
            .setDescription('Type de ressource')
            .setRequired(true)
            .addChoices(
              { name: 'Pièces', value: 'coins' },
              { name: 'Gemmes', value: 'gems' },
              { name: 'XP', value: 'xp' },
              { name: 'Énergie', value: 'energy' },
              { name: 'Objet', value: 'item' },
            ),
        )
        .addIntegerOption((option) =>
          option.setName('montant').setDescription('Quantité').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) => option.setName('objet').setDescription("Clé de l'objet (si ressource = objet)"))
        .addStringOption((option) => option.setName('raison').setDescription('Motif (journalisé)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('retirer')
        .setDescription('Retirer une ressource à un joueur')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('ressource')
            .setDescription('Type de ressource')
            .setRequired(true)
            .addChoices(
              { name: 'Pièces', value: 'coins' },
              { name: 'Gemmes', value: 'gems' },
              { name: 'Objet', value: 'item' },
            ),
        )
        .addIntegerOption((option) =>
          option.setName('montant').setDescription('Quantité').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) => option.setName('objet').setDescription("Clé de l'objet"))
        .addStringOption((option) => option.setName('raison').setDescription('Motif (journalisé)')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Réinitialiser un joueur (suppression douce)')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true))
        .addStringOption((option) =>
          option.setName('raison').setDescription('Motif (obligatoire)').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('ban-eco')
        .setDescription("Suspendre l'accès à l'économie")
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true))
        .addIntegerOption((option) =>
          option.setName('durée').setDescription('Durée en heures').setRequired(true).setMinValue(1),
        )
        .addStringOption((option) =>
          option.setName('raison').setDescription('Motif').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('maintenance')
        .setDescription('Basculer le mode maintenance')
        .addStringOption((option) =>
          option
            .setName('état')
            .setDescription('Activer ou désactiver')
            .setRequired(true)
            .addChoices({ name: 'Activer', value: 'on' }, { name: 'Désactiver', value: 'off' }),
        )
        .addStringOption((option) => option.setName('message').setDescription('Message affiché aux joueurs')),
    )
    .addSubcommand((sub) => sub.setName('annonce').setDescription('Publier une annonce globale'))
    .addSubcommand((sub) =>
      sub.setName('reload-config').setDescription('Recharger la configuration de gameplay à chaud'),
    )
    .addSubcommand((sub) => sub.setName('stats').setDescription('Tableau de bord du bot'))
    .addSubcommand((sub) =>
      sub
        .setName('lookup')
        .setDescription("Journal d'audit d'un joueur")
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('market-update').setDescription('Forcer une mise à jour du marché'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const sub = interaction.options.getSubcommand();

    if (sub === 'annonce') {
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
      case 'donner':
      case 'retirer': {
        const target = interaction.options.getUser('utilisateur', true);
        const result = await miscService.adminGrant(
          {
            actor: context.player,
            targetDiscordId: target.id,
            resource: interaction.options.getString('ressource', true) as
              | 'coins'
              | 'gems'
              | 'xp'
              | 'item'
              | 'energy',
            amount: interaction.options.getInteger('montant', true),
            itemKey: interaction.options.getString('objet') ?? undefined,
            reason: interaction.options.getString('raison') ?? undefined,
          },
          sub === 'retirer',
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              sub === 'donner' ? '✅ Ressource attribuée' : '✅ Ressource retirée',
              `${target} — **${formatNumber(result.applied)}** ${interaction.options.getString('ressource', true)}\nAction journalisée dans l'audit.`,
            ),
          ],
        });
        break;
      }

      case 'reset': {
        const target = interaction.options.getUser('utilisateur', true);
        await miscService.adminResetPlayer(
          context.player,
          target.id,
          interaction.options.getString('raison', true),
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

      case 'ban-eco': {
        const target = interaction.options.getUser('utilisateur', true);
        const result = await miscService.adminEcoBan(
          context.player,
          target.id,
          interaction.options.getInteger('durée', true),
          interaction.options.getString('raison', true),
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
        const enabled = interaction.options.getString('état', true) === 'on';
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
        const target = interaction.options.getUser('utilisateur', true);
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
