import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, linkButton, row, successEmbed } from '../framework/ui';
import { questsView } from '../framework/views';
import * as progressionService from '../services/progression.service';
import * as miscService from '../services/misc.service';
import { describeItems } from '../services/inventory.service';
import { peek } from '../framework/cooldown';
import {
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  progressBar,
  truncate,
} from '../utils/format';
import type { Command } from '../types';

/** Quêtes, succès, passe saisonnier, récompense quotidienne et vote. */

const quetes: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('quests')
    .setDescription('Your active quests and contracts')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Filter')
        .addChoices(
          { name: '📅 Daily', value: 'daily' },
          { name: '🗓️ Weekly', value: 'weekly' },
          { name: '📖 Story', value: 'story' },
          { name: '📦 Contracts', value: 'contract' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const type = interaction.options.getString('type') as
      | 'daily'
      | 'weekly'
      | 'story'
      | 'contract'
      | null;
    await interaction.editReply(await questsView(context, type ?? undefined));
  },
};

const rerollQuete: Command = {
  category: 'progression',
  cooldown: { seconds: 5, bucket: 'reroll' },
  data: new SlashCommandBuilder()
    .setName('reroll-quest')
    .setDescription('Swap a daily quest for another one')
    .addStringOption((option) =>
      option.setName('quest').setDescription('The quest to reroll').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await progressionService.rerollQuest(
      context.player,
      interaction.options.getString('quest', true),
    );

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🔄 Quest rerolled',
          [
            result.usedToken
              ? '🎫 A reroll token was used.'
              : `Cost: ${formatCoins(result.cost)}`,
            '',
            `**${result.newQuest.title}**`,
            result.newQuest.description,
            `Goal: 0/${result.newQuest.required}`,
          ].join('\n'),
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const quests = await progressionService.listQuests(
      { id: context.playerId, level: 1 },
      { type: 'daily' },
    );
    await interaction.respond(
      quests
        .filter((quest) => quest.status === 'active')
        .slice(0, 25)
        .map((quest) => ({
          name: truncate(`${quest.title} (${quest.progress}/${quest.required})`, 100),
          value: quest.id,
        })),
    );
  },
};

const succes: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('achievements')
    .setDescription('Your achievements and their progress')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter')
        .addChoices(
          { name: '🌾 Farming', value: 'agriculture' },
          { name: '🐄 Livestock', value: 'elevage' },
          { name: '🛠️ Crafting', value: 'artisanat' },
          { name: '💰 Economy', value: 'economie' },
          { name: '⭐ Progression', value: 'progression' },
          { name: '🤝 Social', value: 'social' },
          { name: '🔥 Loyalty', value: 'fidelite' },
          { name: '🗺️ Estate', value: 'domaine' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const category = interaction.options.getString('category') ?? undefined;
    const achievements = await progressionService.listAchievements(context.player.id, category);

    const unlocked = achievements.filter((entry) => entry.unlocked);
    const claimable = unlocked.filter((entry) => !entry.claimed);

    const lines = achievements.slice(0, 18).map((entry) => {
      const progress = Number(entry.progress ?? 0);
      const target = Number(entry.conditionAmount);
      const status = entry.unlocked
        ? entry.claimed
          ? '✅'
          : '🎁 **to claim**'
        : `${progressBar(progress, target, 8)} ${formatCompact(progress)}/${formatCompact(target)}`;
      return `${entry.icon} **${entry.name}** — ${status}\n   *${entry.description}*`;
    });

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '🏆 Achievements',
          description: lines.join('\n') || 'No achievement in this category.',
          color: COLORS.gold,
          footer: `${unlocked.length}/${achievements.length} unlocked${claimable.length > 0 ? ` • ${claimable.length} reward(s) to claim` : ''}`,
        }),
      ],
      components:
        claimable.length > 0
          ? [
              row(
                button({
                  namespace: 'achv',
                  action: 'claim_all',
                  ownerId: interaction.user.id,
                  label: `Claim (${claimable.length})`,
                  emoji: '🎁',
                  style: ButtonStyle.Success,
                }),
              ),
            ]
          : [],
    });
  },
};

