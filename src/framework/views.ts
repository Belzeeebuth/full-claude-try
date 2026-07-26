import { ButtonStyle, type AttachmentBuilder, type BaseMessageOptions } from 'discord.js';
import { getConfig } from '../config';
import * as animalService from '../services/animal.service';
import * as coopService from '../services/coop.service';
import * as craftService from '../services/craft.service';
import * as farmService from '../services/farm.service';
import * as inventoryService from '../services/inventory.service';
import * as marketService from '../services/market.service';
import * as progressionService from '../services/progression.service';
import { renderFarmImage } from '../render';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent,
  gaugeBar,
  progressBar,
  qualityIcon,
  mutationIcon,
  rarityLabel,
  truncate,
} from '../utils/format';
import { COLORS, baseEmbed, button, farmShortcutsRow, paginationRow, row, select, selectRow } from './ui';
import type { CommandContext } from '../types';

/**
 * Vues partagées entre commandes et composants.
 *
 * Une commande et le bouton « Rafraîchir » du même message doivent produire
 * EXACTEMENT le même rendu. Les construire ici, une seule fois, garantit cette
 * cohérence : `/farm` et le bouton appellent tous deux `farmView()`.
 */

export interface View extends BaseMessageOptions {
  files?: AttachmentBuilder[];
}

// ---------------------------------------------------------------------------
// FERME
// ---------------------------------------------------------------------------

