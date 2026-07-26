import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { harvestKeyOf, seedKeyOf } from '../config';
import { farmView, plotsView } from '../framework/views';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import * as farmService from '../services/farm.service';
import { qualityDistribution } from '../game/quality';
import { expectedYield } from '../game/harvest';
import { NEUTRAL_MODIFIERS } from '../game/modifiers';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatDuration,
  formatNumber,
  mutationIcon,
  qualityIcon,
  qualityLabel,
  rarityLabel,
  truncate,
} from '../utils/format';
import type { AutocompleteContext, Command, CommandContext } from '../types';

/**
 * Commandes d'agriculture : le cœur de la boucle de jeu.
 *
 * Chaque commande suit le même contrat : différer la réponse si l'action peut
 * dépasser 2 secondes (rendu d'image, transaction), déléguer TOUTE la logique au
 * service, puis composer l'affichage. Aucune règle de jeu ici.
 */

// ---------------------------------------------------------------------------
// /farm
// ---------------------------------------------------------------------------

const ferme: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('farm')
    .setDescription("Show your farm — or another farmer's")
    .addUserOption((option) =>
      option.setName('user').setDescription('The farmer to watch').setRequired(false),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user');

    if (target && target.id !== interaction.user.id) {
      // Consultation de la ferme d'un autre : on délègue à /visit, qui gère
      // la confidentialité et la récompense de visite.
      const { visitFarm } = await import('./social');
      await visitFarm(interaction, context, target);
      return;
    }

    const view = await farmView(context, {
      targetName: interaction.user.displayName,
      avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
    });
    await interaction.editReply(view);
  },
};

// ---------------------------------------------------------------------------
// /plant
// ---------------------------------------------------------------------------

