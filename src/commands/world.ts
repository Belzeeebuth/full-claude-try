import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed } from '../framework/ui';
import { SEASON_LABELS } from '../game/world';
import { describeNextSeason, getWorldState } from '../services/world.service';
import { discordTimestamp, formatPercent, progressBar, truncate } from '../utils/format';
import type { Command } from '../types';

/** Météo, saisons, événements et encyclopédie générale. */

const meteo: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('weather')
    .setDescription("Today's weather and how it affects your crops")
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now);
    const weather = world.weather;

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `${weather.emoji} ${weather.label} — ${weather.temperature} °C`,
          description: weather.description,
          color: weather.damageChance > 0 ? COLORS.warning : COLORS.info,
          fields: [
            {
              name: 'Effets du jour',
              value: [
                `🌾 Rendement : **${formatPercent(weather.yieldModifier - 1)}**`,
                `⏳ Vitesse de pousse : **${formatPercent(weather.growthModifier - 1)}**`,
                weather.freeWatering ? '💧 **Arrosage gratuit** — inutile d\'utiliser `/water`' : '',
                weather.damageChance > 0
                  ? `⚠️ Risque de dégâts : **${(weather.damageChance * 100).toFixed(0)} %** par parcelle`
                  : '',
                `🐛 Risque de nuisibles : ${(weather.pestChance * 100).toFixed(0)} %`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
            {
              name: 'Saison',
              value: `${SEASON_LABELS[world.season.season].emoji} **${SEASON_LABELS[world.season.season].name}** (an ${world.season.gameYear})\n${progressBar(world.season.progress * 100, 100, 12)} ${Math.round(world.season.progress * 100)} %`,
            },
          ],
          footer: 'La météo est la même pour tout le village et change chaque jour à minuit UTC.',
        }),
      ],
    });
  },
};

const saison: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription("Current season, favoured crops and what's next")
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now);
    const next = describeNextSeason(context.now);
    const current = world.season.season;

    const inSeason = context.config.cropList.filter(
      (crop) => crop.enabled && crop.seasons.includes(current as never),
    );
    const comingSoon = context.config.cropList.filter(
      (crop) => crop.enabled && !crop.seasons.includes(current as never) && crop.seasons.includes(next.season as never),
    );

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `${SEASON_LABELS[current].emoji} ${SEASON_LABELS[current].name} — an ${world.season.gameYear}`,
          description: [
            `${progressBar(world.season.progress * 100, 100, 16)} ${Math.round(world.season.progress * 100)} %`,
            `Prochaine saison : ${SEASON_LABELS[next.season].emoji} **${SEASON_LABELS[next.season].name}** ${discordTimestamp(next.startsAt, 'R')}`,
            '',
            `En saison : **+${(context.balance.seasons.inSeasonYieldBonus * 100).toFixed(0)} %** de rendement.`,
            `Hors saison : **−${(context.balance.seasons.offSeasonYieldPenalty * 100).toFixed(0)} %** de rendement et pousse ralentie (la serre annule ce malus).`,
          ].join('\n'),
          color: COLORS.primary,
          fields: [
            {
              name: '✅ Cultures de saison',
              value: truncate(
                inSeason.map((crop) => `${crop.emoji} ${crop.name}`).join(' • ') || '—',
                1000,
              ),
            },
            {
              name: '⏭️ Bientôt de saison',
              value: truncate(
                comingSoon.map((crop) => `${crop.emoji} ${crop.name}`).join(' • ') || '—',
                1000,
              ),
            },
          ],
        }),
      ],
    });
  },
};