const passe: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('pass')
    .setDescription('Your free season pass')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const pass = await progressionService.getSeasonPass(context.player.id);

    if (!pass) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '🎟️ Season pass',
            description: 'No active pass right now. The next one arrives when the season changes!',
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const nextTiers = pass.tiers
      .filter((tier) => tier.tier > pass.tier)
      .slice(0, 3)
      .map((tier) => {
        const free = tier.free as { coins?: number; gems?: number; items?: Array<{ itemKey: string; quantity: number }> };
        return `**Tier ${tier.tier}** — ${[
          free.coins ? `${formatCompact(free.coins)} 🪙` : '',
          free.gems ? `${free.gems} 💎` : '',
          free.items ? describeItems(free.items) : '',
        ]
          .filter(Boolean)
          .join(' • ')}`;
      });

    const claimable = pass.tiers.filter(
      (tier) => tier.tier <= pass.tier && !pass.claimedTiers.includes(tier.tier),
    );

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `🎟️ ${pass.name}`,
          description: [
            `Tier **${pass.tier}**/${pass.maxTier}`,
            `${progressBar(pass.passXp % pass.xpPerTier, pass.xpPerTier, 14)} ${formatNumber(pass.passXp % pass.xpPerTier)}/${formatNumber(pass.xpPerTier)} XP de passe`,
            `Season ends ${discordTimestamp(pass.endsAt, 'R')}`,
            '',
            pass.premium
              ? '⭐ **Premium track unlocked** (thanks for voting!)'
              : `⭐ Premium track: vote for the bot ${context.balance.seasonPass.premiumVotesRequired} times with \`/vote\` to unlock it — never real money.`,
          ].join('\n'),
          color: COLORS.xp,
          fields: [
            {
              name: '🎁 To claim',
              value:
                claimable.length > 0
                  ? `**${claimable.length}** tier(s) available`
                  : 'No tier pending.',
            },
            { name: '⏭️ Next tiers', value: nextTiers.join('\n') || 'Pass completed 🏆' },
          ],
        }),
      ],
      components:
        claimable.length > 0
          ? [
              row(
                button({
                  namespace: 'pass',
                  action: 'claim_all',
                  ownerId: interaction.user.id,
                  label: `Claim ${claimable.length} tier(s)`,
                  emoji: '🎁',
                  style: ButtonStyle.Success,
                }),
              ),
            ]
          : [],
    });
  },
};

const daily: Command = {
  category: 'progression',
  cooldown: { seconds: 0, bucket: 'daily' },
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily reward')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await progressionService.claimDaily(context.player);

    await interaction.editReply({
      embeds: [
        successEmbed(
          `📅 Daily reward — day ${result.streak}`,
          [
            `${formatCoins(result.coins)} • ${formatNumber(result.xp)} ✨${result.gems > 0 ? ` • ${result.gems} 💎` : ''}`,
            result.items.length > 0 ? `🎁 Bonus : ${describeItems(result.items)}` : '',
            '',
            result.streakBroken
              ? '💔 Your streak was reset. Come back every day to grow it!'
              : result.usedFreeze
                ? '🧊 A freeze token saved your streak.'
                : `🔥 Streak of **${result.streak}** day(s) — best: ${result.longestStreak}`,
            `Next reward ${discordTimestamp(result.nextClaimAt, 'R')}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ],
      components: [
        row(
          button({
            namespace: 'quest',
            action: 'open',
            ownerId: interaction.user.id,
            label: 'My quests',
            emoji: '📋',
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'My farm',
            emoji: '🌾',
          }),
        ),
      ],
    });
  },
};

const vote: Command = {
  category: 'progression',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Vote for the bot and claim your gems')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const info = miscService.voteInfo();
    const cooldown = await peek(context.player.id, 'vote');

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🗳️ Vote for Harvester',
          description: [
            `Each vote earns you **${info.rewardGems} 💎** and **${formatCoins(info.rewardCoins)}**.`,
            `On weekends, rewards are **×${info.weekendMultiplier}**.`,
            `You can vote every **${info.cooldownHours} h**.`,
            '',
            cooldown.active
              ? `⏳ Next vote available ${discordTimestamp(cooldown.retryAt, 'R')}`
              : '✅ You can vote now!',
            '',
            '*Gems cannot be bought with real money: voting is the fastest way to get them.*',
          ].join('\n'),
          color: COLORS.info,
        }),
      ],
      components: [row(linkButton('Vote on top.gg', info.url, '🗳️'))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [quetes, rerollQuete, succes, passe, daily, vote];
