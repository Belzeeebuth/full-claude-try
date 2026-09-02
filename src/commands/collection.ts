import {
  ButtonStyle,
  SlashCommandBuilder,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
} from 'discord.js';
import type { DiscoveryKind } from '../config/gameplay/schemas';
import { COLORS, baseEmbed, button, paginationRow, row } from '../framework/ui';
import { variantIcon } from '../game/animals';
import { DISCOVERY_KINDS, maskedName, normalizeKind, type CollectionLine } from '../game/collection';
import * as collectionService from '../services/collection.service';
import { formatNumber, progressBar, qualityIcon, truncate } from '../utils/format';
import type { Command, CommandContext, Translator } from '../types';

/**
 * `/collection` — ce que le fermier a déjà découvert, famille par famille.
 *
 * PUBLIC, à dessein : une collection est faite pour être montrée, comme un
 * profil. Les boutons restent la propriété de l'auteur (`ownerId`), donc un
 * curieux voit la page mais ne la feuillette pas à sa place — il tape sa
 * propre commande.
 *
 * Une entrée jamais obtenue s'affiche `???` avec sa rareté et son niveau
 * requis, rien d'autre : on donne envie (« un mythique au niveau 40 ») sans
 * spoiler le nom. Le custom_id transporte famille et page — pas d'état
 * serveur à retrouver, un bouton d'une ancienne version retombe sur des
 * valeurs sûres.
 */

/** Emoji de chaque famille, dans les boutons comme dans l'en-tête. */
export const KIND_EMOJI: Record<DiscoveryKind, string> = {
  crop: '🌾',
  product: '🧀',
  animal: '🐄',
  fish: '🐟',
  ore: '⛏️',
  variant: '✨',
};

/** Libellés des choix Discord : ils partent dans le payload, donc en anglais. */
const KIND_CHOICE_LABELS: Record<DiscoveryKind, string> = {
  crop: 'Crops',
  product: 'Products',
  animal: 'Animals',
  fish: 'Fish',
  ore: 'Ores',
  variant: 'Variants (shiny, golden)',
};

/**
 * Un embed ne colore pas le texte : la rareté est portée par une pastille
 * de la même teinte que `RARITY_COLORS` (gris, vert, bleu, violet, orange,
 * rouge), lisible même sans lire le mot.
 */
const RARITY_DOTS: Record<string, string> = {
  common: '⚪',
  uncommon: '🟢',
  rare: '🔵',
  epic: '🟣',
  legendary: '🟠',
  mythic: '🔴',
};

export function rarityDot(rarity: string): string {
  return RARITY_DOTS[rarity] ?? '⚪';
}

export interface CollectionViewInput {
  kind: DiscoveryKind;
  page: number;
}

/** Une ligne de la grille : ✅ avec le détail, ou ❔ avec ce qu'on révèle. */
export function formatCollectionLine(line: CollectionLine, t: Translator, locale: string): string {
  const { entry, discovered } = line;
  const name = maskedName(entry, discovered !== null);
  const rarity = t(`common.rarity.${entry.rarity}`);
  const dot = rarityDot(entry.rarity);
  const level = t('common.level_abbr', { level: entry.requiredLevel });

  if (entry.variant) {
    const icon = variantIcon(entry.variant);
    const variant = t(`collection.variant.${entry.variant}`);
    return discovered
      ? t('collection.entry_variant_found', {
          emoji: entry.emoji,
          name,
          icon,
          variant,
          dot,
          rarity,
          count: formatNumber(discovered.count, locale),
        })
      : t('collection.entry_variant_hidden', { name, icon, variant, dot, rarity, level });
  }

  if (!discovered) return t('collection.entry_hidden', { name, dot, rarity, level });

  let best = '';
  if (discovered.bestQuality && discovered.bestQuality !== 'normal') {
    best += t('collection.best_quality', {
      icon: qualityIcon(discovered.bestQuality),
      quality: t(`common.quality.${discovered.bestQuality}`),
    });
  }
  if (discovered.bestVariant && discovered.bestVariant !== 'normal') {
    best += t('collection.best_variant', {
      icon: variantIcon(discovered.bestVariant),
      variant: t(`collection.variant.${discovered.bestVariant}`),
    });
  }
  return t('collection.entry_found', {
    emoji: entry.emoji,
    name,
    dot,
    rarity,
    count: formatNumber(discovered.count, locale),
    best,
  });
}