const planter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('plant')
    .setDescription('Sow seeds on your plots')
    .addStringOption((option) =>
      option
        .setName('seed')
        .setDescription('The crop to plant')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise fills empty ones)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('quantity')
        .setDescription('How many plots to plant (default: 1)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const cropKey = interaction.options.getString('seed', true);
    const slot = interaction.options.getInteger('plot') ?? undefined;
    const quantity = interaction.options.getInteger('quantity') ?? 1;

    const result = await farmService.plant(context.player, {
      cropKey,
      slot,
      quantity,
      coopLevel: 0,
    });

    const embed = successEmbed(
      `${result.emoji} ${result.cropName} planted`,
      [
        `**${result.slots.length}** plot(s) planted: ${result.slots.map((value) => `\`${value}\``).join(' ')}`,
        `🌱 Harvest ${discordTimestamp(result.readyAt, 'R')} (${discordTimestamp(result.readyAt, 't')})`,
        result.waterNeeded > 0 ? `💧 ${result.waterNeeded} watering(s) expected` : '',
        result.offSeason
          ? '⚠️ *Out of season: slower growth and reduced yield. A greenhouse would cancel this penalty.*'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, context: AutocompleteContext): Promise<void> {
    const query = interaction.options.getFocused().toString();
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const crops = await farmService.plantableCrops(context.playerId, 60, query, context.locale);
    await interaction.respond(
      crops.map((entry) => ({
        name: truncate(
          `${entry.crop.emoji} ${entry.crop.name} — ${entry.owned} seed(s), ${Math.round(entry.crop.growthSeconds / 60)} min`,
          100,
        ),
        value: entry.crop.key,
      })),
    );
  },
};

// ---------------------------------------------------------------------------
// /harvest
// ---------------------------------------------------------------------------

const recolter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('harvest')
    .setDescription('Harvest the crops that are ready')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise: everything ready)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;

    const summary = await farmService.harvest(context.player, { slot, all: slot === undefined });
    await interaction.editReply({ embeds: [buildHarvestEmbed(summary)] });
  },
};

export function buildHarvestEmbed(summary: farmService.HarvestSummary) {
  const lines = summary.plots.map((plot) => {
    const quality =
      plot.result.quality === 'normal' ? '' : ` ${qualityIcon(plot.result.quality)} ${qualityLabel(plot.result.quality)}`;
    const mutation = plot.result.mutation === 'none' ? '' : ` ${mutationIcon(plot.result.mutation)} **${plot.result.mutation}**`;
    const regrow = plot.regrew && plot.nextReadyAt ? ` 🔁 regrows ${discordTimestamp(plot.nextReadyAt, 'R')}` : '';
    return `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.emoji} **${plot.result.quantity}× ${plot.cropName}**${quality}${mutation} — ~${formatCoins(plot.result.totalValue, true)}${regrow}`;
  });

  const embed = baseEmbed({
    title: '🧺 Harvest',
    description: lines.join('\n') || 'Nothing harvested.',
    color: COLORS.success,
    fields: [
      {
        name: 'Total',
        value: `**${formatNumber(summary.totalQuantity)}** unit(s) • estimated value **${formatCoins(summary.estimatedValue)}** • **${formatNumber(summary.xpGained)}** ✨`,
      },
    ],
  });

  if (summary.witheredSlots.length > 0) {
    embed.addFields({
      name: '💀 Withered crops',
      value: `Plots ${summary.witheredSlots.join(', ')} — harvest sooner next time!`,
    });
  }
  if (summary.seedsRecovered.length > 0) {
    embed.addFields({
      name: '🫧 Seed store',
      value: summary.seedsRecovered
        .map((seed) => `${seed.quantity}× ${seed.itemKey.replace('seed_', '')}`)
        .join(', '),
    });
  }
  if (summary.levelUp) {
    embed.addFields({
      name: '🎉 Level up!',
      value: `You reached **level ${summary.levelUp.level}** (+${summary.levelUp.levelsGained})\nReward: ${formatCoins(summary.levelUp.rewardCoins)}${summary.levelUp.rewardGems > 0 ? ` + ${summary.levelUp.rewardGems} 💎` : ''}`,
    });
  }
  appendTracking(embed, summary.tracking);

  return embed;
}

// ---------------------------------------------------------------------------
// /water
// ---------------------------------------------------------------------------

const arroser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('water')
    .setDescription('Water your thirsty crops')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('A specific plot (otherwise: as many as possible)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;
    const result = await farmService.water(context.player, { slot, all: slot === undefined });

    if (result.freeRain) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '🌧️ It is raining!',
            description:
              'All your plots are watered for free today. Save your energy.',
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const embed = successEmbed(
      '💧 Watering',
      `**${result.watered}** plot(s) watered.${result.toolPlots > 1 ? `\n*Your watering can covers ${result.toolPlots} plots per action.*` : ''}`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /fertilize, /weed, /treat
// ---------------------------------------------------------------------------

const fertiliser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('fertilize')
    .setDescription('Apply fertilizer to your plots')
    .addStringOption((option) =>
      option
        .setName('fertilizer')
        .setDescription("The fertilizer type")
        .setRequired(true)
        .addChoices(
          { name: '💩 Basic fertilizer (+15 fertility, +10% yield)', value: 'fertilizer_basic' },
          { name: '🧪 Quality fertilizer (+25 fertility, +15% quality)', value: 'fertilizer_quality' },
          { name: '✨ Deluxe fertilizer (+40 fertility, +25% both)', value: 'fertilizer_deluxe' },
        ),
    )
    .addIntegerOption((option) =>
      option.setName('plot').setDescription('A specific plot').setMinValue(1).setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const fertilizerKey = interaction.options.getString('fertilizer', true);
    const slot = interaction.options.getInteger('plot') ?? undefined;

    const result = await farmService.fertilize(context.player, { fertilizerKey, slot, all: !slot });
    const embed = successEmbed(
      '🧪 Fertilizing',
      `${result.fertilizer} applied to **${result.slots.length}** plot(s).\nSoil fertility: **${result.fertilityAfter}%**`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

const desherber: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('weed')
    .setDescription('Pull weeds and collect compost material')
    .addIntegerOption((option) =>
      option.setName('plot').setDescription('A specific plot').setMinValue(1).setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot') ?? undefined;
    const result = await farmService.weed(context.player, { slot, all: !slot });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🌿 Weeding',
          `**${result.slots.length}** plot(s) cleared.\nYou collect **${result.weedsCollected}× 🌱 weeds** — enough to make compost at the workshop.`,
        ),
      ],
    });
  },
};

const traiter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('treat')
    .setDescription('Treat a plot infested with pests')
    .addIntegerOption((option) =>
      option
        .setName('plot')
        .setDescription('The plot to treat')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('plot', true);
    const result = await farmService.treatPest(context.player, { slot });

    const { PEST_LABELS } = await import('../game/plot');
    const pest = PEST_LABELS[result.pestType];

    const embed = successEmbed(
      `${pest.emoji} ${pest.name} cleared`,
      `Plot **${result.slot}** treated.${result.usedItem ? '\n🧯 An organic treatment was consumed.' : '\n*Without an organic treatment, the job costs more energy.*'}`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /plots, /buy-plot
// ---------------------------------------------------------------------------

const parcelles: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('plots')
    .setDescription('Detailed view of your plots and their soil')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await plotsView(context, 1));
  },
};

const acheterParcelle: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buy-plot')
    .setDescription('Unlock the next plot of your farm')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await farmService.buyPlot(context.player);

    const embed = successEmbed(
      '🗺️ New plot!',
      [
        `Plot **${result.slot}** unlocked for ${formatCoins(result.cost)}.`,
        `Your farm is now **${result.grid.width}×${result.grid.height}** (${result.unlockedPlots} plots).`,
        result.nextCost > 0 ? `Next plot: ${formatCoins(result.nextCost)}` : '🏆 Estate complete!',
      ].join('\n'),
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /crops — encyclopédie
// ---------------------------------------------------------------------------

const cultures: Command = {
  category: 'agriculture',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('crops')
    .setDescription('Crop encyclopedia')
    .addStringOption((option) =>
      option
        .setName('rarity')
        .setDescription('Filter by rarity')
        .addChoices(
          { name: 'Common', value: 'common' },
          { name: 'Uncommon', value: 'uncommon' },
          { name: 'Rare', value: 'rare' },
          { name: 'Epic', value: 'epic' },
          { name: 'Legendary', value: 'legendary' },
          { name: 'Mythic', value: 'mythic' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('season')
        .setDescription('Filter by season')
        .addChoices(
          { name: 'Spring', value: 'spring' },
          { name: 'Summer', value: 'summer' },
          { name: 'Autumn', value: 'autumn' },
          { name: 'Winter', value: 'winter' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const rarity = interaction.options.getString('rarity');
    const season = interaction.options.getString('season');

    const crops = context.config.cropList.filter((crop) => {
      if (!crop.enabled) return false;
      if (rarity && crop.rarity !== rarity) return false;
      if (season && !crop.seasons.includes(season as never)) return false;
      return true;
    });

    const lines = crops.slice(0, 25).map((crop) => {
      const profit = crop.sellPrice * crop.baseYield - crop.seedPrice;
      const perHour = Math.round((profit / crop.growthSeconds) * 3_600);
      const locked = crop.requiredLevel > context.player.level ? '🔒 ' : '';
      return [
        `${locked}${crop.emoji} **${crop.name}** — ${rarityLabel(crop.rarity)} • lv. ${crop.requiredLevel}`,
        `   🌱 ${formatNumber(crop.seedPrice)} ${COIN} → 🧺 ${crop.baseYield}× ${formatNumber(crop.sellPrice)} ${COIN} • ⏳ ${formatDuration(crop.growthSeconds * 1000)} • **~${formatNumber(perHour)} ${COIN}/h/plot**${crop.regrowCycles > 0 ? ` • 🔁 ${crop.regrowCycles}` : ''}`,
      ].join('\n');
    });

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🌾 Crop encyclopedia',
          description: lines.join('\n') || 'No crop matches this filter.',
          color: COLORS.primary,
          footer: `${crops.length} crop(s) • hourly yield assumes 70% soil, in season`,
        }),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Utilitaires partagés
// ---------------------------------------------------------------------------

/** Ajoute les quêtes/succès débloqués sous un embed d'action. */
export function appendTracking(
  embed: ReturnType<typeof baseEmbed>,
  tracking: { completedQuests: Array<{ title: string }>; unlockedAchievements: Array<{ name: string }>; completedCoopObjectives: string[] },
): void {
  const parts: string[] = [];
  if (tracking.completedQuests.length > 0) {
    parts.push(
      `📋 Quest(s) completed: ${tracking.completedQuests.map((quest) => `**${quest.title}**`).join(', ')} — \`/quests\` to claim`,
    );
  }
  if (tracking.unlockedAchievements.length > 0) {
    parts.push(
      `🏆 Achievement(s) unlocked: ${tracking.unlockedAchievements.map((entry) => `**${entry.name}**`).join(', ')}`,
    );
  }
  if (tracking.completedCoopObjectives.length > 0) {
    parts.push(`🤝 Co-op objective reached: **${tracking.completedCoopObjectives.join(', ')}**`);
  }
  if (parts.length > 0) {
    embed.addFields({ name: '​', value: parts.join('\n') });
  }
}

export const commands: Command[] = [
  ferme,
  planter,
  recolter,
  arroser,
  fertiliser,
  desherber,
  traiter,
  parcelles,
  acheterParcelle,
  cultures,
];

export { MessageFlags, harvestKeyOf, seedKeyOf, qualityDistribution, expectedYield, NEUTRAL_MODIFIERS };
