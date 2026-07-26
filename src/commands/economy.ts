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
    .setDescription('Boutique du village (stock renouvelé chaque jour)')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filtrer la boutique')
        .addChoices(
          { name: '✨ Offres du jour', value: 'daily' },
          { name: '🌱 Graines', value: 'seeds' },
          { name: '📦 Fournitures', value: 'supplies' },
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
    .setDescription('Achète un article de la boutique')
    .addStringOption((option) =>
      option.setName('item').setDescription("L'article à acheter").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('Combien ?').setMinValue(1).setMaxValue(999),
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
          '🛒 Achat effectué',
          `${result.quantity}× ${result.emoji} **${result.name}** pour **${
            result.currency === 'gems' ? `${formatNumber(result.total)} 💎` : formatCoins(result.total)
          }**.\nStock restant : ${result.stockRemaining >= 999 ? 'illimité' : result.stockRemaining}`,
        ),
      ],
    });
  },

  async autocomplete(interaction): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const entries = await marketService.getShop();
    await interaction.respond(
      entries
        .filter((entry) => !query || entry.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(
            `${entry.emoji} ${entry.name} — ${formatNumber(entry.price)} ${entry.currency === 'gems' ? 'gemmes' : 'pièces'}`,
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
    .setDescription('Vend des objets au village')
    .addStringOption((option) =>
      option.setName('item').setDescription("L'objet à vendre").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('quantity').setDescription('Un nombre, ou « tout »').setMaxLength(10),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const raw = (interaction.options.getString('quantity') ?? 'tout').toLowerCase();
    const quantity = raw === 'tout' || raw === 'all' ? ('all' as const) : Number.parseInt(raw, 10);

    if (quantity !== 'all' && (!Number.isFinite(quantity) || quantity <= 0)) {
      throw gameError('quantity_invalid', 'Quantité invalide : indiquez un nombre ou « tout ».');
    }

    const result = await marketService.sell(context.player, {
      itemKey,
      quantity,
      discordGuildId: context.discordGuildId,
    });

    const embed = successEmbed(
      '💰 Vente conclue',
      result.lines
        .map(
          (line) =>
            `${line.emoji} **${formatNumber(line.quantity)}× ${line.name}**${qualityIcon(line.quality)} — ${formatNumber(line.unitPrice)} ${COIN}/u`,
        )
        .join('\n'),
    );
    embed.addFields({
      name: 'Total',
      value: `Brut **${formatCoins(result.gross)}**${result.tax > 0 ? ` — taxe ${formatCoins(result.tax)}` : ''} → **${formatCoins(result.net)}** encaissés`,
    });
    appendTracking(embed, result.tracking);

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
    .setDescription('Prix du marché et tendances')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filtrer par type de produit')
        .addChoices(
          { name: '🌾 Récoltes', value: 'harvest' },
          { name: '🥚 Produits animaux', value: 'animal_product' },
          { name: '🧀 Produits transformés', value: 'product' },
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
    .setDescription("Graphique d'évolution du prix d'un produit")
    .addStringOption((option) =>
      option.setName('item').setDescription('Le produit à analyser').setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await sendMarketChart(interaction, context, interaction.options.getString('item', true));
  },

  async autocomplete(interaction): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    const rows = await marketService.getMarket({});
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
  const rows = await marketService.getMarket({});
  const row = rows.find((entry) => entry.itemKey === itemKey);
  if (!row) throw gameError('not_found', `${item.name} n'est pas suivi par le marché.`);

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
        title: `${item.emoji} ${item.name} — marché`,
        description: [
          `Prix actuel : **${formatNumber(row.price)} ${COIN}** ${trend.emoji} ${trend.label} (${formatPercent(row.trend)})`,
          `Prix de référence : ${formatNumber(row.basePrice)} ${COIN}`,
          `Indice de demande : **${row.demandIndex.toFixed(2)}** ${row.demandIndex > 1 ? '(pénurie — vendez !)' : '(marché saturé — attendez)'}`,
          `Prochaine mise à jour ${discordTimestamp(row.nextUpdateAt, 'R')}`,
        ].join('\n'),
        color: row.trend >= 0 ? COLORS.success : COLORS.danger,
        image: image.fileName ? `attachment://${image.fileName}` : undefined,
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
    .setDescription('Votre inventaire, paginé par catégorie')
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Filtrer')
        .addChoices(
          { name: '🌱 Graines', value: 'seed' },
          { name: '🌾 Récoltes', value: 'harvest' },
          { name: '🥚 Produits animaux', value: 'animal_product' },
          { name: '🧀 Produits transformés', value: 'product' },
          { name: '🛠️ Outils', value: 'tool' },
          { name: '🧪 Consommables', value: 'consumable' },
          { name: '🪵 Matériaux', value: 'material' },
          { name: '🎨 Cosmétiques', value: 'cosmetic' },
          { name: '🎉 Événement', value: 'event' },
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
    .setDescription("Fiche détaillée d'un objet")
    .addStringOption((option) =>
      option.setName('name').setDescription("L'objet").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const item = inventoryService.requireItem(interaction.options.getString('name', true));
    const market = await marketService.getMarket({});
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
          description: item.description ?? '*Aucune description.*',
          color: COLORS.info,
          fields: [
            {
              name: 'Informations',
              value: [
                `Catégorie : **${item.category}**`,
                `Rareté : **${item.rarity}**`,
                item.basePrice > 0 ? `Achat : **${formatNumber(item.basePrice)} ${COIN}**` : '',
                item.sellable ? `Vente : **${formatNumber(price?.price ?? item.sellPrice)} ${COIN}**` : 'Non vendable',
                item.tradable ? 'Échangeable ✅' : 'Non échangeable ❌',
                `Vous en possédez : **${formatNumber(owned)}**`,
              ]
                .filter(Boolean)
                .join('\n'),
              inline: true,
            },
            ...(producedBy.length > 0
              ? [
                  {
                    name: 'Fabriqué par',
                    value: producedBy.map((recipe) => `${recipe.emoji} \`${recipe.name}\``).join('\n'),
                    inline: true,
                  },
                ]
              : []),
            ...(usedIn.length > 0
              ? [
                  {
                    name: 'Utilisé dans',
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
    .setDescription('Utilise un objet consommable')
    .addStringOption((option) =>
      option.setName('item').setDescription("L'objet à utiliser").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('Combien ?').setMinValue(1).setMaxValue(50),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const itemKey = interaction.options.getString('item', true);
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const item = inventoryService.requireItem(itemKey);

    if (!item.effect?.type) {
      throw gameError('item_unknown', `${item.emoji} ${item.name} ne s'utilise pas directement.`);
    }

    const { useConsumable } = await import('../services/consumable.service');
    const result = await useConsumable(context.player, itemKey, quantity);

    await interaction.editReply({
      embeds: [successEmbed(`${item.emoji} ${item.name} utilisé`, result.message)],
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
    .setDescription('Jette définitivement des objets')
    .addStringOption((option) =>
      option.setName('item').setDescription("L'objet à jeter").setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((option) =>
      option.setName('quantity').setDescription('Combien ?').setRequired(true).setMinValue(1),
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
          description: `Jeter **${quantity}× ${item.emoji} ${item.name}** ? Cette action est irréversible et ne rapporte rien.\n\n*Astuce : \`/sell\` rapporte des pièces.*`,
          color: COLORS.warning,
        }),
      ],
      components: [
        (await import('../framework/ui')).confirmRow({
          namespace: 'inv',
          action: 'discard',
          ownerId: interaction.user.id,
          params: [itemKey, quantity],
          confirmLabel: 'Jeter',
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
    .setDescription('Votre compte en banque')
    .addSubcommand((sub) => sub.setName('balance').setDescription('Consulter votre compte'))
    .addSubcommand((sub) =>
      sub
        .setName('deposit')
        .setDescription('Déposer des pièces')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Montant').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('withdraw')
        .setDescription('Retirer des pièces')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('Montant').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('upgrade').setDescription('Améliorer votre coffre'))
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
            sub === 'deposit' ? '🏦 Dépôt effectué' : '🏦 Retrait effectué',
            `Compte : **${formatCoins(result.balance)}** / ${formatCompact(result.capacity)}\nEn poche : **${formatCoins(result.walletBalance)}**`,
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
            '🏦 Banque améliorée',
            `Palier **${result.tier}** — capacité portée à **${formatCoins(result.capacity)}**.`,
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
          title: '🏦 Banque de Val-Verdoyant',
          description: [
            `Compte : **${formatCoins(status.balance)}** / ${formatCompact(status.capacity)}`,
            `En poche : **${formatCoins(status.walletBalance)}**`,
            `Intérêts : **${(status.interestRate * 100).toFixed(2)} %/jour** (plafonnés)`,
            '',
            "L'argent en banque est protégé et génère des intérêts quotidiens.",
            nextTier
              ? `\nProchain palier : niveau ${nextTier.requiredLevel} requis, ${formatCoins(nextTier.upgradeCost)} → capacité ${formatCompact(nextTier.capacity)}`
              : '\n🏆 Palier maximum atteint.',
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
    .setDescription('Offre des pièces à un autre fermier')
    .addUserOption((option) =>
      option.setName('user').setDescription('Le bénéficiaire').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('amount').setDescription('Montant en pièces').setRequired(true).setMinValue(1),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.bot) throw gameError('target_invalid', 'Les robots n\'ont pas de portefeuille.');
    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);

    const result = await economyService.gift(context.player, targetUser.id, amount, {
      discordGuildId: context.discordGuildId,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          '🎁 Don effectué',
          `${target} reçoit **${formatCoins(result.received)}**.\n` +
            `*Taxe de transfert : ${formatCoins(result.tax)} (${(context.balance.economy.giftTaxRate * 100).toFixed(0)} %).*`,
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
