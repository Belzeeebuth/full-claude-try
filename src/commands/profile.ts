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
    .setName('profile')
    .setDescription('Illustrated profile card')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to show'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const profile = await getProfile(target.id);
    if (!profile) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

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
        `**Level ${profile.user.level}** — ${progressBar(profile.user.xp, profile.xpForNext || 1, 12)} ${formatCompact(profile.user.xp)}/${formatCompact(profile.xpForNext)} XP`,
        `${COIN} ${formatNumber(profile.user.coins)} • ${GEM} ${formatNumber(profile.user.gems)} • 🏦 ${formatCompact(profile.bankBalance)}`,
        `⚡ ${profile.energy.current}/${profile.energy.max}${profile.energy.fullAt ? ` (plein ${discordTimestamp(profile.energy.fullAt, 'R')})` : ''}`,
        profile.coop ? `🤝 **${profile.coop.name}** [${profile.coop.tag}] — lv. ${profile.coop.level}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      color: COLORS.primary,
      // Image laissée en pièce jointe libre, hors de l'embed : voir la note
      // détaillée dans `farmView` (src/framework/views.ts). Un embed rend
      // l'image à sa propre largeur (~400 px) ; celle-ci en fait 900 px.
    });

    if (!image.attachment) {
      embed.addFields(
        { name: '🌾 Harvests', value: formatNumber(profile.user.totalHarvests), inline: true },
        { name: '🐄 Animals raised', value: formatNumber(profile.user.totalAnimalsRaised), inline: true },
        { name: '🛠️ Items crafted', value: formatNumber(profile.user.totalCrafts), inline: true },
        { name: '🗺️ Plots', value: `${profile.plotsUnlocked}/64`, inline: true },
        { name: '🔥 Streak', value: `${profile.streak} day(s)`, inline: true },
        { name: '🏆 Achievements', value: String(profile.achievementsUnlocked), inline: true },
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
            label: 'My farm',
            emoji: '🌾',
          }),
          button({
            namespace: 'profile',
            action: 'stats',
            ownerId: interaction.user.id,
            params: [target.id],
            label: 'Stats',
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
    .setDescription('Detailed statistics')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to analyse'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') ?? interaction.user;
    const data = await miscService.playerStats(target.id);
    if (!data) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `📊 Stats for ${data.user.displayName ?? data.user.username}`,
          color: COLORS.info,
          fields: [
            {
              name: '🌾 Agriculture',
              value: [
                `Harvests: **${formatNumber(data.user.totalHarvests)}**`,
                `Seeds planted: **${formatNumber(data.user.totalPlanted)}**`,
                `Waterings: **${formatNumber(data.user.totalWatered)}**`,
                `Best harvest: **${formatCoins(data.user.bestHarvestValue, true)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🐄 Livestock & crafting',
              value: [
                `Animals raised: **${formatNumber(data.user.totalAnimalsRaised)}**`,
                `Alive: **${data.animalsAlive}**`,
                `Items crafted: **${formatNumber(data.user.totalCrafts)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '💰 Economy',
              value: [
                `Earned: **${formatCoins(data.user.totalCoinsEarned, true)}**`,
                `Spent: **${formatCoins(data.user.totalCoinsSpent, true)}**`,
                `Balance: **${formatCoins(data.user.coins, true)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🤝 Social & loyalty',
              value: [
                `Helping hands given: **${formatNumber(data.user.totalHelpGiven)}**`,
                `Current streak: **${data.streak}** d (best: ${data.longestStreak})`,
                `Commands used: **${formatNumber(data.user.commandsUsed)}**`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🏅 Leaderboards',
              value: [
                data.ranks.wealth ? `Richesse : **#${data.ranks.wealth.rank}**` : '',
                data.ranks.level ? `Experience: **#${data.ranks.level.rank}**` : '',
                data.ranks.harvests ? `Harvests: **#${data.ranks.harvests.rank}**` : '',
              ]
                .filter(Boolean)
                .join('\n') || '—',
              inline: true,
            },
            {
              name: '📦 Divers',
              value: [
                `Inventory: **${formatNumber(data.inventoryTotal)}** items`,
                `Farm created on **${data.user.createdAt.toLocaleDateString('en-US')}**`,
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
    .setName('balance')
    .setDescription('Show your balance')
    .addUserOption((option) => option.setName('user').setDescription('The farmer to look up'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const user = await playerRepo.findUserByDiscordId(target.id);
    if (!user) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }
    const bank = await playerRepo.getBankAccount(user.id);

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: `💰 ${user.displayName ?? user.username}’s balance`,
          description: [
            `${COIN} **${formatNumber(user.coins)}** coins on hand`,
            `${GEM} **${formatNumber(user.gems)}** gems`,
            `🏦 **${formatNumber(bank?.balance ?? 0)}** in the bank (capacity ${formatCompact(bank?.capacity ?? 0)})`,
            '',
            `Total net worth: **${formatCoins(user.coins + (bank?.balance ?? 0))}**`,
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
    .setName('settings')
    .setDescription('Your preferences: notifications, language, privacy')
    .addBooleanOption((option) =>
      option.setName('dm-notifications').setDescription('Receive reminders by direct message'),
    )
    .addStringOption((option) =>
      option
        .setName('language')
        .setDescription('Interface language')
        .addChoices({ name: 'Français', value: 'fr' }, { name: 'English', value: 'en' }),
    )
    .addStringOption((option) =>
      option
        .setName('privacy')
        .setDescription('Who can see your farm?')
        .addChoices(
          { name: 'Everyone', value: 'public' },
          { name: 'My co-op', value: 'coop_only' },
          { name: 'Nobody', value: 'private' },
        ),
    )
    .addStringOption((option) =>
      option.setName('timezone').setDescription('Time zone (e.g. Europe/Paris)').setMaxLength(48),
    )
    .addBooleanOption((option) =>
      option.setName('compact-mode').setDescription('Disable generated images'),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const patch: Record<string, unknown> = {};
    const dm = interaction.options.getBoolean('dm-notifications');
    const locale = interaction.options.getString('language');
    const privacy = interaction.options.getString('privacy');
    const timezone = interaction.options.getString('timezone');
    const compact = interaction.options.getBoolean('compact-mode');

    if (dm !== null) patch.dmNotifications = dm;
    if (locale) patch.locale = locale;
    if (privacy) patch.privacy = privacy;
    if (compact !== null) patch.compactMode = compact;
    if (timezone) {
      if (!isValidTimezone(timezone)) {
        throw gameError('target_invalid', context.t('profile.unknown_timezone', { timezone }), {
          hint: context.t('profile.unknown_timezone_hint'),
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
          title: '⚙️ Your settings',
          description:
            Object.keys(patch).length > 0 ? '✅ Preferences updated.' : 'Here are your current settings.',
          color: COLORS.info,
          fields: [
            {
              name: '🔔 Notifications',
              value: [
                `Direct messages: **${settings?.dmNotifications ? 'enabled' : 'disabled'}**`,
                `Crops ready: ${settings?.notifyCrops ? '✅' : '❌'}`,
                `Hungry animals: ${settings?.notifyAnimals ? '✅' : '❌'}`,
                `Daily reminder: ${settings?.dailyReminder ? '✅' : '❌'}`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🌍 Display',
              value: [
                `Language: **${settings?.locale ?? 'fr'}**`,
                `Time zone: **${settings?.timezone ?? 'Europe/Paris'}**`,
                `Mode compact : ${settings?.compactMode ? '✅' : '❌'}`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🔒 Privacy',
              value: [
                `Farm visible to: **${settings?.privacy === 'private' ? 'nobody' : settings?.privacy === 'coop_only' ? 'my co-op' : 'everyone'}**`,
                `Trades: ${settings?.allowTrades ? '✅ allowed' : '❌ refused'}`,
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
            label: 'Crop alerts',
            emoji: '🌱',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['notifyAnimals'],
            label: 'Animal alerts',
            emoji: '🐄',
          }),
          button({
            namespace: 'settings',
            action: 'toggle',
            ownerId: interaction.user.id,
            params: ['dailyReminder'],
            label: 'Daily reminder',
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
    .setDescription('Rebirth: start over for permanent bonuses')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { eligibility, plan } = await miscService.previewPrestige(context.player);

    if (!eligibility.eligible) {
      const reason = context.t(
        eligibility.reasonKey ?? 'errors.player.prestige_unavailable',
        eligibility.reasonParams,
      );
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: `🌟 ${context.t('progression.prestige_locked_title')}`,
            description: context.t('progression.prestige_locked_body', {
              reason,
              level: eligibility.requiredLevel,
            }),
            color: COLORS.warning,
          }),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '🌟 Rebirth — confirmation required',
          description:
            '**This cannot be undone.** Here is exactly what will happen:',
          color: COLORS.warning,
          fields: [
            {
              name: '✅ You keep',
              value: [
                `🏗️ All your buildings`,
                `🗺️ **${plan.plotsKept}** plots (50 %)`,
                `💎 All your gems`,
                `🪙 ${formatCoins(plan.coinsKept)} (5%) + ${formatCoins(plan.startingCoins)} to start over`,
                `🎨 Cosmetics, tools and event items`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '❌ You lose',
              value: [
                `⭐ Level and XP (back to level 1)`,
                `🐄 All your animals`,
                `🌱 Crops currently growing`,
                `📦 The rest of your inventory`,
              ].join('\n'),
              inline: true,
            },
            {
              name: '🎁 Gain permanent',
              value: `Yield and XP multiplier: **×${plan.newMultiplier.toFixed(2)}** (prestige ${plan.newPrestige})\n+${plan.pointsGained} prestige points`,
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
          confirmLabel: 'Rebirth',
          danger: true,
        }),
      ],
    });
  },
};

export const commands: Command[] = [profil, stats, solde, parametres, prestige];
export { ButtonStyle };
