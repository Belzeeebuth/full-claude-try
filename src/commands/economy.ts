import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { inventoryView, marketView, shopView } from '../framework/views';
import { renderChartImage } from '../render';
import * as economyService from '../services/economy.service';
import * as marketService from '../services/market.service';
import * as inventoryService from '../services/inventory.service';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import { describeTrend } from '../game/market';
import { gameError } from '../utils/errors';
import {
  COIN,
  discordTimestamp,
  formatCoins,
  formatCompact,
  formatNumber,
  formatPercent,
  qualityIcon,
  truncate,
} from '../utils/format';
import { appendTracking } from './farm';
import type { Command } from '../types';

/** Boutique, marché, vente, banque, dons et inventaire. */

// ---------------------------------------------------------------------------
// /shop et /buy
// ---------------------------------------------------------------------------

const boutique: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Village shop — stock refreshes daily')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter the shop')
        .addChoices(
          { name: "✨ Today's deals", value: 'daily' },
          { name: '🌱 Seeds', value: 'seeds' },
          { name: '📦 Supplies', value: 'supplies' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await shopView(context, interaction.options.getString('category') ?? undefined),
    );
  },
};

const acheter: Command = {
  category: 'economie',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to buy").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setMinValue(1).setMaxValue(999),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const result = await marketService.buy(context.player, {
      itemKey: interaction.options.getString('item', true),
      quantity: interaction.options.getInteger('quantity') ?? 1,
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🛒 Purchase complete',
          `${result.quantity}× ${result.emoji} **${result.name}** for **${
            result.currency === 'gems' ? `${formatNumber(result.total)} 💎` : formatCoins(result.total)
          }**.\nStock restant : ${result.stockRemaining >= 999 ? 'unlimited' : result.stockRemaining}`,
        ),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await marketService.getShop(new Date(), context.locale);
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(
            `${entry.emoji} ${entry.name} — ${formatNumber(entry.price)} ${entry.currency === 'gems' ? 'gems' : 'coins'}`,
            100,
          ),
          value: entry.itemKey,
        })),
    );
  },
};

// ---------------------------------------------------------------------------
// /sell
// ---------------------------------------------------------------------------

const vendre: Command = {
  category: 'economie',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell items to the village')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to sell").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('quantity').setDescription('A number, or \"all\"').setMaxLength(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const raw = (interaction.options.getString('quantity') ?? 'tout').toLowerCase();
    const quantity = raw === 'tout' || raw === 'all' ? ('all' as const) : Number.parseInt(raw, 10);

    if (quantity !== 'all' && (!Number.isFinite(quantity) || quantity <= 0)) {
      throw gameError('quantity_invalid', context.t('economy.invalid_quantity_or_all'));
    }

    const result = await marketService.sell(context.player, {
      itemKey,
      quantity,
      discordGuildId: context.discordGuildId,
    });

    const embed = successEmbed(
      '💰 Sale completed',
      result.lines
        .map(
          (line) =>
            `${line.emoji} **${formatNumber(line.quantity)}× ${line.name}**${qualityIcon(line.quality)} — ${formatNumber(line.unitPrice)} ${COIN}/u`,
        )
        .join('\n'),
    );
    embed.addFields({
      name: 'Total',
      value: `Brut **${formatCoins(result.gross)}**${result.tax > 0 ? ` — taxe ${formatCoins(result.tax)}` : ''} → **${formatCoins(result.net)}** received`,
    });
    appendTracking(embed, result.tracking, context.t);

    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await inventoryRepo.listInventory(context.playerId, { onlySellable: true });
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(
            `${entry.emoji} ${entry.name}${qualityIcon(entry.quality)} ×${entry.quantity} — ~${formatNumber(entry.sellPrice)} 🪙/u`,
            100,
          ),
          value: entry.itemKey,
        })),
    );
  },
};

// ---------------------------------------------------------------------------
// /market et /market-history
// ---------------------------------------------------------------------------

