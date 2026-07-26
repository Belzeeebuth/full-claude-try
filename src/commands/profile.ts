import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, confirmRow, row } from '../framework/ui';
import { renderProfileImage } from '../render';
import { getProfile } from '../services/player.service';
import * as miscService from '../services/misc.service';
import * as playerRepo from '../repositories/player.repo';
import { prestigeBadge } from '../game/prestige';
import { gameError } from '../utils/errors';
import { isValidTimezone } from '../utils/time';
import {
  COIN,
  GEM,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  progressBar,
} from '../utils/format';
import type { Command } from '../types';

/** Profil, statistiques, paramètres, solde et prestige. */

const profil: Command = {
  category: 'demarrage',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Carte de profil illustrée')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Le fermier à afficher'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('utilisateur') ?? interaction.user;
    const profile = await getProfile(target.id);
    if (!profile) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);

    const image = await renderProfileImage({
      locale: context.locale,
      username: profile.user.username,
      displayName: profile.user.displayName ?? profile.user.username,
      avatarUrl: target.displayAvatarURL({ extension: 'png', size: 256 }),
      title: profile.user.title,
      badges: profile.user.badges,
      level: profile.user.level,
      prestige: profile.user.prestige,
      xp: { current: profile.user.xp, needed: profile.xpForNext },
      coins: profile.user.coins,
      gems: profile.user.gems,
      bank: profile.bankBalance,
      energy: { current: profile.energy.current, max: profile.energy.max },
      stats: {
        harvests: profile.user.totalHarvests,
        animals: profile.user.totalAnimalsRaised,
        crafts: profile.user.totalCrafts,
        plots: profile.plotsUnlocked,
        streak: profile.streak,
        achievements: profile.achievementsUnlocked,
        bestHarvest: profile.user.bestHarvestValue,
        coinsEarned: profile.user.totalCoinsEarned,
      },
      coop: profile.coop,
      themeColor: profile.user.profileColor,
      bannerStyle: profile.user.profileTheme,
      farmName: profile.farm.name,
      createdAt: profile.user.createdAt,
    });

    const embed = baseEmbed({
      title: `${profile.user.displayName ?? profile.user.username} ${prestigeBadge(profile.user.prestige)}`,
      description: [
        profile.user.title ? `*${profile.user.title}*` : '',
        `**Niveau ${profile.user.level}** — ${progressBar(profile.user.xp, profile.xpForNext || 1, 12)} ${formatCompact(profile.user.xp)}/${formatCompact(profile.xpForNext)} XP`,
        `${COIN} ${formatNumber(profile.user.coins)} • ${GEM} ${formatNumber(profile.user.gems)} • 🏦 ${formatCompact(profile.bankBalance)}`,
        `⚡ ${profile.energy.current}/${profile.energy.max}${profile.energy.fullAt ? ` (plein ${discordTimestamp(profile.energy.fullAt, 'R')})` : ''}`,
        profile.coop ? `🤝 **${profile.coop.name}** [${profile.coop.tag}] — niv. ${profile.coop.level}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.primary,
      image: image.fileName ? `attachment://${image.fileName}` : undefined,
    });

    if (!image.attachment) {
      embed.addFields(
        { name: '🌾 Récoltes', value: formatNumber(profile.user.totalHarvests), inline: true },
        { name: '🐄 Animaux élevés', value: formatNumber(profile.user.totalAnimalsRaised), inline: true },
        { name: '🛠️ Objets fabriqués', value: formatNumber(profile.user.totalCrafts), inline: true },
        { name: '🗺️ Parcelles', value: `${profile.plotsUnlocked}/64`, inline: true },
        { name: '🔥 Série', value: `${profile.streak} jour(s)`, inline: true },
        { name: '🏆 Succès', value: String(profile.achievementsUnlocked), inline: true },
      );
    }

    await interaction.editReply({
      embeds: [embed],
      files: image.attachment ? [image.attachment] : [],
      components: [
        row(
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'Ma ferme',
            emoji: '🌾',
          }),
          button({
            namespace: 'profile',
            action: 'stats',
            ownerId: interaction.user.id,
            params: [target.id],
            label: 'Statistiques',
            emoji: '📊',
          }),
        ),
      ],
    });
  },
};

