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
    .setName('animaux')
    .setDescription('Votre cheptel : état, production, bâtiments')
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
    .setName('acheter-animal')
    .setDescription('Achète un animal pour votre ferme')
    .addStringOption((option) =>
      option.setName('espèce').setDescription("L'espèce à acheter").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantité').setDescription('Nombre d\'animaux (max 10)').setMinValue(1).setMaxValue(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.buyAnimal(context.player, {
      animalKey: interaction.options.getString('espèce', true),
      quantity: interaction.options.getInteger('quantité') ?? 1,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.quantity}× ${result.name}`,
          `Achat conclu pour **${result.currency === 'gems' ? `${formatNumber(result.total)} 💎` : formatCoins(result.total)}**.\n` +
            'Pensez à les nourrir régulièrement avec `/nourrir` : un animal affamé produit deux fois moins.',
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
    .setName('nourrir')
    .setDescription('Nourrit vos animaux')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('Un animal précis (sinon : tous)')
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
    .setName('collecter')
    .setDescription('Collecte la production de vos animaux')
    .addStringOption((option) =>
      option
        .setName('animal')
        .setDescription('Un animal précis (sinon : tous)')
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
    .setName('soigner')
    .setDescription('Fait soigner un animal malade par le vétérinaire')
    .addStringOption((option) =>
      option.setName('animal').setDescription("L'animal à soigner").setRequired(true).setAutocomplete(true),
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
          `${result.emoji} ${result.name} est soigné`,
          `Le vétérinaire a été payé ${formatCoins(result.cost)}.\nSanté rétablie à **100 %**.`,
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
    .setName('caresser')
    .setDescription('Caresse un animal (bonheur = meilleure production)')
    .addStringOption((option) =>
      option.setName('animal').setDescription("L'animal à câliner").setRequired(true).setAutocomplete(true),
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
    .setName('reproduire')
    .setDescription('Fait se reproduire deux animaux de la même espèce')
    .addStringOption((option) =>
      option.setName('animal1').setDescription('Premier parent').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('animal2').setDescription('Second parent').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await animalService.breed(context.player, {
      animalAId: interaction.options.getString('animal1', true),
      animalBId: interaction.options.getString('animal2', true),
    });

    if (!result.success) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '💔 Pas de portée cette fois',
            description: `${result.reason ?? 'Tentative infructueuse.'}\nCoût engagé : ${formatCoins(result.cost)}.`,
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
            `Un petit de **génération ${result.generation}** est né.`,
            `Multiplicateur de production hérité : **×${result.qualityMultiplier?.toFixed(3)}**`,
            '',
            '*Croisez vos meilleurs reproducteurs pour améliorer votre lignée génération après génération.*',
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
    .setName('vendre-animal')
    .setDescription('Vend un animal (60 % de son prix, modulé par sa santé)')
    .addStringOption((option) =>
      option.setName('animal').setDescription("L'animal à vendre").setRequired(true).setAutocomplete(true),
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
