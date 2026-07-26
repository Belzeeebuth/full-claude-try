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
          '🔄 Quête remplacée',
          [
            result.usedToken
              ? '🎫 Un jeton de relance a été utilisé.'
              : `Coût : ${formatCoins(result.cost)}`,
            '',
            `**${result.newQuest.title}**`,
            result.newQuest.description,
            `Objectif : 0/${result.newQuest.required}`,
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
          : '🎁 **à réclamer**'
        : `${progressBar(progress, target, 8)} ${formatCompact(progress)}/${formatCompact(target)}`;
      return `${entry.icon} **${entry.name}** — ${status}\n   *${entry.description}*`;
    });

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '🏆 Succès',
          description: lines.join('\n') || 'Aucun succès dans cette catégorie.',
          color: COLORS.gold,
          footer: `${unlocked.length}/${achievements.length} débloqués${claimable.length > 0 ? ` • ${claimable.length} récompense(s) à réclamer` : ''}`,
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
                  label: `Réclamer (${claimable.length})`,
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
            title: '🎟️ Passe saisonnier',
            description: 'Aucun passe actif pour le moment. Le prochain arrive au changement de saison !',
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
        return `**Palier ${tier.tier}** — ${[
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
            `Palier **${pass.tier}**/${pass.maxTier}`,
            `${progressBar(pass.passXp % pass.xpPerTier, pass.xpPerTier, 14)} ${formatNumber(pass.passXp % pass.xpPerTier)}/${formatNumber(pass.xpPerTier)} XP de passe`,
            `Fin de saison ${discordTimestamp(pass.endsAt, 'R')}`,
            '',
            pass.premium
              ? '⭐ **Piste premium débloquée** (merci pour votre vote !)'
              : `⭐ Piste premium : votez pour le bot ${context.balance.seasonPass.premiumVotesRequired} fois avec \`/vote\` pour la débloquer — jamais d'argent réel.`,
          ].join('\n'),
          color: COLORS.xp,
          fields: [
            {
              name: '🎁 À réclamer',
              value:
                claimable.length > 0
                  ? `**${claimable.length}** palier(s) disponible(s)`
                  : 'Aucun palier en attente.',
            },
            { name: '⏭️ Prochains paliers', value: nextTiers.join('\n') || 'Passe terminé 🏆' },
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
                  label: `Réclamer ${claimable.length} palier(s)`,
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
          `📅 Récompense quotidienne — jour ${result.streak}`,
          [
            `${formatCoins(result.coins)} • ${formatNumber(result.xp)} ✨${result.gems > 0 ? ` • ${result.gems} 💎` : ''}`,
            result.items.length > 0 ? `🎁 Bonus : ${describeItems(result.items)}` : '',
            '',
            result.streakBroken
              ? '💔 Votre série a été réinitialisée. Revenez chaque jour pour la faire grandir !'
              : result.usedFreeze
                ? '🧊 Un jeton de gel a sauvé votre série.'
                : `🔥 Série de **${result.streak}** jour(s) — record : ${result.longestStreak}`,
            `Prochaine récompense ${discordTimestamp(result.nextClaimAt, 'R')}`,
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
            label: 'Mes quêtes',
            emoji: '📋',
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'Ma ferme',
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
          title: '🗳️ Votez pour Harvester',
          description: [
            `Chaque vote vous rapporte **${info.rewardGems} 💎** et **${formatCoins(info.rewardCoins)}**.`,
            `Le week-end, les récompenses sont **×${info.weekendMultiplier}**.`,
            `Vous pouvez voter toutes les **${info.cooldownHours} h**.`,
            '',
            cooldown.active
              ? `⏳ Prochain vote possible ${discordTimestamp(cooldown.retryAt, 'R')}`
              : '✅ Vous pouvez voter maintenant !',
            '',
            '*Les gemmes ne s\'achètent pas avec de l\'argent réel : voter est la façon la plus rapide d\'en obtenir.*',
          ].join('\n'),
          color: COLORS.info,
        }),
      ],
      components: [row(linkButton('Voter sur top.gg', info.url, '🗳️'))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [quetes, rerollQuete, succes, passe, daily, vote];