const evenement: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Active event and its rewards')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const world = await getWorldState(context.now);

    if (world.activeEvents.length === 0) {
      await interaction.editReply({
        embeds: [
          baseEmbed({
            title: '🎪 Aucun événement en cours',
            description:
              'Le village prépare ses prochaines festivités.\n\n' +
              '**Au programme de l\'année :**\n' +
              context.config.eventList
                .filter((event) => event.enabled)
                .map((event) => `• **${event.name}** — ${event.description}`)
                .join('\n'),
            color: COLORS.info,
          }),
        ],
      });
      return;
    }

    const event = world.activeEvents[0]!;
    const progress = await (
      await import('../repositories/progression.repo')
    ).getUserEvent(context.player.id, event.key);

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: `🎪 ${event.name}`,
          description: event.description,
          color: COLORS.gold,
          fields: [
            {
              name: 'Modificateurs actifs',
              value:
                [
                  event.modifiers.xpMultiplier ? `✨ XP ×${event.modifiers.xpMultiplier}` : '',
                  event.modifiers.growthMultiplier
                    ? `🌱 Vitesse de pousse ×${event.modifiers.growthMultiplier}`
                    : '',
                  event.modifiers.globalPriceMultiplier
                    ? `💰 Prix ×${event.modifiers.globalPriceMultiplier}`
                    : '',
                  event.modifiers.mutationMultiplier
                    ? `🌈 Mutations ×${event.modifiers.mutationMultiplier}`
                    : '',
                  event.modifiers.waterMultiplier
                    ? `💧 Besoin en eau ×${event.modifiers.waterMultiplier}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n') || 'Aucun',
            },
            {
              name: 'Votre progression',
              value: `**${progress?.points ?? 0}** point(s) d'événement`,
            },
            {
              name: '🎁 Paliers de récompense',
              value:
                event.rewardTiers
                  .map((tier) => {
                    const claimed = (progress?.claimedTiers ?? []).includes(tier.points);
                    const rewards = [
                      tier.rewards.coins ? `${tier.rewards.coins} 🪙` : '',
                      tier.rewards.gems ? `${tier.rewards.gems} 💎` : '',
                      tier.rewards.title ? `titre « ${tier.rewards.title} »` : '',
                    ]
                      .filter(Boolean)
                      .join(' • ');
                    return `${claimed ? '✅' : (progress?.points ?? 0) >= tier.points ? '🎁' : '🔒'} **${tier.points} pts** — ${rewards}`;
                  })
                  .join('\n') || 'Aucun palier.',
            },
          ],
        }),
      ],
    });
  },
};

const encyclopedie: Command = {
  category: 'monde',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('encyclopedia')
    .setDescription('Search the entire game database')
    .addStringOption((option) =>
      option.setName('term').setDescription('Crop, animal, item, recipe or building').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const term = interaction.options.getString('term', true).toLowerCase();
    const config = context.config;

    const crops = config.cropList.filter((entry) => entry.name.toLowerCase().includes(term));
    const animals = config.animalList.filter((entry) => entry.name.toLowerCase().includes(term));
    const items = config.itemList.filter((entry) => entry.name.toLowerCase().includes(term));
    const recipes = config.recipeList.filter((entry) => entry.name.toLowerCase().includes(term));
    const buildings = config.buildingList.filter((entry) => entry.name.toLowerCase().includes(term));

    const total = crops.length + animals.length + items.length + recipes.length + buildings.length;

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: `📖 Encyclopédie — « ${term} »`,
          description: total === 0 ? 'Aucun résultat.' : `${total} résultat(s).`,
          color: COLORS.info,
          fields: [
            ...(crops.length > 0
              ? [
                  {
                    name: '🌾 Cultures',
                    value: crops
                      .slice(0, 5)
                      .map(
                        (crop) =>
                          `${crop.emoji} **${crop.name}** — niv. ${crop.requiredLevel}, ${Math.round(crop.growthSeconds / 60)} min, ${crop.baseYield}× ${crop.sellPrice} 🪙`,
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(animals.length > 0
              ? [
                  {
                    name: '🐄 Animaux',
                    value: animals
                      .slice(0, 5)
                      .map(
                        (animal) =>
                          `${animal.emoji} **${animal.name}** — niv. ${animal.requiredLevel}, ${animal.price} 🪙, produit ${animal.productQuantity}× toutes les ${Math.round(animal.productionSeconds / 60)} min`,
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(items.length > 0
              ? [
                  {
                    name: '📦 Objets',
                    value: items
                      .slice(0, 6)
                      .map((item) => `${item.emoji} **${item.name}** — ${item.description ?? item.category}`)
                      .join('\n'),
                  },
                ]
              : []),
            ...(recipes.length > 0
              ? [
                  {
                    name: '🛠️ Recettes',
                    value: recipes
                      .slice(0, 5)
                      .map(
                        (recipe) =>
                          `${recipe.emoji} **${recipe.name}** — ${(recipe.ingredients as Array<{ itemKey: string; quantity: number }>).map((ingredient) => `${ingredient.quantity}× ${ingredient.itemKey}`).join(' + ')}`,
                      )
                      .join('\n'),
                  },
                ]
              : []),
            ...(buildings.length > 0
              ? [
                  {
                    name: '🏗️ Bâtiments',
                    value: buildings
                      .slice(0, 5)
                      .map((building) => `${building.emoji} **${building.name}** — ${building.description ?? ''}`)
                      .join('\n'),
                  },
                ]
              : []),
          ],
        }),
      ],
    });
  },
};

export const commands: Command[] = [meteo, saison, evenement, encyclopedie];
