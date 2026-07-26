import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { animalsView } from '../framework/views';
import * as animalService from '../services/animal.service';
import * as animalRepo from '../repositories/animal.repo';
import { gameError } from '../utils/errors';
import { formatCoins, formatNumber, gaugeBar, truncate } from '../utils/format';
import { appendTracking } from './farm';
import type { Command } from '../types';

/** Commandes d'élevage. */

/** Autocomplétion commune : les animaux vivants du joueur. */
async function autocompleteOwnedAnimals(
  interaction: import('discord.js').AutocompleteInteraction,
  context: import('../types').AutocompleteContext,
): Promise<void> {
  if (!context.playerId) {
    await interaction.respond([]);
    return;
  }
  const farm = await (await import('../repositories/player.repo')).getFarmByUserId(context.playerId);
  if (!farm) {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused().toString().toLowerCase();
  const animals = await animalRepo.listAnimals(farm.id);
  await interaction.respond(
    animals
      .filter(
        (entry) =>
          !query ||
          entry.name.toLowerCase().includes(query) ||
          (entry.animal.nickname ?? '').toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((entry) => ({
        name: truncate(
          `${entry.emoji} ${entry.animal.nickname ?? entry.name} — faim ${entry.animal.hunger}% • bonheur ${entry.animal.happiness}%`,
          100,
        ),
        value: entry.animal.id,
      })),
  );
}

const animaux: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('animals')
    .setDescription('Your livestock: status, output, buildings')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(await animalsView(context, 1));
  },
};

const acheterAnimal: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('buy-animal')
    .setDescription('Buy an animal for your farm')
    .addStringOption((option) =>
      option.setName('species').setDescription("The species to buy").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many animals (max 10)').setMinValue(1).setMaxValue(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.buyAnimal(context.player, {
      animalKey: interaction.options.getString('species', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.quantity}× ${result.name}`,
          `Achat conclu pour **${result.currency === 'gems' ? `${formatNumber(result.total)} 💎` : formatCoins(result.total)}**.\n` +
            'Feed them regularly with `/feed`: a hungry animal produces half as much.',
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString();
    const level = context.playerId
      ? ((await (await import('../repositories/player.repo')).findUserById(context.playerId))?.level ?? 1)
      : 1;
    const animals = animalService.purchasableAnimals(level, query);
    await interaction.respond(
      animals.map((animal) => ({
        name: truncate(
          `${animal.emoji} ${animal.name} — ${animal.price > 0 ? `${formatNumber(animal.price)} pièces` : `${animal.priceGems} gemmes`} • niv. ${animal.requiredLevel}`,
          100,
        ),
        value: animal.key,
      })),
    );
  },
};

const nourrir: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Feed your animals')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('A specific animal (otherwise: all)')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const animalId = interaction.options.getString('animal') ?? undefined;
    const result = await animalService.feed(context.player, { animalId, all: !animalId });

    const embed = successEmbed(
      '🌾 Repas servi',
      `**${result.fed}** animal(aux) nourri(s).\nConsommé : ${result.consumed
        .map((entry) => `${entry.quantity}× ${entry.itemKey}`)
        .join(', ')}`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const collecter: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('collect')
    .setDescription('Collect what your animals have produced')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('A specific animal (otherwise: all)')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const animalId = interaction.options.getString('animal') ?? undefined;
    const result = await animalService.collect(context.player, { animalId, all: !animalId });

    const embed = successEmbed(
      '🥚 Collecte',
      result.lines
        .map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}** — ${line.name}`)
        .join('\n'),
    );
    embed.addFields({
      name: 'Total',
      value: `**${formatNumber(result.totalQuantity)}** produit(s) • **${formatNumber(result.xpGained)}** ✨${
        result.levelUp ? `\n🎉 Niveau **${result.levelUp.level}** atteint !` : ''
      }`,
    });
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const soigner: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('heal')
    .setDescription('Have the vet treat a sick animal')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to treat").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.heal(
      context.player,
      interaction.options.getString('animal', true),
    );
    await interaction.editReply({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.name} has been treated`,
          `The vet was paid ${formatCoins(result.cost)}.\nHealth restored to **100%**.`,
        ),
      ],
    });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const caresser: Command = {
  category: 'elevage',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('pet')
    .setDescription('Pet an animal — happier means more output')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to pet").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.pet(
      context.player,
      interaction.options.getString('animal', true),
    );
    const embed = successEmbed(
      `${result.emoji} ${result.name} est ravi !`,
      `Bonheur **+${result.gain}** → ${gaugeBar(result.happiness, 8)} **${result.happiness}%**`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const reproduire: Command = {
  category: 'elevage',
  cooldown: { seconds: 30, bucket: 'breed' },
  data: new SlashCommandBuilder()
    .setName('breed')
    .setDescription('Breed two animals of the same species')
    .addStringOption((option) =>
      option.setName('parent1').setDescription('First parent').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('parent2').setDescription('Second parent').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.breed(context.player, {
      animalAId: interaction.options.getString('parent1', true),
      animalBId: interaction.options.getString('parent2', true),
    });

    if (!result.success) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '💔 No litter this time',
            description: `${result.reason ?? 'The attempt failed.'}\nCost incurred: ${formatCoins(result.cost)}.`,
            color: COLORS.warning,
          }),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🍼 Naissance !',
          [
            `A **generation ${result.generation}** calf was born.`,
            `Inherited production multiplier: **×${result.qualityMultiplier?.toFixed(3)}**`,
            '',
            '*Breed your best animals to improve your bloodline generation after generation.*',
          ].join('\n'),
        ),
      ],
    });
  },

  autocomplete: autocompleteOwnedAnimals,
};

const vendreAnimal: Command = {
  category: 'elevage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('sell-animal')
    .setDescription('Sell an animal (60% of price, scaled by health)')
    .addStringOption((option) =>
      option.setName('animal').setDescription("The animal to sell").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.sellAnimal(
      context.player,
      interaction.options.getString('animal', true),
    );
    await interaction.editReply({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.name} vendu`,
          `Vous recevez **${formatCoins(result.price)}**.`,
        ),
      ],
    });
  },

  autocomplete: autocompleteOwnedAnimals,
};

export const commands: Command[] = [
  animaux,
  acheterAnimal,
  nourrir,
  collecter,
  soigner,
  caresser,
  reproduire,
  vendreAnimal,
];
export { gameError };