/** Vue partagée commande ⇄ boutons : une seule mise en page. */
export async function collectionView(
  context: CommandContext,
  input: CollectionViewInput,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const { t, locale, player } = context;
  const view = await collectionService.getCollection(player.id, input, locale);
  const ownerId = player.discordId;

  const percent = view.total > 0 ? Math.round((view.discovered / view.total) * 100) : 0;
  const header = [
    t('collection.progress', {
      emoji: KIND_EMOJI[view.kind],
      label: t(`collection.kind.${view.kind}`),
      discovered: view.discovered,
      total: view.total,
      bar: progressBar(view.discovered, Math.max(1, view.total), 12),
      percent,
    }),
    t('collection.rare_line', { shiny: view.rare.shiny, golden: view.rare.golden }),
  ].join('\n');
  const body = view.lines.length > 0
    ? view.lines.map((line) => formatCollectionLine(line, t, locale)).join('\n')
    : t('collection.empty');

  const allDiscovered = view.totals.reduce((sum, entry) => sum + entry.discovered, 0);
  const allTotal = view.totals.reduce((sum, entry) => sum + entry.total, 0);

  const embed = baseEmbed({
    title: t('collection.title', { name: player.username }),
    description: truncate(`${header}\n\n${body}\n\n*${t('collection.hint')}*`, 4096),
    color: view.discovered >= view.total && view.total > 0 ? COLORS.gold : COLORS.info,
    footer: t('collection.footer', {
      discovered: allDiscovered,
      total: allTotal,
      page: view.page,
      pages: view.totalPages,
    }),
  });

  // Filtres : la famille affichée est en bleu, les autres en gris. Aucune
  // n'est désactivée — un bouton grisé se lit « indisponible », pas « actif ».
  const filter = (kind: DiscoveryKind): ButtonBuilder =>
    button({
      namespace: 'collection',
      action: 'kind',
      ownerId,
      params: [kind],
      label: t(`collection.kind.${kind}`),
      emoji: KIND_EMOJI[kind],
      style: kind === view.kind ? ButtonStyle.Primary : ButtonStyle.Secondary,
    });
  // Six familles pour cinq boutons par rangée : la sixième rejoint le
  // bouton de rafraîchissement sur la seconde.
  const components: ActionRowBuilder<ButtonBuilder>[] = [
    row(...DISCOVERY_KINDS.slice(0, 5).map(filter)),
    row(
      ...DISCOVERY_KINDS.slice(5).map(filter),
      button({
        namespace: 'collection',
        action: 'refresh',
        ownerId,
        params: [view.kind, view.page],
        emoji: '🔄',
      }),
    ),
  ];
  if (view.totalPages > 1) {
    components.push(
      paginationRow({
        namespace: 'collection',
        ownerId,
        page: view.page,
        totalPages: view.totalPages,
        extraParams: [view.kind],
      }),
    );
  }

  return { embeds: [embed], components };
}

const collection: Command = {
  category: 'progression',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('collection')
    .setDescription('Your farmer collection: everything you have discovered so far')
    .addStringOption((option) =>
      option
        .setName('kind')
        .setDescription('Which family to browse (default: crops)')
        .addChoices(
          ...DISCOVERY_KINDS.map((kind) => ({
            name: `${KIND_EMOJI[kind]} ${KIND_CHOICE_LABELS[kind]}`,
            value: kind,
          })),
        ),
    )
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(50),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await collectionView(context, {
        kind: normalizeKind(interaction.options.getString('kind')),
        page: interaction.options.getInteger('page') ?? 1,
      }),
    );
  },
};

export const commands: Command[] = [collection];