const stats: Command = {
  category: 'demarrage',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Statistiques détaillées')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Le fermier à analyser'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('utilisateur') ?? interaction.user;
    const data = await miscService.playerStats(target.id);
    if (!data) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `📊 Statistiques de ${data.user.displayName ?? data.user.username}`,
          color: COLORS.info,
          fields: [
            {
              name: '🌾 Agriculture',
              value: [
                `Récoltes : **${formatNumber(data.user.totalHarvests)}**`,
                `Graines plantées : **${formatNumber(data.user.totalPlanted)}**`,
                `Arrosages : **${formatNumber(data.user.totalWatered)}**`,
                `Meilleure récolte : **${formatCoins(data.user.bestHarvestValue, true)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🐄 Élevage & artisanat',
              value: [
                `Animaux élevés : **${formatNumber(data.user.totalAnimalsRaised)}**`,
                `Vivants : **${data.animalsAlive}**`,
                `Objets fabriqués : **${formatNumber(data.user.totalCrafts)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '💰 Économie',
              value: [
                `Gagné : **${formatCoins(data.user.totalCoinsEarned, true)}**`,
                `Dépensé : **${formatCoins(data.user.totalCoinsSpent, true)}**`,
                `Solde : **${formatCoins(data.user.coins, true)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🤝 Social & fidélité',
              value: [
                `Coups de main donnés : **${formatNumber(data.user.totalHelpGiven)}**`,
                `Série actuelle : **${data.streak}** j (record : ${data.longestStreak})`,
                `Commandes utilisées : **${formatNumber(data.user.commandsUsed)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🏅 Classements',
              value: [
                data.ranks.wealth ? `Richesse : **#${data.ranks.wealth.rank}**` : '',
                data.ranks.level ? `Expérience : **#${data.ranks.level.rank}**` : '',
                data.ranks.harvests ? `Récoltes : **#${data.ranks.harvests.rank}**` : '',
              ]
                .filter(Boolean)
                .join('\n') || '—',
              inline: true,
            },
            {
              name: '📦 Divers',
              value: [
                `Inventaire : **${formatNumber(data.inventoryTotal)}** objets`,
                `Ferme créée le **${data.user.createdAt.toLocaleDateString('fr-FR')}**`,
                `Prestige : **${data.user.prestige}** ${prestigeBadge(data.user.prestige)}`,
              ].join('\n'),
              inline: true,
            },
          ],
        }),
      ],
    });
  },
};

const solde: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('solde')
    .setDescription('Affiche votre solde')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Le fermier à consulter'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const target = interaction.options.getUser('utilisateur') ?? interaction.user;
    const user = await playerRepo.findUserByDiscordId(target.id);
    if (!user) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);
    const bank = await playerRepo.getBankAccount(user.id);

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: `💰 Solde de ${user.displayName ?? user.username}`,
          description: [
            `${COIN} **${formatNumber(user.coins)}** pièces en poche`,
            `${GEM} **${formatNumber(user.gems)}** gemmes`,
            `🏦 **${formatNumber(bank?.balance ?? 0)}** en banque (capacité ${formatCompact(bank?.capacity ?? 0)})`,
            '',
            `Patrimoine total : **${formatCoins(user.coins + (bank?.balance ?? 0))}**`,
          ].join('\n'),
          color: COLORS.gold,
        }),
      ],
    });
  },
};

