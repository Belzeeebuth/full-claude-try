import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { helpEmbed } from '../../commands/start';
import { sendMarketChart } from '../../commands/economy';
import { auctionListView } from '../../commands/trade';
import { COLORS, baseEmbed, quantityModal, successEmbed } from '../../framework/ui';
import { animalsView, buildingsView, coopView, inventoryView, marketView } from '../../framework/views';
import { replyEphemeral } from '../../framework/interaction';
import * as animalService from '../../services/animal.service';
import * as coopService from '../../services/coop.service';
import * as craftService from '../../services/craft.service';
import * as farmService from '../../services/farm.service';
import * as marketService from '../../services/market.service';
import * as progressionService from '../../services/progression.service';
import * as tradeService from '../../services/trade.service';
import { appendTracking } from '../../commands/farm';
import { discordTimestamp, formatCoins, formatNumber, gaugeBar } from '../../utils/format';
import type { SelectHandler } from '../../types';

/** Gestionnaires de menus déroulants. */

const inventoryCategory: SelectHandler = {
  namespace: 'inv',
  actions: ['category'],

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category = interaction.values[0] ?? 'all';
    await interaction.editReply(
      await inventoryView(context, { category: category === 'all' ? undefined : category, page: 1 }),
    );
  },
};

const shopBuy: SelectHandler = {
  namespace: 'shop',
  actions: ['buy'],
  lockKey: 'shop-buy',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    const itemKey = interaction.values[0];
    if (!itemKey) {
      await interaction.deferUpdate();
      return;
    }

    // Une quantité personnalisée est demandée par modal : plus souple qu'une
    // liste figée de boutons 1/5/10.
    await interaction.showModal(
      quantityModal({
        namespace: 'shop',
        action: 'buy_qty',
        ownerId: interaction.user.id,
        params: [itemKey],
        title: 'Quantité à acheter',
        label: 'Combien en voulez-vous ?',
        placeholder: 'Ex. 10',
      }),
    );
  },
};

const marketChart: SelectHandler = {
  namespace: 'market',
  actions: ['chart'],

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const itemKey = interaction.values[0];
    if (!itemKey) return;
    await sendMarketChart(interaction, context, itemKey);
  },
};

const plantSelect: SelectHandler = {
  namespace: 'farm',
  actions: ['plant'],
  lockKey: 'farm-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const cropKey = interaction.values[0];
    if (!cropKey) return;

    const result = await farmService.plant(context.player, { cropKey, quantity: 64 });
    const embed = successEmbed(
      `${result.emoji} ${result.cropName} planté`,
      [
        `**${result.slots.length}** parcelle(s) : ${result.slots.map((slot) => `\`${slot}\``).join(' ')}`,
        `Récolte ${discordTimestamp(result.readyAt, 'R')}`,
        result.offSeason ? '⚠️ *Hors saison : rendement réduit.*' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    appendTracking(embed, result.tracking);
    await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const animalPet: SelectHandler = {
  namespace: 'animal',
  actions: ['pet'],
  lockKey: 'animal-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const animalId = interaction.values[0];
    if (!animalId) return;

    const result = await animalService.pet(context.player, animalId);
    await interaction.followUp({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.name} est ravi !`,
          `Bonheur +${result.gain} → ${gaugeBar(result.happiness, 8)} ${result.happiness}%`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const buildingUpgrade: SelectHandler = {
  namespace: 'build',
  actions: ['upgrade'],
  lockKey: 'build-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const buildingKey = interaction.values[0];
    if (!buildingKey) return;

    const result = await craftService.buildOrUpgrade(context.player, buildingKey);
    await interaction.followUp({
      embeds: [
        successEmbed(
          `${result.emoji} ${result.name} — ${result.built ? 'construit !' : `palier ${result.tier}`}`,
          [
            `Coût : ${formatCoins(result.costCoins)}`,
            result.capacity > 0 ? `Capacité : **${formatNumber(result.capacity)}**` : '',
            result.slots > 0 ? `Emplacements : **${result.slots}**` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    await interaction.editReply(await buildingsView(context));
  },
};

const questReroll: SelectHandler = {
  namespace: 'quest',
  actions: ['reroll'],
  lockKey: 'quest-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const questId = interaction.values[0];
    if (!questId) return;

    const result = await progressionService.rerollQuest(context.player, questId);
    await interaction.followUp({
      embeds: [
        successEmbed(
          '🔄 Quête remplacée',
          `${result.usedToken ? '🎫 Jeton utilisé.' : `Coût : ${formatCoins(result.cost)}`}\n\n**${result.newQuest.title}**\n${result.newQuest.description}`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    const { questsView } = await import('../../framework/views');
    await interaction.editReply(await questsView(context));
  },
};

const coopJoin: SelectHandler = {
  namespace: 'coop',
  actions: ['join'],
  lockKey: 'coop-action',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const tag = interaction.values[0];
    if (!tag) return;

    const info = await coopService.joinCoop(context.player, tag);
    await interaction.followUp({
      embeds: [
        successEmbed(
          `Bienvenue chez ${info.emblem} ${info.name} !`,
          `Vous bénéficiez immédiatement des bonus de niveau ${info.level}.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    await interaction.editReply(await coopView({ ...context, player: { ...context.player, coopId: info.id } }));
  },
};

const auctionBuy: SelectHandler = {
  namespace: 'hdv',
  actions: ['buy'],
  lockKey: 'hdv-buy',

  async execute(interaction: StringSelectMenuInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const listingId = interaction.values[0];
    if (!listingId) return;

    const result = await tradeService.buyout(context.player, listingId);
    await interaction.followUp({
      embeds: [
        successEmbed(
          '🛍️ Achat conclu',
          `**${result.quantity}× ${result.emoji} ${result.itemName}** pour ${formatCoins(result.price)}.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    await interaction.editReply(await auctionListView(context, undefined, 1));
  },
};

const helpCategory: SelectHandler = {
  namespace: 'help',
  actions: ['category'],

  async execute(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply({ embeds: [helpEmbed(interaction.values[0] as never)] });
  },
};

export const handlers: SelectHandler[] = [
  inventoryCategory,
  shopBuy,
  marketChart,
  plantSelect,
  animalPet,
  buildingUpgrade,
  questReroll,
  coopJoin,
  auctionBuy,
  helpCategory,
];

export { baseEmbed, COLORS, marketService, marketView, replyEphemeral };
