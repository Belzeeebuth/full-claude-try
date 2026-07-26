import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { buildingsView, productionView } from '../framework/views';
import * as craftService from '../services/craft.service';
import { discordTimestamp, formatCoins, formatNumber, truncate } from '../utils/format';
import { appendTracking } from './farm';
import type { Command } from '../types';

/** Artisanat, recettes, file de production et bâtiments. */

const crafter: Command = {
  category: 'inventaire',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('craft')
    .setDescription('Start a production run in one of your buildings')
    .addStringOption((option) =>
      option.setName('recipe').setDescription('The recipe').setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('Number of batches').setMinValue(1).setMaxValue(20),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await craftService.craft(context.player, {
      recipeKey: interaction.options.getString('recipe', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.recipeName} en production`,
          [
            `Building: **${result.buildingName}** (slot ${result.slotIndex + 1})`,
            `Quantity: **${result.quantity}** batch(es)`,
            `Ready ${discordTimestamp(result.finishAt, 'R')} (${discordTimestamp(result.finishAt, 't')})`,
            '',
            `Ingredients consumed: ${result.consumed.map((entry) => `${entry.quantity}× \`${entry.itemKey}\``).join(', ')}`,
          ].join('\n'),
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString();
    const level = context.playerId
      ? ((await (await import('../repositories/player.repo')).findUserById(context.playerId))?.level ?? 1)
      : 1;
    const recipes = craftService.craftableRecipes(level, query);
    await interaction.respond(
      recipes.map((recipe) => ({
        name: truncate(
          `${recipe.emoji} ${recipe.name} — ${Math.round(recipe.durationSeconds / 60)} min • lv. ${recipe.requiredLevel}`,
          100,
        ),
        value: recipe.key,
      })),
    );
  },
};

const recettes: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('recipes')
    .setDescription('Every processing recipe')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter by workshop')
        .addChoices(
          { name: '🌬️ Bakery', value: 'boulangerie' },
          { name: '🫙 Cannery', value: 'conserverie' },
          { name: '🧈 Dairy', value: 'laiterie' },
          { name: '🍺 Brewery', value: 'brasserie' },
          { name: '🫗 Oil press', value: 'huilerie' },
          { name: '🔥 Smokehouse', value: 'fumoir' },
          { name: '🍬 Confectionery', value: 'confiserie' },
          { name: '🛠️ Workshop', value: 'atelier' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const category = interaction.options.getString('category') ?? undefined;
    const recipes = await craftService.listRecipes(context.player, { category });

    const lines = recipes.slice(0, 20).map((entry) => {
      const lock = !entry.unlocked
        ? `🔒 lv. ${entry.recipe.requiredLevel}`
        : !entry.hasBuilding
          ? `🏗️ ${entry.building?.name ?? entry.recipe.buildingKey} required`
          : entry.craftableCount > 0
            ? `✅ ${entry.craftableCount} craftable`
            : '⚠️ missing ingredients';
      const ingredients = entry.ingredients
        .map((ingredient) => `${ingredient.needed}× ${ingredient.emoji}${ingredient.owned < ingredient.needed ? `(${ingredient.owned})` : ''}`)
        .join(' + ');
      return [
        `${entry.recipe.emoji} **${entry.recipe.name}** — ${lock}`,
        `   ${ingredients} → ${entry.recipe.outputQuantity}× ${entry.outputEmoji} (**×${entry.margin.toFixed(2)}** de valeur, ${Math.round(entry.recipe.durationSeconds / 60)} min)`,
      ].join('\n');
    });

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '📜 Processing recipes',
          description: lines.join('\n') || 'No recipe in this category.',
          color: COLORS.primary,
          footer: 'Processing roughly doubles the value of the ingredients — that is where the profit is.',
        }),
      ],
    });
  },
};

const production: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('production')
    .setDescription('Status of your production queues')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await productionView(context));
  },
};

const batiments: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buildings')
    .setDescription('Build and upgrade your buildings')
    .addStringOption((option) =>
      option
        .setName('build')
        .setDescription('Build or upgrade a building directly')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const buildingKey = interaction.options.getString('build');

    if (buildingKey) {
      const result = await craftService.buildOrUpgrade(context.player, buildingKey);
      await interaction.editReply({
        embeds: [
          successEmbed(
            `${result.emoji} ${result.name} — ${result.built ? 'built' : `tier ${result.tier}`}`,
            [
              `Cost: ${formatCoins(result.costCoins)}`,
              result.capacity > 0 ? `Capacity: **${formatNumber(result.capacity)}**` : '',
              result.slots > 0 ? `Emplacements de production : **${result.slots}**` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ],
      });
      return;
    }

    await interaction.editReply(await buildingsView(context));
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    await interaction.respond(
      context.config.buildingList
        .filter((building) => building.enabled && (!query || building.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((building) => ({
          name: truncate(`${building.emoji} ${building.name} — ${building.description ?? ''}`, 100),
          value: building.key,
        })),
    );
  },
};

export const commands: Command[] = [crafter, recettes, production, batiments];
export { appendTracking };
