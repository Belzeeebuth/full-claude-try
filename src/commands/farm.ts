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
// /ferme
// ---------------------------------------------------------------------------

const ferme: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('ferme')
    .setDescription('Affiche votre ferme (ou celle d\'un autre fermier)')
    .addUserOption((option) =>
      option.setName('utilisateur').setDescription('Le fermier à observer').setRequired(false),
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('utilisateur');

    if (target && target.id !== interaction.user.id) {
      // Consultation de la ferme d'un autre : on délègue à /visiter, qui gère
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
// /planter
// ---------------------------------------------------------------------------

const planter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('planter')
    .setDescription('Plante des graines sur vos parcelles')
    .addStringOption((option) =>
      option
        .setName('graine')
        .setDescription('La culture à planter')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option
        .setName('parcelle')
        .setDescription('Numéro de parcelle précis (sinon, remplit les parcelles vides)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('quantité')
        .setDescription('Nombre de parcelles à planter (défaut : 1)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const cropKey = interaction.options.getString('graine', true);
    const slot = interaction.options.getInteger('parcelle') ?? undefined;
    const quantity = interaction.options.getInteger('quantité') ?? 1;

    const result = await farmService.plant(context.player, {
      cropKey,
      slot,
      quantity,
      coopLevel: 0,
    });

    const embed = successEmbed(
      `${result.emoji} ${result.cropName} planté`,
      [
        `**${result.slots.length}** parcelle(s) plantée(s) : ${result.slots.map((value) => `\`${value}\``).join(' ')}`,
        `🌱 Récolte ${discordTimestamp(result.readyAt, 'R')} (${discordTimestamp(result.readyAt, 't')})`,
        result.waterNeeded > 0 ? `💧 ${result.waterNeeded} arrosage(s) attendu(s)` : '',
        result.offSeason
          ? '⚠️ *Hors saison : pousse plus lente et rendement réduit. Une serre annulerait ce malus.*'
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
    const crops = await farmService.plantableCrops(context.playerId, 60, query);
    await interaction.respond(
      crops.map((entry) => ({
        name: truncate(
          `${entry.crop.emoji} ${entry.crop.name} — ${entry.owned} graine(s), ${Math.round(entry.crop.growthSeconds / 60)} min`,
          100,
        ),
        value: entry.crop.key,
      })),
    );
  },
};

// ---------------------------------------------------------------------------
// /recolter
// ---------------------------------------------------------------------------

const recolter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('recolter')
    .setDescription('Récolte vos cultures arrivées à maturité')
    .addIntegerOption((option) =>
      option
        .setName('parcelle')
        .setDescription('Une parcelle précise (sinon : tout ce qui est prêt)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('parcelle') ?? undefined;

    const summary = await farmService.harvest(context.player, { slot, all: slot === undefined });
    await interaction.editReply({ embeds: [buildHarvestEmbed(summary)] });
  },
};

export function buildHarvestEmbed(summary: farmService.HarvestSummary) {
  const lines = summary.plots.map((plot) => {
    const quality =
      plot.result.quality === 'normal' ? '' : ` ${qualityIcon(plot.result.quality)} ${qualityLabel(plot.result.quality)}`;
    const mutation = plot.result.mutation === 'none' ? '' : ` ${mutationIcon(plot.result.mutation)} **${plot.result.mutation}**`;
    const regrow = plot.regrew && plot.nextReadyAt ? ` 🔁 repousse ${discordTimestamp(plot.nextReadyAt, 'R')}` : '';
    return `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.emoji} **${plot.result.quantity}× ${plot.cropName}**${quality}${mutation} — ~${formatCoins(plot.result.totalValue, true)}${regrow}`;
  });

  const embed = baseEmbed({
    title: '🧺 Récolte',
    description: lines.join('\n') || 'Rien de récolté.',
    color: COLORS.success,
    fields: [
      {
        name: 'Total',
        value: `**${formatNumber(summary.totalQuantity)}** unité(s) • valeur estimée **${formatCoins(summary.estimatedValue)}** • **${formatNumber(summary.xpGained)}** ✨`,
      },
    ],
  });

  if (summary.witheredSlots.length > 0) {
    embed.addFields({
      name: '💀 Cultures fanées',
      value: `Parcelles ${summary.witheredSlots.join(', ')} — récoltez plus tôt la prochaine fois !`,
    });
  }
  if (summary.seedsRecovered.length > 0) {
    embed.addFields({
      name: '🫧 Grainerie',
      value: summary.seedsRecovered
        .map((seed) => `${seed.quantity}× ${seed.itemKey.replace('seed_', '')}`)
        .join(', '),
    });
  }
  if (summary.levelUp) {
    embed.addFields({
      name: '🎉 Niveau supérieur !',
      value: `Vous atteignez le **niveau ${summary.levelUp.level}** (+${summary.levelUp.levelsGained})\nRécompense : ${formatCoins(summary.levelUp.rewardCoins)}${summary.levelUp.rewardGems > 0 ? ` + ${summary.levelUp.rewardGems} 💎` : ''}`,
    });
  }
  appendTracking(embed, summary.tracking);

  return embed;
}

// ---------------------------------------------------------------------------
// /arroser
// ---------------------------------------------------------------------------

const arroser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('arroser')
    .setDescription('Arrose vos cultures assoiffées')
    .addIntegerOption((option) =>
      option
        .setName('parcelle')
        .setDescription('Une parcelle précise (sinon : autant que possible)')
        .setMinValue(1)
        .setMaxValue(64)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('parcelle') ?? undefined;
    const result = await farmService.water(context.player, { slot, all: slot === undefined });

    if (result.freeRain) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '🌧️ Il pleut !',
            description:
              'Toutes vos parcelles sont arrosées gratuitement aujourd\'hui. Économisez votre énergie.',
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const embed = successEmbed(
      '💧 Arrosage',
      `**${result.watered}** parcelle(s) arrosée(s).${result.toolPlots > 1 ? `\n*Votre arrosoir couvre ${result.toolPlots} parcelles par action.*` : ''}`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /fertiliser, /desherber, /traiter
// ---------------------------------------------------------------------------

const fertiliser: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('fertiliser')
    .setDescription('Applique un engrais sur vos parcelles')
    .addStringOption((option) =>
      option
        .setName('engrais')
        .setDescription("Le type d'engrais")
        .setRequired(true)
        .addChoices(
          { name: '💩 Engrais simple (+15 fertilité, +10 % rendement)', value: 'fertilizer_basic' },
          { name: '🧪 Engrais de qualité (+25 fertilité, +15 % qualité)', value: 'fertilizer_quality' },
          { name: '✨ Engrais suprême (+40 fertilité, +25 % des deux)', value: 'fertilizer_deluxe' },
        ),
    )
    .addIntegerOption((option) =>
      option.setName('parcelle').setDescription('Une parcelle précise').setMinValue(1).setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const fertilizerKey = interaction.options.getString('engrais', true);
    const slot = interaction.options.getInteger('parcelle') ?? undefined;

    const result = await farmService.fertilize(context.player, { fertilizerKey, slot, all: !slot });
    const embed = successEmbed(
      '🧪 Fertilisation',
      `${result.fertilizer} appliqué sur **${result.slots.length}** parcelle(s).\nFertilité du sol : **${result.fertilityAfter}%**`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

const desherber: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('desherber')
    .setDescription('Arrache les mauvaises herbes (et récupère du compost)')
    .addIntegerOption((option) =>
      option.setName('parcelle').setDescription('Une parcelle précise').setMinValue(1).setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('parcelle') ?? undefined;
    const result = await farmService.weed(context.player, { slot, all: !slot });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🌿 Désherbage',
          `**${result.slots.length}** parcelle(s) nettoyée(s).\nVous récupérez **${result.weedsCollected}× 🌱 mauvaises herbes** — de quoi faire du compost à l'atelier.`,
        ),
      ],
    });
  },
};

