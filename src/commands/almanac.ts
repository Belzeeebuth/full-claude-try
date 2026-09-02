import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
} from 'discord.js';
import { COLORS, baseEmbed, button, row } from '../framework/ui';
import { currentDayFor } from '../game/almanac';
import { SEASON_LABELS } from '../game/world';
import * as almanacService from '../services/almanac.service';
import type { AlmanacForecast } from '../services/almanac.service';
import { discordTimestamp, formatCoins, formatPercent, progressBar, truncate } from '../utils/format';
import type { Command, CommandContext, Translator } from '../types';

/**
 * `/almanac` — l'almanach du fermier.
 *
 * Tout est ÉPHÉMÈRE, y compris la partie gratuite : la prévision est un
 * produit payant, et un embed public la livrerait à tout le salon pour le
 * prix d'un seul joueur. `/weather` reste la commande publique du jour.
 *
 * Une seule commande sans sous-commande : l'achat passe par un bouton sous
 * l'embed, qui transporte le jour et le prix affichés — le service refuse
 * de débiter autre chose que ce que le joueur a lu.
 */

/** Lignes d'effets d'une météo, partagées avec `/weather` (mêmes clés `world.*`). */
function effectLines(
  weather: AlmanacForecast['weather'],
  t: Translator,
  locale: string,
): string[] {
  return [
    t('world.weather_yield_line', {
      percent: formatPercent(weather.yieldModifier - 1, undefined, locale),
    }),
    t('world.weather_growth_line', {
      percent: formatPercent(weather.growthModifier - 1, undefined, locale),
    }),
    weather.freeWatering ? t('world.weather_free_watering_line') : '',
    weather.damageChance > 0
      ? t('world.weather_damage_line', { percent: (weather.damageChance * 100).toFixed(0) })
      : '',
    t('world.weather_pest_line', { percent: (weather.pestChance * 100).toFixed(0) }),
  ].filter(Boolean);
}

/** Conseils traduits d'une prévision, un par ligne. */
export function tipLines(forecast: AlmanacForecast, t: Translator): string {
  return forecast.tips.map((tip) => t(`almanac.tip.${tip.key}`, tip.params)).join('\n');
}

/**
 * Vue complète de l'almanach, partagée entre la commande et ses boutons pour
 * qu'un rafraîchissement ne puisse pas diverger de la commande.
 */
export async function almanacView(
  context: CommandContext,
  ownerId: string,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const { t, locale, now } = context;
  const view = await almanacService.getAlmanac(context.player, now, locale);
  const { world, forecast } = view;
  const weather = world.weather;
  const season = world.season;

  const fields = [
    {
      name: t('almanac.today_field'),
      value: [
        t('almanac.today_value', {
          emoji: weather.emoji,
          label: weather.label,
          temperature: weather.temperature,
          description: weather.description,
        }),
        ...effectLines(weather, t, locale),
      ].join('\n'),
    },
    {
      name: t('almanac.season_field'),
      value: t('almanac.season_value', {
        emoji: SEASON_LABELS[season.season].emoji,
        name: t(`world.season.${season.season}`),
        year: season.gameYear,
        bar: progressBar(season.progress * 100, 100, 12),
        percent: Math.round(season.progress * 100),
        count: view.daysUntilNextSeason,
        nextEmoji: SEASON_LABELS[view.nextSeason.season].emoji,
        nextName: t(`world.season.${view.nextSeason.season}`),
        relative: discordTimestamp(view.nextSeason.startsAt, 'R'),
      }),
    },
    {
      name: t('almanac.events_field'),
      value: truncate(
        world.activeEvents
          .map((event) =>
            t('almanac.events_line', { name: event.name, description: event.description }),
          )
          .join('\n') || t('almanac.events_none'),
        1000,
      ),
    },
  ];

  if (forecast) {
    fields.push(
      {
        name: t('almanac.forecast_field', { day: forecast.day }),
        value: [
          t('almanac.forecast_value', {
            emoji: forecast.weather.emoji,
            label: forecast.weather.label,
            temperature: forecast.weather.temperature,
            description: forecast.weather.description,
            relative: discordTimestamp(forecast.expiresAt, 'R'),
          }),
          ...effectLines(forecast.weather, t, locale),
        ].join('\n'),
      },
      { name: t('almanac.tips_field'), value: tipLines(forecast, t) },
    );
  } else {
    const missing = view.price - context.player.coins;
    fields.push({
      name: t('almanac.forecast_field', { day: view.forecastDay }),
      value: [
        t('almanac.forecast_locked', { price: formatCoins(view.price, false, locale) }),
        missing > 0
          ? t('almanac.forecast_unaffordable', { missing: formatCoins(missing, false, locale) })
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  const buttons: ButtonBuilder[] = [];
  if (!forecast) {
    buttons.push(
      button({
        namespace: 'almanac',
        action: 'buy',
        ownerId,
        // Jour et prix affichés : le service refuse l'achat s'ils ont changé.
        params: [view.forecastDay, view.price],
        label: t('almanac.buy_button', { price: formatCoins(view.price, false, locale) }),
        emoji: '🔮',
        style: ButtonStyle.Success,
      }),
    );
  }
  buttons.push(
    button({
      namespace: 'almanac',
      action: 'refresh',
      ownerId,
      label: t('common.refresh'),
      emoji: '🔄',
    }),
  );

  return {
    embeds: [
      baseEmbed({
        title: t('almanac.title', { day: currentDayFor(now) }),
        color: forecast ? COLORS.gold : COLORS.info,
        fields,
        footer: t('almanac.footer'),
      }),
    ],
    components: [row(...buttons)],
  };
}

const almanac: Command = {
  category: 'monde',
  cooldown: { seconds: 3 },
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName('almanac')
    .setDescription("Farmer's almanac: today's conditions for free, tomorrow's exact forecast for a fee")
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await almanacView(context, interaction.user.id));
  },
};

export const commands: Command[] = [almanac];