export async function farmView(
  context: CommandContext,
  options: { targetName?: string; avatarUrl?: string | null; readOnly?: boolean } = {},
): Promise<View> {
  const player = context.player;
  const coopLevel = await coopLevelOf(player.coopId);
  const view = await farmService.getFarmView(player, { coopLevel, now: context.now });
  const herd = await animalService.getHerd(player, context.now);

  const xpForNext = (await import('../game/xp')).xpForNextLevel(player.level, context.balance);

  const image = await renderFarmImage({
    locale: context.locale,
    view,
    player: {
      username: options.targetName ?? player.username,
      level: player.level,
      coins: player.coins,
      gems: player.gems,
      avatarUrl: options.avatarUrl ?? null,
    },
    xp: { current: player.xp, needed: xpForNext },
    theme: 'classic',
    animalsPreview: herd.animals.slice(0, 6).map((animal) => ({
      emoji: animal.emoji,
      animalKey: animal.animalKey,
    })),
  });

  const counts = view.counts;
  const embed = baseEmbed({
    title: `🌾 ${view.name}`,
    description: [
      `**${view.world.weather.emoji} ${view.world.weather.label}** — ${view.world.weather.description}`,
      view.world.weather.freeWatering ? '💧 *Arrosage gratuit aujourd\'hui !*' : '',
      '',
      `✅ **${counts.ready}** prête(s) • 🌱 **${counts.growing}** en croissance • ⬜ **${counts.empty}** vide(s) • 🔒 **${counts.locked}** verrouillée(s)`,
      counts.pests > 0 ? `🐛 **${counts.pests}** parcelle(s) infestée(s) — \`/treat\`` : '',
      counts.withered > 0 ? `💀 **${counts.withered}** culture(s) fanée(s)` : '',
      view.nextReadyAt
        ? `⏳ Prochaine récolte ${discordTimestamp(view.nextReadyAt, 'R')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    color: counts.ready > 0 ? COLORS.success : COLORS.primary,
    image: image.fileName ? `attachment://${image.fileName}` : undefined,
  });

  // Repli texte : si le rendu a échoué, on liste les parcelles.
  if (!image.attachment) {
    embed.addFields({
      name: 'Parcelles',
      value:
        view.plots
          .filter((plot) => plot.state !== 'locked')
          .slice(0, 20)
          .map((plot) => {
            if (!plot.crop) return `\`${String(plot.slot).padStart(2, ' ')}\` ⬜ vide`;
            const status = plot.crop.growth.withered
              ? '💀 fanée'
              : plot.crop.growth.ready
                ? '✅ prête'
                : `⏳ ${formatDuration(plot.crop.growth.msRemaining)}`;
            return `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.crop.emoji} ${plot.crop.name} — ${status}${plot.crop.growth.needsWater ? ' 💧' : ''}`;
          })
          .join('\n') || 'Aucune parcelle débloquée.',
    });
  }

  if (options.readOnly) {
    return { embeds: [embed], files: image.attachment ? [image.attachment] : [] };
  }

  return {
    embeds: [embed],
    files: image.attachment ? [image.attachment] : [],
    components: [
      farmShortcutsRow(player.discordId, {
        canHarvest: counts.ready > 0 || counts.withered > 0,
        canWater: counts.growing > 0,
        canPlant: counts.empty > 0,
      }),
      row(
        button({
          namespace: 'farm',
          action: 'plots',
          ownerId: player.discordId,
          label: 'Parcelles',
          emoji: '🗺️',
        }),
        button({
          namespace: 'animal',
          action: 'open',
          ownerId: player.discordId,
          label: 'Animaux',
          emoji: '🐄',
        }),
        button({
          namespace: 'inv',
          action: 'open',
          ownerId: player.discordId,
          label: 'Inventaire',
          emoji: '🎒',
        }),
        button({
          namespace: 'quest',
          action: 'open',
          ownerId: player.discordId,
          label: 'Quêtes',
          emoji: '📋',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// PARCELLES
// ---------------------------------------------------------------------------

export async function plotsView(context: CommandContext, page = 1): Promise<View> {
  const player = context.player;
  const view = await farmService.getFarmView(player, { now: context.now });
  const pageSize = 12;
  const totalPages = Math.max(1, Math.ceil(view.plots.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = view.plots.slice((current - 1) * pageSize, current * pageSize);

  const lines = slice.map((plot) => {
    if (plot.state === 'locked') {
      return `\`${String(plot.slot).padStart(2, ' ')}\` 🔒 Verrouillée — ${formatCoins(plot.unlockCost)}`;
    }
    const soil = `sol ${plot.fertility}% (${plot.fertilityLabel})`;
    if (!plot.crop) {
      return `\`${String(plot.slot).padStart(2, ' ')}\` ⬜ Vide — ${soil}${plot.weedLevel > 30 ? ` • 🌿 herbes ${plot.weedLevel}%` : ''}`;
    }
    const status = plot.crop.growth.withered
      ? '💀 fanée'
      : plot.crop.growth.ready
        ? '✅ **prête**'
        : `⏳ ${discordTimestamp(plot.crop.growth.readyAt, 'R')}`;
    return [
      `\`${String(plot.slot).padStart(2, ' ')}\` ${plot.crop.emoji} **${plot.crop.name}** — ${status}`,
      `      ${soil} • 💧 ${plot.crop.waterGiven}/${plot.crop.waterNeeded}${plot.pestType ? ' • 🐛 nuisibles !' : ''}${plot.crop.regrowRemaining > 0 ? ` • 🔁 ${plot.crop.regrowRemaining} repousse(s)` : ''}`,
    ].join('\n');
  });

  const embed = baseEmbed({
    title: '🗺️ Vos parcelles',
    description: lines.join('\n') || 'Aucune parcelle.',
    color: COLORS.primary,
    fields: [
      {
        name: 'Extension',
        value:
          view.nextPlotCost > 0
            ? `Prochaine parcelle : **${formatCoins(view.nextPlotCost)}** (${view.unlockedPlots}/${context.balance.plots.maxPlots} débloquées)`
            : `Toutes les parcelles sont débloquées (${view.unlockedPlots}) 🏆`,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      paginationRow({
        namespace: 'farm',
        ownerId: player.discordId,
        page: current,
        totalPages,
      }),
      row(
        button({
          namespace: 'farm',
          action: 'buy_plot',
          ownerId: player.discordId,
          label: view.nextPlotCost > 0 ? `Acheter (${formatCompact(view.nextPlotCost)} 🪙)` : 'Complet',
          emoji: '🛒',
          style: ButtonStyle.Success,
          disabled: view.nextPlotCost === 0,
        }),
        button({
          namespace: 'farm',
          action: 'weed_all',
          ownerId: player.discordId,
          label: 'Désherber',
          emoji: '🌿',
        }),
        button({ namespace: 'farm', action: 'refresh', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// INVENTAIRE
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  seed: { label: 'Graines', emoji: '🌱' },
  harvest: { label: 'Récoltes', emoji: '🌾' },
  animal_product: { label: 'Produits animaux', emoji: '🥚' },
  product: { label: 'Produits transformés', emoji: '🧀' },
  tool: { label: 'Outils', emoji: '🛠️' },
  consumable: { label: 'Consommables', emoji: '🧪' },
  material: { label: 'Matériaux', emoji: '🪵' },
  cosmetic: { label: 'Cosmétiques', emoji: '🎨' },
  event: { label: 'Événement', emoji: '🎉' },
};

export async function inventoryView(
  context: CommandContext,
  options: { category?: string; page?: number } = {},
): Promise<View> {
  const player = context.player;
  const page = await inventoryService.getPage(player.id, {
    category: options.category,
    page: options.page,
  });

  const lines = page.entries.map((entry) => {
    const icons = `${qualityIcon(entry.quality)}${mutationIcon(entry.mutation)}`;
    const value = entry.sellable ? ` — ${formatCoins(entry.sellPrice * entry.quantity, true)}` : '';
    return `${entry.emoji} **${entry.name}**${icons} ×${formatNumber(entry.quantity)}${value}`;
  });

  const embed = baseEmbed({
    title: `🎒 Inventaire de ${player.username}`,
    description: lines.join('\n') || '*Aucun objet dans cette catégorie.*',
    color: COLORS.info,
    fields: [
      {
        name: 'Entrepôt',
        value: `${progressBar(page.used, page.capacity, 12)} ${formatNumber(page.used)}/${formatNumber(page.capacity)}`,
        inline: true,
      },
      {
        name: 'Valeur estimée',
        value: formatCoins(page.totalValue, true),
        inline: true,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'inv',
          action: 'category',
          ownerId: player.discordId,
          placeholder: 'Filtrer par catégorie',
          choices: [
            { label: 'Tout', value: 'all', emoji: '📦', default: !options.category },
            ...Object.entries(CATEGORY_LABELS).map(([value, meta]) => ({
              label: meta.label,
              value,
              emoji: meta.emoji,
              default: options.category === value,
            })),
          ],
        }),
      ),
      paginationRow({
        namespace: 'inv',
        ownerId: player.discordId,
        page: page.page,
        totalPages: page.totalPages,
        extraParams: [options.category ?? 'all'],
      }),
      row(
        button({
          namespace: 'inv',
          action: 'sell_menu',
          ownerId: player.discordId,
          label: 'Vendre',
          emoji: '💰',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'farm',
          action: 'refresh',
          ownerId: player.discordId,
          label: 'Ma ferme',
          emoji: '🌾',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// BOUTIQUE
// ---------------------------------------------------------------------------

export async function shopView(context: CommandContext, category?: string): Promise<View> {
  const player = context.player;
  const entries = await marketService.getShop(context.now);
  const filtered = category ? entries.filter((entry) => entry.category === category) : entries;

  const grouped = new Map<string, typeof filtered>();
  for (const entry of filtered) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }

  const CATEGORY_TITLES: Record<string, string> = {
    daily: '✨ Offres du jour',
    seeds: '🌱 Graines',
    supplies: '📦 Fournitures',
  };

  const fields = [...grouped.entries()].map(([key, list]) => ({
    name: CATEGORY_TITLES[key] ?? key,
    value: list
      .slice(0, 10)
      .map((entry) => {
        const price = `${formatNumber(entry.price)} ${entry.currency === 'gems' ? '💎' : COIN}`;
        const discount = entry.discountPercent > 0 ? ` ~~-${entry.discountPercent}%~~` : '';
        const stock =
          entry.stockRemaining >= 999
            ? ''
            : entry.stockRemaining <= 0
              ? ' — **épuisé**'
              : ` — ${entry.stockRemaining} en stock`;
        const level = entry.requiredLevel > player.level ? ` 🔒 niv. ${entry.requiredLevel}` : '';
        return `${entry.emoji} **${entry.name}** — ${price}${discount}${stock}${level}`;
      })
      .join('\n'),
  }));

  const first = entries[0];
  const embed = baseEmbed({
    title: '🏪 Boutique du village',
    description: first
      ? `Stock renouvelé ${discordTimestamp(first.expiresAt, 'R')}.\nUtilisez \`/buy\` ou le menu ci-dessous.`
      : 'La boutique est vide pour le moment.',
    color: COLORS.gold,
    fields,
  });

  const buyable = filtered.filter(
    (entry) => entry.stockRemaining > 0 && entry.requiredLevel <= player.level,
  );

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'shop',
          action: 'buy',
          ownerId: player.discordId,
          placeholder: 'Acheter un article',
          choices: buyable.slice(0, 25).map((entry) => ({
            label: `${entry.name} — ${entry.price} ${entry.currency === 'gems' ? 'gemmes' : 'pièces'}`,
            value: entry.itemKey,
            emoji: entry.emoji,
            description: truncate(entry.description ?? '', 100),
          })),
          disabled: buyable.length === 0,
        }),
      ),
      row(
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['all'],
          label: 'Tout',
          emoji: '📦',
        }),
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['daily'],
          label: 'Offres du jour',
          emoji: '✨',
        }),
        button({
          namespace: 'shop',
          action: 'filter',
          ownerId: player.discordId,
          params: ['seeds'],
          label: 'Graines',
          emoji: '🌱',
        }),
        button({ namespace: 'shop', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// MARCHÉ
// ---------------------------------------------------------------------------

export async function marketView(context: CommandContext, category?: string): Promise<View> {
  const rows = await marketService.getMarket({ category });
  const sorted = [...rows].sort((a, b) => b.trend - a.trend);
  const top = sorted.slice(0, 8);
  const bottom = sorted.slice(-8).reverse();

  const format = (entry: (typeof rows)[number]): string =>
    `${entry.trendEmoji} ${entry.emoji} **${entry.name}** — ${formatNumber(entry.price)} ${COIN} (${formatPercent(entry.trend)})`;

  const embed = baseEmbed({
    title: '📊 Marché de Val-Verdoyant',
    description: [
      'Les prix évoluent chaque heure selon ce que les fermiers vendent.',
      rows[0] ? `Prochaine mise à jour ${discordTimestamp(rows[0].nextUpdateAt, 'R')}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    color: COLORS.info,
    fields: [
      { name: '📈 En hausse', value: top.map(format).join('\n') || '—', inline: false },
      { name: '📉 En baisse', value: bottom.map(format).join('\n') || '—', inline: false },
    ],
  });

  const featured = rows.filter((entry) => entry.featured);
  if (featured.length > 0) {
    embed.addFields({
      name: '⭐ Produits vedettes (prix majoré)',
      value: featured.map((entry) => `${entry.emoji} ${entry.name}`).join(' • '),
    });
  }

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'market',
          action: 'chart',
          ownerId: context.player.discordId,
          placeholder: 'Voir le graphique d\'un produit',
          choices: sorted.slice(0, 25).map((entry) => ({
            label: `${entry.name} — ${entry.price} 🪙`,
            value: entry.itemKey,
            emoji: entry.emoji,
            description: `${entry.trendLabel} • ${rarityLabel(entry.rarity)}`,
          })),
        }),
      ),
      row(
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['harvest'],
          label: 'Récoltes',
          emoji: '🌾',
        }),
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['product'],
          label: 'Produits',
          emoji: '🧀',
        }),
        button({
          namespace: 'market',
          action: 'filter',
          ownerId: context.player.discordId,
          params: ['animal_product'],
          label: 'Élevage',
          emoji: '🥚',
        }),
        button({
          namespace: 'market',
          action: 'open',
          ownerId: context.player.discordId,
          emoji: '🔄',
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// ANIMAUX
// ---------------------------------------------------------------------------

export async function animalsView(context: CommandContext, page = 1): Promise<View> {
  const player = context.player;
  const herd = await animalService.getHerd(player, context.now);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(herd.animals.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = herd.animals.slice((current - 1) * pageSize, current * pageSize);

  const lines = slice.map((animal) => {
    const production = animal.canCollect
      ? `✅ **${animal.status.readyProduction}× ${animal.productEmoji}**`
      : animal.status.nextProductionAt
        ? `⏳ ${discordTimestamp(animal.status.nextProductionAt, 'R')}`
        : '—';
    return [
      `${animal.emoji} **${animal.nickname ?? animal.name}** — ${animal.status.mood}`,
      `   🍽️ ${gaugeBar(animal.status.hunger, 5)} ${animal.status.hunger}%  💛 ${gaugeBar(animal.status.happiness, 5)} ${animal.status.happiness}%  ❤️ ${animal.status.health}%`,
      `   ${production}${animal.generation > 1 ? ` • gén. ${animal.generation}` : ''}${animal.qualityMultiplier !== 1 ? ` • ×${animal.qualityMultiplier.toFixed(2)}` : ''}`,
    ].join('\n');
  });

  const embed = baseEmbed({
    title: `🐄 Cheptel de ${player.username}`,
    description:
      lines.join('\n\n') ||
      "*Aucun animal.*\nConstruisez un poulailler avec `/buildings`, puis achetez une poule avec `/buy-animal`.",
    color: herd.totals.readyToCollect > 0 ? COLORS.success : COLORS.primary,
    fields: [
      {
        name: 'Bâtiments',
        value:
          herd.capacityByBuilding
            .map((entry) => `${entry.emoji} ${entry.name} — ${entry.used}/${entry.capacity} (palier ${entry.tier})`)
            .join('\n') || 'Aucun bâtiment d\'élevage.',
        inline: false,
      },
      {
        name: 'Résumé',
        value: `🐾 ${herd.totals.alive} animal(aux) • 🍽️ ${herd.totals.hungry} affamé(s) • 🤒 ${herd.totals.sick} malade(s) • ✅ ${herd.totals.readyToCollect} à collecter`,
        inline: false,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'animal',
          action: 'collect_all',
          ownerId: player.discordId,
          label: 'Tout collecter',
          emoji: '🥚',
          style: ButtonStyle.Success,
          disabled: herd.totals.readyToCollect === 0,
        }),
        button({
          namespace: 'animal',
          action: 'feed_all',
          ownerId: player.discordId,
          label: 'Tout nourrir',
          emoji: '🌾',
          style: ButtonStyle.Primary,
          disabled: herd.totals.alive === 0,
        }),
        button({
          namespace: 'animal',
          action: 'pet_menu',
          ownerId: player.discordId,
          label: 'Caresser',
          emoji: '🤍',
          disabled: herd.totals.alive === 0,
        }),
        button({ namespace: 'animal', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
      ...(totalPages > 1
        ? [paginationRow({ namespace: 'animal', ownerId: player.discordId, page: current, totalPages })]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// QUÊTES
// ---------------------------------------------------------------------------

export async function questsView(
  context: CommandContext,
  type?: 'daily' | 'weekly' | 'story' | 'contract',
): Promise<View> {
  const player = context.player;
  const quests = await progressionService.listQuests(player, { type });
  const resets = progressionService.questResetTimes();

  const allSections: Array<{ key: 'daily' | 'weekly' | 'story' | 'contract'; title: string }> = [
    { key: 'daily', title: `📅 Journalières — renouvelées ${discordTimestamp(resets.daily, 'R')}` },
    { key: 'weekly', title: `🗓️ Hebdomadaires — renouvelées ${discordTimestamp(resets.weekly, 'R')}` },
    { key: 'story', title: '📖 Histoire du village' },
    { key: 'contract', title: '📦 Contrats de livraison' },
  ];
  const sections = allSections.filter((section) => !type || section.key === type);

  const fields = sections
    .map((section) => {
      const list = quests.filter((quest) => quest.type === section.key);
      if (list.length === 0) return undefined;
      return {
        name: section.title,
        value: list
          .map((quest) => {
            const status =
              quest.status === 'claimed'
                ? '✅ perçue'
                : quest.status === 'completed'
                  ? '🎁 **à réclamer**'
                  : `${progressBar(quest.progress, quest.required, 8)} ${quest.progress}/${quest.required}`;
            const rewards = [
              quest.rewards.coins ? `${formatCompact(quest.rewards.coins)} 🪙` : '',
              quest.rewards.gems ? `${quest.rewards.gems} 💎` : '',
              quest.rewards.xp ? `${formatCompact(quest.rewards.xp)} ✨` : '',
            ]
              .filter(Boolean)
              .join(' • ');
            return `**${quest.title}**\n${quest.description}\n${status} — ${rewards}`;
          })
          .join('\n\n'),
      };
    })
    .filter((field): field is NonNullable<typeof field> => field !== undefined);

  const claimable = quests.filter((quest) => quest.status === 'completed');

  const embed = baseEmbed({
    title: `📋 Quêtes de ${player.username}`,
    description:
      claimable.length > 0
        ? `🎁 **${claimable.length} récompense(s)** vous attendent !`
        : 'Terminez vos quêtes pour gagner pièces, XP et progression du passe.',
    color: claimable.length > 0 ? COLORS.gold : COLORS.primary,
    fields,
  });

  const rerollable = quests.filter((quest) => quest.type === 'daily' && quest.status === 'active');

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'quest',
          action: 'claim_all',
          ownerId: player.discordId,
          label: `Tout réclamer (${claimable.length})`,
          emoji: '🎁',
          style: ButtonStyle.Success,
          disabled: claimable.length === 0,
        }),
        button({
          namespace: 'quest',
          action: 'filter',
          ownerId: player.discordId,
          params: ['daily'],
          label: 'Journalières',
          emoji: '📅',
        }),
        button({
          namespace: 'quest',
          action: 'filter',
          ownerId: player.discordId,
          params: ['weekly'],
          label: 'Hebdo',
          emoji: '🗓️',
        }),
        button({
          namespace: 'quest',
          action: 'open',
          ownerId: player.discordId,
          emoji: '🔄',
        }),
      ),
      ...(rerollable.length > 0
        ? [
            selectRow(
              select({
                namespace: 'quest',
                action: 'reroll',
                ownerId: player.discordId,
                placeholder: 'Relancer une quête journalière',
                choices: rerollable.slice(0, 25).map((quest) => ({
                  label: truncate(quest.title, 90),
                  value: quest.id,
                  description: truncate(quest.description, 100),
                  emoji: '🔄',
                })),
              }),
            ),
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// COOPÉRATIVE
// ---------------------------------------------------------------------------

export async function coopView(context: CommandContext): Promise<View> {
  const player = context.player;
  if (!player.coopId) {
    const publics = await coopService.listPublicCoops(8);
    return {
      embeds: [
        baseEmbed({
          title: '🤝 Coopératives',
          description:
            "Vous n'êtes dans aucune coopérative.\n" +
            'Rejoignez-en une pour bénéficier de bonus collectifs, d\'objectifs hebdomadaires et d\'une trésorerie commune.',
          color: COLORS.info,
          fields: [
            {
              name: 'Coopératives ouvertes',
              value:
                publics
                  .map(
                    (coop) =>
                      `${coop.emblem} **${coop.name}** \`[${coop.tag}]\` — niv. ${coop.level} • ${coop.memberCount}/${coop.memberLimit} membres`,
                  )
                  .join('\n') || 'Aucune coopérative publique pour le moment.',
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'coop',
            action: 'create',
            ownerId: player.discordId,
            label: 'Créer une coopérative',
            emoji: '➕',
            style: ButtonStyle.Success,
          }),
        ),
        ...(publics.length > 0
          ? [
              selectRow(
                select({
                  namespace: 'coop',
                  action: 'join',
                  ownerId: player.discordId,
                  placeholder: 'Rejoindre une coopérative',
                  choices: publics.map((coop) => ({
                    label: `${coop.name} [${coop.tag}]`,
                    value: coop.tag,
                    emoji: coop.emblem,
                    description: truncate(
                      coop.description ?? `Niveau ${coop.level} • ${coop.memberCount} membres`,
                      100,
                    ),
                  })),
                }),
              ),
            ]
          : []),
      ],
    };
  }

  const info = await coopService.getCoopInfo(player.coopId, player.id);
  const objectives = await coopService.listObjectives(player.coopId, context.now);
  const members = await coopService.listMembers(player.coopId);

  const embed = baseEmbed({
    title: `${info.emblem} ${info.name} [${info.tag}]`,
    description: info.description ?? '*Aucune description.*',
    color: COLORS.primary,
    fields: [
      {
        name: 'Progression',
        value: `Niveau **${info.level}**\n${progressBar(info.xp, info.xpForNext || 1, 12)} ${formatCompact(info.xp)}/${formatCompact(info.xpForNext)}`,
        inline: true,
      },
      {
        name: 'Trésorerie',
        value: formatCoins(info.treasury, true),
        inline: true,
      },
      {
        name: 'Membres',
        value: `${info.memberCount}/${info.memberLimit}`,
        inline: true,
      },
      {
        name: '🎁 Bonus collectifs',
        value: [
          `🌱 Vitesse de pousse **+${(info.bonuses.growthSpeed * 100).toFixed(1)} %**`,
          `💰 Prix de vente **+${(info.bonuses.sellBonus * 100).toFixed(1)} %**`,
          `✨ XP **+${(info.bonuses.xpBonus * 100).toFixed(1)} %**`,
          `🥇 Qualité **+${(info.bonuses.qualityBonus * 100).toFixed(1)} %**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎯 Objectifs de la semaine',
        value:
          objectives
            .map(
              (objective) =>
                `**${objective.title}** ${objective.status === 'completed' ? '✅' : ''}\n${progressBar(objective.progress, objective.target, 10)} ${formatCompact(objective.progress)}/${formatCompact(objective.target)} — ${formatCompact(objective.rewardCoins)} 🪙`,
            )
            .join('\n') || 'Aucun objectif actif.',
        inline: false,
      },
      {
        name: '👥 Meilleurs contributeurs',
        value:
          members
            .slice(0, 5)
            .map(
              (member, index) =>
                `${index + 1}. **${member.username}** (${coopService.ROLE_LABELS[member.member.role as 'owner' | 'officer' | 'member']}) — ${formatCompact(member.member.weeklyContribution)} 🪙`,
            )
            .join('\n') || '—',
        inline: false,
      },
    ],
  });

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'coop',
          action: 'contribute',
          ownerId: player.discordId,
          label: 'Contribuer',
          emoji: '💰',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'coop',
          action: 'members',
          ownerId: player.discordId,
          label: 'Membres',
          emoji: '👥',
        }),
        button({
          namespace: 'coop',
          action: 'objectives',
          ownerId: player.discordId,
          label: 'Objectifs',
          emoji: '🎯',
        }),
        button({ namespace: 'coop', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// PRODUCTION / BÂTIMENTS
// ---------------------------------------------------------------------------

export async function productionView(context: CommandContext): Promise<View> {
  const player = context.player;
  const lines = await craftService.listProduction(player);
  const ready = lines.filter((line) => line.ready);

  const embed = baseEmbed({
    title: '🛠️ File de production',
    description:
      lines
        .map(
          (line) =>
            `${line.buildingEmoji} **${line.recipeName}** ×${line.quantity} — ${
              line.ready ? '✅ **prêt**' : `⏳ ${discordTimestamp(line.finishAt, 'R')}`
            }\n   → ${line.outputQuantity}× ${line.outputName}`,
        )
        .join('\n') || '*Aucune production en cours.* Lancez-en une avec `/craft`.',
    color: ready.length > 0 ? COLORS.success : COLORS.primary,
  });

  return {
    embeds: [embed],
    components: [
      row(
        button({
          namespace: 'craft',
          action: 'collect_all',
          ownerId: player.discordId,
          label: `Tout collecter (${ready.length})`,
          emoji: '📦',
          style: ButtonStyle.Success,
          disabled: ready.length === 0,
        }),
        button({
          namespace: 'craft',
          action: 'recipes',
          ownerId: player.discordId,
          label: 'Recettes',
          emoji: '📜',
        }),
        button({
          namespace: 'build',
          action: 'open',
          ownerId: player.discordId,
          label: 'Bâtiments',
          emoji: '🏗️',
        }),
        button({ namespace: 'craft', action: 'queue', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

export async function buildingsView(context: CommandContext): Promise<View> {
  const player = context.player;
  const buildings = await craftService.listBuildings(player);

  const groups = new Map<string, typeof buildings>();
  for (const building of buildings) {
    const list = groups.get(building.category) ?? [];
    list.push(building);
    groups.set(building.category, list);
  }

  const CATEGORY_TITLES: Record<string, string> = {
    livestock: '🐄 Élevage',
    production: '🏭 Transformation',
    storage: '📦 Stockage',
    utility: '🔧 Utilitaires',
  };

  const embed = baseEmbed({
    title: '🏗️ Bâtiments de la ferme',
    description: 'Améliorez vos bâtiments pour augmenter capacité, vitesse et emplacements.',
    color: COLORS.primary,
    fields: [...groups.entries()].map(([category, list]) => ({
      name: CATEGORY_TITLES[category] ?? category,
      value: list
        .map((building) => {
          const state = building.owned
            ? `palier **${building.tier}**/${building.maxTier}`
            : '*non construit*';
          const next = building.nextTier
            ? ` → ${formatCompact(building.nextTier.costCoins)} 🪙${
                building.nextTier.costItems.length > 0
                  ? ` + ${building.nextTier.costItems.map((cost) => `${cost.quantity}× ${cost.emoji}`).join(' ')}`
                  : ''
              }${building.nextTier.requiredLevel > player.level ? ` 🔒 niv. ${building.nextTier.requiredLevel}` : ''}`
            : ' ✅ maximum';
          return `${building.emoji} **${building.name}** — ${state}${next}`;
        })
        .join('\n'),
    })),
  });

  const upgradable = buildings.filter(
    (building) => building.nextTier && building.nextTier.requiredLevel <= player.level,
  );

  return {
    embeds: [embed],
    components: [
      selectRow(
        select({
          namespace: 'build',
          action: 'upgrade',
          ownerId: player.discordId,
          placeholder: 'Construire ou améliorer',
          choices: upgradable.slice(0, 25).map((building) => ({
            label: `${building.name} → palier ${building.nextTier!.tier}`,
            value: building.key,
            emoji: building.emoji,
            description: `${formatCompact(building.nextTier!.costCoins)} pièces`,
          })),
          disabled: upgradable.length === 0,
        }),
      ),
      row(
        button({
          namespace: 'craft',
          action: 'queue',
          ownerId: player.discordId,
          label: 'Production',
          emoji: '🛠️',
        }),
        button({ namespace: 'build', action: 'open', ownerId: player.discordId, emoji: '🔄' }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Niveau de la coopérative d'un joueur (0 s'il n'en a pas). */
export async function coopLevelOf(coopId: string | null): Promise<number> {
  if (!coopId) return 0;
  try {
    const info = await coopService.getCoopInfo(coopId);
    return info.level;
  } catch {
    return 0;
  }
}

export { getConfig };
