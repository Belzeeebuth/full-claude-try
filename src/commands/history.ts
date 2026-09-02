import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, paginationRow } from '../framework/ui';
import * as historyService from '../services/history.service';
import {
  HISTORY_FAMILY_CHOICES,
  formatHistoryLine,
  formatHistoryTotals,
  normalizeDays,
  normalizeFamily,
  type HistoryDays,
  type HistoryFamily,
} from '../services/history.service';
import type { Command, CommandContext } from '../types';

/**
 * `/history` — le journal des pièces du joueur, filtré par famille et période.
 *
 * Éphémère de bout en bout : un relevé de compte est privé, et personne n'a
 * envie de voir ses dons et ses achats affichés dans le salon général. Les
 * boutons de pagination réécrivent ce même message éphémère (`deferUpdate`),
 * via la vue partagée ci-dessous — une seule mise en page pour la commande et
 * le bouton, comme pour `/farm`.
 */

/** Libellés des choix Discord : ils partent dans le payload, donc en anglais. */
const FAMILY_CHOICE_LABELS: Record<HistoryFamily, string> = {
  all: 'All operations',
  sales: 'Sales (harvest, market, animals)',
  purchases: 'Purchases and costs',
  rewards: 'Rewards (quests, daily, events…)',
  auctions: 'Auction house',
  trades: 'Trades and gifts',
  bank: 'Bank',
  coop: 'Co-op',
  taxes: 'Taxes',
  other: 'Other (prestige, admin)',
};

export interface HistoryViewInput {
  family: HistoryFamily;
  days: HistoryDays;
  page: number;
}

/** Vue partagée commande ⇄ bouton : embed + rangée de pagination. */
export async function historyView(context: CommandContext, input: HistoryViewInput) {
  const t = context.t;
  const locale = context.locale;
  const result = await historyService.getHistory(context.player.id, input, locale, context.now);
  const windowLabel = t(`history.window.${result.days}`);

  const header = formatHistoryTotals(result.totals, windowLabel, t, locale).join('\n');
  const body =
    result.lines.length === 0
      ? t('history.empty', { window: windowLabel })
      : result.lines.map((line) => formatHistoryLine(line, t, locale)).join('\n');

  const embed = baseEmbed({
    title: t('history.title'),
    description: `${header}\n\n${body}`,
    color: COLORS.info,
    footer: t('history.footer', {
      family: t(`history.family.${result.family}`),
      count: result.totals.count,
      page: result.page,
      total: result.totalPages,
    }),
  });

  // Une seule page : pas de rangée entièrement grisée sous l'embed.
  const components =
    result.totalPages > 1
      ? [
          paginationRow({
            namespace: 'history',
            ownerId: context.player.discordId,
            page: result.page,
            totalPages: result.totalPages,
            extraParams: [result.family, result.days],
          }),
        ]
      : [];

  return { embeds: [embed], components };
}

const history: Command = {
  category: 'economie',
  cooldown: { seconds: 2 },
  ephemeral: true,
  dmAllowed: true,
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Where did my coins go? Your ledger, filtered by family and period')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Family of operations to show (default: all)')
        .addChoices(
          ...HISTORY_FAMILY_CHOICES.map((family) => ({
            name: FAMILY_CHOICE_LABELS[family],
            value: family,
          })),
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('days')
        .setDescription('How far back to look (default: 7 days)')
        .addChoices(
          { name: 'Last 24 hours', value: 1 },
          { name: 'Last 7 days', value: 7 },
          { name: 'Last 30 days', value: 30 },
          { name: 'Last 90 days', value: 90 },
        ),
    )
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page number (10 operations per page)')
        .setMinValue(1)
        .setMaxValue(10_000),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(
      await historyView(context, {
        family: normalizeFamily(interaction.options.getString('type')),
        days: normalizeDays(interaction.options.getInteger('days')),
        page: interaction.options.getInteger('page') ?? 1,
      }),
    );
  },
};

export const commands: Command[] = [history];