const marche: Command = {
  category: 'economie',
  cooldown: { seconds: 5, bucket: 'market' },
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('Market prices and trends')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter by product type')
        .addChoices(
          { name: '🌾 Harvests', value: 'harvest' },
          { name: '🥚 Animal products', value: 'animal_product' },
          { name: '🧀 Processed goods', value: 'product' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await marketView(context, interaction.options.getString('category') ?? undefined),
    );
  },
};

const marcheHistorique: Command = {
  category: 'economie',
  cooldown: { seconds: 5, bucket: 'market' },
  data: new SlashCommandBuilder()
    .setName('market-history')
    .setDescription("Price history chart for a product")
    .addStringOption((option) =>
      option.setName('item').setDescription('The product to analyse').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await sendMarketChart(interaction, context, interaction.options.getString('item', true));
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const rows = await marketService.getMarket({}, context.locale);
    await interaction.respond(
      rows
        .filter((row) => !query || row.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((row) => ({
          name: truncate(`${row.emoji} ${row.name} — ${formatNumber(row.price)} 🪙 (${row.trendLabel})`, 100),
          value: row.itemKey,
        })),
    );
  },
};

/** Envoie le graphique de marché d'un produit (réutilisé par le menu déroulant). */
export async function sendMarketChart(
  interaction: { editReply: (payload: import('discord.js').InteractionEditReplyOptions) => Promise<unknown> },
  context: import('../types').CommandContext,
  itemKey: string,
): Promise<void> {
  const item = inventoryService.requireItem(itemKey);
  const rows = await marketService.getMarket({}, context.locale);
  const row = rows.find((entry) => entry.itemKey === itemKey);
  if (!row) throw gameError('not_found', context.t('market.not_tracked', { item: item.name }));

  const points = await marketService.getPriceHistory(itemKey);
  const image = await renderChartImage({
    locale: context.locale,
    title: item.name,
    emoji: item.emoji,
    points: points.length > 0 ? points : [{ price: row.price, recordedAt: new Date() }],
    basePrice: row.basePrice,
    currentPrice: row.price,
    trend: row.trend,
    demandIndex: row.demandIndex,
  });

  const trend = describeTrend(row.trend);
  await interaction.editReply({
    embeds: [
      baseEmbed({
        title: `${item.emoji} ${item.name} — market`,
        description: [
          `Current price: **${formatNumber(row.price)} ${COIN}** ${trend.emoji} ${trend.label} (${formatPercent(row.trend)})`,
          `Base price: ${formatNumber(row.basePrice)} ${COIN}`,
          `Demand index: **${row.demandIndex.toFixed(2)}** ${row.demandIndex > 1 ? '(shortage — sell!)' : '(saturated — wait)'}`,
          `Next update ${discordTimestamp(row.nextUpdateAt, 'R')}`,
        ].join('\n'),
        color: row.trend >= 0 ? COLORS.success : COLORS.danger,
        // Image laissée en pièce jointe libre, hors de l'embed : voir la note
        // détaillée dans `farmView` (src/framework/views.ts). Un embed rend
        // l'image à sa propre largeur (~400 px) ; celle-ci en fait 900 px.
      }),
    ],
    files: image.attachment ? [image.attachment] : [],
  });
}

// ---------------------------------------------------------------------------
// /inventory, /item, /use, /discard
// ---------------------------------------------------------------------------

const inventaire: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Your inventory, paged by category')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filter')
        .addChoices(
          { name: '🌱 Seeds', value: 'seed' },
          { name: '🌾 Harvests', value: 'harvest' },
          { name: '🥚 Animal products', value: 'animal_product' },
          { name: '🧀 Processed goods', value: 'product' },
          { name: '🛠️ Tools', value: 'tool' },
          { name: '🧪 Consumables', value: 'consumable' },
          { name: '🪵 Materials', value: 'material' },
          { name: '🎨 Cosmetics', value: 'cosmetic' },
          { name: '🎉 Event', value: 'event' },
        ),
    )
    .addIntegerOption((option) => option.setName('page').setDescription('Page').setMinValue(1))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await interaction.editReply(
      await inventoryView(context, {
        category: interaction.options.getString('category') ?? undefined,
        page: interaction.options.getInteger('page') ?? 1,
      }),
    );
  },
};