const traiter: Command = {
  category: 'agriculture',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('traiter')
    .setDescription('Traite une parcelle infestée de nuisibles')
    .addIntegerOption((option) =>
      option
        .setName('parcelle')
        .setDescription('La parcelle à traiter')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(64),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const slot = interaction.options.getInteger('parcelle', true);
    const result = await farmService.treatPest(context.player, { slot });

    const { PEST_LABELS } = await import('../game/plot');
    const pest = PEST_LABELS[result.pestType];

    const embed = successEmbed(
      `${pest.emoji} ${pest.name} éliminés`,
      `Parcelle **${result.slot}** assainie.${result.usedItem ? '\n🧯 Un traitement bio a été consommé.' : "\n*Sans traitement bio, l'opération coûte plus d'énergie.*"}`,
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /parcelles, /acheter-parcelle
// ---------------------------------------------------------------------------

const parcelles: Command = {
  category: 'agriculture',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('parcelles')
    .setDescription('Vue détaillée de vos parcelles et de leur sol')
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
    .setName('acheter-parcelle')
    .setDescription('Débloque la prochaine parcelle de votre ferme')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await farmService.buyPlot(context.player);

    const embed = successEmbed(
      '🗺️ Nouvelle parcelle !',
      [
        `Parcelle **${result.slot}** débloquée pour ${formatCoins(result.cost)}.`,
        `Votre ferme fait désormais **${result.grid.width}×${result.grid.height}** (${result.unlockedPlots} parcelles).`,
        result.nextCost > 0 ? `Prochaine parcelle : ${formatCoins(result.nextCost)}` : '🏆 Domaine complet !',
      ].join('\n'),
    );
    appendTracking(embed, result.tracking);
    await interaction.editReply({ embeds: [embed] });
  },
};

// ---------------------------------------------------------------------------
// /cultures — encyclopédie
// ---------------------------------------------------------------------------

const cultures: Command = {
  category: 'agriculture',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('cultures')
    .setDescription('Encyclopédie des cultures')
    .addStringOption((option) =>
      option
        .setName('rareté')
        .setDescription('Filtrer par rareté')
        .addChoices(
          { name: 'Commune', value: 'common' },
          { name: 'Peu commune', value: 'uncommon' },
          { name: 'Rare', value: 'rare' },
          { name: 'Épique', value: 'epic' },
          { name: 'Légendaire', value: 'legendary' },
          { name: 'Mythique', value: 'mythic' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('saison')
        .setDescription('Filtrer par saison')
        .addChoices(
          { name: 'Printemps', value: 'spring' },
          { name: 'Été', value: 'summer' },
          { name: 'Automne', value: 'autumn' },
          { name: 'Hiver', value: 'winter' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const rarity = interaction.options.getString('rareté');
    const season = interaction.options.getString('saison');

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
        `${locked}${crop.emoji} **${crop.name}** — ${rarityLabel(crop.rarity)} • niv. ${crop.requiredLevel}`,
        `   🌱 ${formatNumber(crop.seedPrice)} ${COIN} → 🧺 ${crop.baseYield}× ${formatNumber(crop.sellPrice)} ${COIN} • ⏳ ${formatDuration(crop.growthSeconds * 1000)} • **~${formatNumber(perHour)} ${COIN}/h/parcelle**${crop.regrowCycles > 0 ? ` • 🔁 ${crop.regrowCycles}` : ''}`,
      ].join('\n');
    });

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🌾 Encyclopédie des cultures',
          description: lines.join('\n') || 'Aucune culture ne correspond à ce filtre.',
          color: COLORS.primary,
          footer: `${crops.length} culture(s) • le rendement horaire est calculé pour un sol à 70 % et en saison`,
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
      `📋 Quête(s) terminée(s) : ${tracking.completedQuests.map((quest) => `**${quest.title}**`).join(', ')} — \`/quetes\` pour réclamer`,
    );
  }
  if (tracking.unlockedAchievements.length > 0) {
    parts.push(
      `🏆 Succès débloqué(s) : ${tracking.unlockedAchievements.map((entry) => `**${entry.name}**`).join(', ')}`,
    );
  }
  if (tracking.completedCoopObjectives.length > 0) {
    parts.push(`🤝 Objectif de coopérative atteint : **${tracking.completedCoopObjectives.join(', ')}**`);
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