const parametres: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('parametres')
    .setDescription('Vos préférences : notifications, langue, confidentialité')
    .addBooleanOption((option) =>
      option.setName('notifications-mp').setDescription('Recevoir des rappels en message privé'),
    )
    .addStringOption((option) =>
      option
        .setName('langue')
        .setDescription('Langue de l\'interface')
        .addChoices({ name: 'Français', value: 'fr' }, { name: 'English', value: 'en' }),
    )
    .addStringOption((option) =>
      option
        .setName('confidentialité')
        .setDescription('Qui peut voir votre ferme ?')
        .addChoices(
          { name: 'Tout le monde', value: 'public' },
          { name: 'Ma coopérative', value: 'coop_only' },
          { name: 'Personne', value: 'private' },
        ),
    )
    .addStringOption((option) =>
      option.setName('fuseau').setDescription('Fuseau horaire (ex. Europe/Paris)').setMaxLength(48),
    )
    .addBooleanOption((option) =>
      option.setName('mode-compact').setDescription('Désactiver les images générées'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const patch: Record<string, unknown> = {};
    const dm = interaction.options.getBoolean('notifications-mp');
    const locale = interaction.options.getString('langue');
    const privacy = interaction.options.getString('confidentialité');
    const timezone = interaction.options.getString('fuseau');
    const compact = interaction.options.getBoolean('mode-compact');

    if (dm !== null) patch.dmNotifications = dm;
    if (locale) patch.locale = locale;
    if (privacy) patch.privacy = privacy;
    if (compact !== null) patch.compactMode = compact;
    if (timezone) {
      if (!isValidTimezone(timezone)) {
        throw gameError('target_invalid', `Fuseau horaire inconnu : \`${timezone}\`.`, {
          hint: 'Exemples : Europe/Paris, America/Montreal, Indian/Reunion.',
        });
      }
      patch.timezone = timezone;
    }

    if (Object.keys(patch).length > 0) {
      await playerRepo.updateSettings(context.player.id, patch);
    }

    const settings = await playerRepo.getSettings(context.player.id);
    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '⚙️ Vos paramètres',
          description:
            Object.keys(patch).length > 0 ? '✅ Préférences mises à jour.' : 'Voici vos réglages actuels.',
          color: COLORS.info,
          fields: [
            {
              name: '🔔 Notifications',
              value: [
                `Messages privés : **${settings?.dmNotifications ? 'activés' : 'désactivés'}**`,
                `Cultures prêtes : ${settings?.notifyCrops ? '✅' : '❌'}`,
                `Animaux affamés : ${settings?.notifyAnimals ? '✅' : '❌'}`,
                `Rappel quotidien : ${settings?.dailyReminder ? '✅' : '❌'}`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🌍 Affichage',
              value: [
                `Langue : **${settings?.locale ?? 'fr'}**`,
                `Fuseau : **${settings?.timezone ?? 'Europe/Paris'}**`,
                `Mode compact : ${settings?.compactMode ? '✅' : '❌'}`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🔒 Confidentialité',
              value: [
                `Ferme visible par : **${settings?.privacy === 'private' ? 'personne' : settings?.privacy === 'coop_only' ? 'ma coopérative' : 'tout le monde'}**`,
                `Échanges : ${settings?.allowTrades ? '✅ autorisés' : '❌ refusés'}`,
              ].join('\n'),
              inline: false,
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['notifyCrops'],
            label: 'Alerte cultures',
            emoji: '🌱',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['notifyAnimals'],
            label: 'Alerte animaux',
            emoji: '🐄',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['dailyReminder'],
            label: 'Rappel quotidien',
            emoji: '📅',
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const prestige: Command = {
  category: 'progression',
  cooldown: { seconds: 30, bucket: 'prestige' },
  data: new SlashCommandBuilder()
    .setName('prestige')
    .setDescription('Renaissance : repartez de zéro contre des bonus permanents')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { eligibility, plan } = await miscService.previewPrestige(context.player);

    if (!eligibility.eligible) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '🌟 Prestige',
            description: `${eligibility.reason}\n\nLe prestige devient disponible au **niveau ${eligibility.requiredLevel}**.`,
            color: COLORS.warning,
          }),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '🌟 Renaissance — confirmation requise',
          description:
            '**Cette action est irréversible.** Voici exactement ce qui se passera :',
          color: COLORS.warning,
          fields: [
            {
              name: '✅ Vous conservez',
              value: [
                `🏗️ Tous vos bâtiments`,
                `🗺️ **${plan.plotsKept}** parcelles (50 %)`,
                `💎 Toutes vos gemmes`,
                `🪙 ${formatCoins(plan.coinsKept)} (5 %) + ${formatCoins(plan.startingCoins)} de départ`,
                `🎨 Cosmétiques, outils et objets d'événement`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '❌ Vous perdez',
              value: [
                `⭐ Niveau et XP (retour au niveau 1)`,
                `🐄 Tous vos animaux`,
                `🌱 Les cultures en cours`,
                `📦 Le reste de l'inventaire`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🎁 Gain permanent',
              value: `Multiplicateur de rendement et d'XP : **×${plan.newMultiplier.toFixed(2)}** (prestige ${plan.newPrestige})\n+${plan.pointsGained} points de prestige`,
              inline: false,
            },
          ],
        }),
      ],
      components: [
        confirmRow({
          namespace: 'prestige',
          action: 'confirm',
          ownerId: interaction.user.id,
          confirmLabel: 'Renaître',
          danger: true,
        }),
      ],
    });
  },
};

export const commands: Command[] = [profil, stats, solde, parametres, prestige];
export { ButtonStyle };