const objet: Command = {
  category: 'inventaire',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('item')
    .setDescription("Detailed item sheet")
    .addStringOption((option) =>
      option.setName('name').setDescription("The item").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const item = inventoryService.requireItem(interaction.options.getString('name', true));
    const market = await marketService.getMarket({}, context.locale);
    const price = market.find((row) => row.itemKey === item.key);
    const owned = context.player.farmId
      ? await inventoryService.count(context.player.id, item.key)
      : 0;

    const usedIn = context.config.recipeList.filter((recipe) =>
      (recipe.ingredients as Array<{ itemKey: string }>).some(
        (ingredient) => ingredient.itemKey === item.key,
      ),
    );
    const producedBy = context.config.recipeList.filter((recipe) => recipe.outputItemKey === item.key);

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: `${item.emoji} ${item.name}`,
          description: item.description ?? '*No description.*',
          color: COLORS.info,
          fields: [
            {
              name: 'Informations',
              value: [
                `Category: **${item.category}**`,
                `Rarity: **${item.rarity}**`,
                item.basePrice > 0 ? `Buy: **${formatNumber(item.basePrice)} ${COIN}**` : '',
                item.sellable ? `Sell: **${formatNumber(price?.price ?? item.sellPrice)} ${COIN}**` : 'Not sellable',
                item.tradable ? 'Tradable ✅' : 'Not tradable ❌',
                `You own: **${formatNumber(owned)}**`,
              ]
                .filter(Boolean)
                .join('\n'),
              inline: true,
            },
            ...(producedBy.length > 0
              ? [
                  {
                    name: 'Crafted by',
                    value: producedBy.map((recipe) => `${recipe.emoji} \`${recipe.name}\``).join('\n'),
                    inline: true,
                  },
                ]
              : []),
            ...(usedIn.length > 0
              ? [
                  {
                    name: 'Used in',
                    value: usedIn
                      .slice(0, 8)
                      .map((recipe) => `${recipe.emoji} \`${recipe.name}\``)
                      .join('\n'),
                    inline: true,
                  },
                ]
              : []),
          ],
        }),
      ],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    await interaction.respond(
      context.config.itemList
        .filter((item) => item.enabled && (!query || item.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((item) => ({ name: truncate(`${item.emoji} ${item.name}`, 100), value: item.key })),
    );
  },
};

const utiliser: Command = {
  category: 'inventaire',
  cooldown: { seconds: 2 },
  data: new SlashCommandBuilder()
    .setName('use')
    .setDescription('Use a consumable item')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to use").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setMinValue(1).setMaxValue(50),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const item = inventoryService.requireItem(itemKey);

    if (!item.effect?.type) {
      throw gameError(
        'item_unknown',
        context.t('errors.consumable.not_directly_usable', { item: item.name }),
      );
    }

    const { useConsumable } = await import('../services/consumable.service');
    const result = await useConsumable(context.player, itemKey, quantity);

    await interaction.editReply({
      embeds: [successEmbed(`${item.emoji} ${item.name} used`, result.message)],
    });
  },

  async autocomplete(interaction, context): Promise<void> {
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await inventoryRepo.listInventory(context.playerId, { category: 'consumable' });
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(`${entry.emoji} ${entry.name} ×${entry.quantity}`, 100),
          value: entry.itemKey,
        })),
    );
  },
};

const jeter: Command = {
  category: 'inventaire',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('discard')
    .setDescription('Permanently discard items')
    .addStringOption((option) =>
      option.setName('item').setDescription("The item to discard").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('How many?').setRequired(true).setMinValue(1),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const itemKey = interaction.options.getString('item', true);
    const quantity = interaction.options.getInteger('quantity', true);
    const item = inventoryService.requireItem(itemKey);

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🗑️ Confirmation',
          description: `Discard **${quantity}× ${item.emoji} ${item.name}**? This cannot be undone and earns you nothing.\n\n*Tip: \`/sell\` pays coins.*`,
          color: COLORS.warning,
        }),
      ],
      components: [
        (await import('../framework/ui')).confirmRow({
          namespace: 'inv',
          action: 'discard',
          ownerId: interaction.user.id,
          params: [itemKey, quantity],
          confirmLabel: 'Discard',
          danger: true,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },

  autocomplete: vendre.autocomplete,
};

// ---------------------------------------------------------------------------
// /bank et /gift
// ---------------------------------------------------------------------------

const banque: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('bank')
    .setDescription('Your bank account')
    .addSubcommand((sub) => sub.setName('balance').setDescription('View your account'))
    .addSubcommand((sub) =>
      sub
        .setName('deposit')
        .setDescription('Deposit coins')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('withdraw')
        .setDescription('Withdraw coins')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('upgrade').setDescription('Upgrade your vault'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'deposit' || sub === 'withdraw') {
      const amount = interaction.options.getInteger('amount', true);
      const result =
        sub === 'deposit'
          ? await economyService.deposit(context.player.id, amount)
          : await economyService.withdraw(context.player.id, amount);

      await interaction.editReply({
        embeds: [
          successEmbed(
            sub === 'deposit' ? '🏦 Deposit complete' : '🏦 Withdrawal complete',
            `Account: **${formatCoins(result.balance)}** / ${formatCompact(result.capacity)}\nIn hand: **${formatCoins(result.walletBalance)}**`,
          ),
        ],
      });
      return;
    }

    if (sub === 'upgrade') {
      const result = await economyService.upgradeBank(context.player.id, context.player.level);
      await interaction.editReply({
        embeds: [
          successEmbed(
            '🏦 Bank upgraded',
            `Tier **${result.tier}** — capacity raised to **${formatCoins(result.capacity)}**.`,
          ),
        ],
      });
      return;
    }

    const status = await economyService.bankStatus(context.player.id);
    const nextTier = context.balance.bank.tiers.find((tier) => tier.tier === status.tier + 1);

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: '🏦 Greenvale bank',
          description: [
            `Account: **${formatCoins(status.balance)}** / ${formatCompact(status.capacity)}`,
            `En poche : **${formatCoins(status.walletBalance)}**`,
            `Interest: **${(status.interestRate * 100).toFixed(2)}%/day** (capped)`,
            '',
            "Money in the bank is protected and earns daily interest.",
            nextTier
              ? `\nNext tier: level ${nextTier.requiredLevel} required, ${formatCoins(nextTier.upgradeCost)} → capacity ${formatCompact(nextTier.capacity)}`
              : '\n🏆 Maximum tier reached.',
          ].join('\n'),
          color: COLORS.gold,
        }),
      ],
    });
  },
};

const donner: Command = {
  category: 'economie',
  cooldown: { seconds: 10 },
  data: new SlashCommandBuilder()
    .setName('gift')
    .setDescription('Send coins to another farmer')
    .addUserOption((option) =>
      option.setName('user').setDescription('The recipient').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('amount').setDescription('Amount in coins').setRequired(true).setMinValue(1),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.bot) throw gameError('target_invalid', context.t('economy.bots_no_wallet'));
    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) {
      throw gameError('not_found', context.t('economy.target_no_farm', { name: target.displayName }));
    }

    const result = await economyService.gift(context.player, targetUser.id, amount, {
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🎁 Gift sent',
          `${target} receives **${formatCoins(result.received)}**.\n` +
            `*Transfer tax: ${formatCoins(result.tax)} (${(context.balance.economy.giftTaxRate * 100).toFixed(0)} %).*`,
        ),
      ],
    });
  },
};

export const commands: Command[] = [
  boutique,
  acheter,
  vendre,
  marche,
  marcheHistorique,
  inventaire,
  objet,
  utiliser,
  jeter,
  banque,
  donner,
];
