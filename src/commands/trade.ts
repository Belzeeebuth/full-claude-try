import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, row, successEmbed } from '../framework/ui';
import * as tradeService from '../services/trade.service';
import * as inventoryService from '../services/inventory.service';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as playerRepo from '../repositories/player.repo';
import { gameError } from '../utils/errors';
import {
  discordTimestamp,
  formatCoins,
  formatNumber,
  qualityIcon,
  truncate,
} from '../utils/format';
import type { Command, CommandContext } from '../types';

/** Hôtel des ventes et échanges directs. */

const hdv: Command = {
  category: 'economie',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('auction')
    .setDescription('Player-to-player auction house')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Browse listings')
        .addStringOption((option) =>
          option.setName('item').setDescription('Filter by item').setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('sell')
        .setDescription('List a stack for sale')
        .addStringOption((option) =>
          option.setName('item').setDescription("The item").setRequired(true).setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option.setName('quantity').setDescription('Quantity').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((option) =>
          option.setName('price').setDescription('Price for the whole stack').setRequired(true).setMinValue(1),
        )
        .addIntegerOption((option) =>
          option
            .setName('duration')
            .setDescription('Duration in hours')
            .addChoices(
              { name: '6 hours', value: 6 },
              { name: '12 hours', value: 12 },
              { name: '24 hours', value: 24 },
              { name: '48 hours', value: 48 },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Buy a listing')
        .addStringOption((option) =>
          option.setName('listing').setDescription("Listing ID").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('my-listings').setDescription('Your listings and their status'))
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a listing that has no bids')
        .addStringOption((option) =>
          option.setName('listing').setDescription("Listing ID").setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'sell': {
        const result = await tradeService.createListing(context.player, {
          itemKey: interaction.options.getString('item', true),
          quantity: interaction.options.getInteger('quantity', true),
          price: interaction.options.getInteger('price', true),
          durationHours: interaction.options.getInteger('duration') ?? undefined,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              '🔨 Annonce publiée',
              [
                `Lot de **${result.quantity}** au prix de **${formatCoins(result.price)}**.`,
                `Frais de mise en vente : ${formatCoins(result.fee)} (non remboursables).`,
                `Expiration ${discordTimestamp(result.expiresAt, 'R')}.`,
                `Commission à la vente : ${(context.balance.auction.commissionRate * 100).toFixed(0)} %.`,
                '',
                `Identifiant : \`${result.id}\``,
              ].join('\n'),
            ),
          ],
        });
        break;
      }
      case 'buy': {
        const result = await tradeService.buyout(
          context.player,
          interaction.options.getString('listing', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              '🛍️ Achat conclu',
              `Vous recevez **${result.quantity}× ${result.emoji} ${result.itemName}** pour ${formatCoins(result.price)}.`,
            ),
          ],
        });
        break;
      }
      case 'cancel': {
        const result = await tradeService.cancelListing(
          context.player,
          interaction.options.getString('listing', true),
        );
        await interaction.editReply({
          embeds: [
            successEmbed(
              '↩️ Annonce annulée',
              `**${result.quantity}× ${result.itemName}** sont de retour dans votre inventaire.\n*Les frais de mise en vente restent acquis au village.*`,
            ),
          ],
        });
        break;
      }
      case 'my-listings': {
        const listings = await tradeService.myListings(context.player.id, 10);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: '📜 Vos annonces',
              description:
                listings
                  .map((entry) => {
                    const status =
                      entry.listing.status === 'sold'
                        ? `✅ vendue ${formatCoins(entry.listing.soldPrice ?? 0)}`
                        : entry.listing.status === 'active'
                          ? `⏳ expire ${discordTimestamp(entry.listing.expiresAt, 'R')}`
                          : entry.listing.status === 'expired'
                            ? '⌛ expirée (objets rendus)'
                            : '↩️ annulée';
                    return `${entry.itemEmoji} **${entry.listing.quantity}× ${entry.itemName}** — ${formatCoins(entry.listing.startPrice)} — ${status}\n\`${entry.listing.id}\``;
                  })
                  .join('\n') || 'Aucune annonce.',
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      default: {
        await interaction.editReply(
          await auctionListView(context, interaction.options.getString('item') ?? undefined, 1),
        );
      }
    }
  },

  async autocomplete(interaction, context): Promise<void> {
    const query = interaction.options.getFocused().toString().toLowerCase();
    if (!context.playerId) {
      await interaction.respond([]);
      return;
    }
    const entries = await inventoryRepo.listInventory(context.playerId, {});
    await interaction.respond(
      entries
        .filter((entry) => entry.tradable && (!query || entry.name.toLowerCase().includes(query)))
        .slice(0, 25)
        .map((entry) => ({
          name: truncate(`${entry.emoji} ${entry.name}${qualityIcon(entry.quality)} ×${entry.quantity}`, 100),
          value: entry.itemKey,
        })),
    );
  },
};

/** Vue paginée de l'hôtel des ventes, réutilisée par les boutons. */
export async function auctionListView(
  context: CommandContext,
  itemKey: string | undefined,
  page: number,
) {
  const result = await tradeService.browse(context.player.id, { itemKey, page });

  const embed = baseEmbed({
    title: '🔨 Hôtel des ventes',
    description:
      result.listings
        .map((listing) => {
          const bid = listing.currentBid
            ? `enchère **${formatCoins(listing.currentBid)}**`
            : `mise à partir de **${formatCoins(listing.startPrice)}**`;
          const buyout = listing.buyoutPrice ? ` • achat immédiat **${formatCoins(listing.buyoutPrice)}**` : '';
          return [
            `${listing.itemEmoji} **${listing.quantity}× ${listing.itemName}**${qualityIcon(listing.quality)}${listing.isOwn ? ' *(votre annonce)*' : ''}`,
            `   ${bid}${buyout} • vendeur : ${listing.sellerName} • expire ${discordTimestamp(listing.expiresAt, 'R')}`,
            `   \`${listing.id}\``,
          ].join('\n');
        })
        .join('\n\n') || 'Aucune annonce en cours. Soyez le premier avec `/auction sell` !',
    color: COLORS.gold,
    footer: `${result.total} annonce(s) • page ${result.page}/${result.totalPages}`,
  });

  const buyable = result.listings.filter((listing) => !listing.isOwn && listing.buyoutPrice);

  return {
    embeds: [embed],
    components: [
      ...(buyable.length > 0
        ? [
            (await import('../framework/ui')).selectRow(
              (await import('../framework/ui')).select({
                namespace: 'hdv',
                action: 'buy',
                ownerId: context.player.discordId,
                placeholder: 'Acheter une annonce',
                choices: buyable.map((listing) => ({
                  label: truncate(`${listing.quantity}× ${listing.itemName} — ${listing.buyoutPrice} 🪙`, 90),
                  value: listing.id,
                  emoji: listing.itemEmoji,
                  description: `Vendeur : ${listing.sellerName}`,
                })),
              }),
            ),
          ]
        : []),
      (await import('../framework/ui')).paginationRow({
        namespace: 'hdv',
        ownerId: context.player.discordId,
        page: result.page,
        totalPages: result.totalPages,
        extraParams: [itemKey ?? 'all'],
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// /trade
// ---------------------------------------------------------------------------

const echange: Command = {
  category: 'economie',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Open a secure trade with another player')
    .addUserOption((option) =>
      option.setName('user').setDescription('Your trading partner').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('user', true);
    if (target.bot) throw gameError('target_invalid', 'Les robots ne troquent pas.');

    const targetUser = await playerRepo.findUserByDiscordId(target.id);
    if (!targetUser) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);

    const trade = await tradeService.openTrade(context.player, targetUser.id);
    await interaction.editReply(await tradeView(context, trade, target.displayName));
  },
};

/** Rendu d'un échange en cours, avec double confirmation. */
export async function tradeView(
  context: CommandContext,
  trade: tradeService.TradeView,
  partnerName: string,
) {
  const mine = trade.items.filter((item) => item.userId === context.player.id);
  const theirs = trade.items.filter((item) => item.userId !== context.player.id);
  const isInitiator = trade.initiatorId === context.player.id;

  const format = (items: typeof mine, coins: number): string =>
    [
      ...items.map((item) => `${item.emoji} ${item.quantity}× ${item.name}`),
      coins > 0 ? `🪙 ${formatNumber(coins)} pièces` : '',
    ]
      .filter(Boolean)
      .join('\n') || '*rien pour le moment*';

  return {
    embeds: [
      baseEmbed({
        title: `🤝 Échange avec ${partnerName}`,
        description: [
          '**Les deux joueurs doivent confirmer.** Toute modification annule les confirmations.',
          `Expire ${discordTimestamp(trade.expiresAt, 'R')} • révision ${trade.revision}`,
        ].join('\n'),
        color: COLORS.info,
        fields: [
          {
            name: `${trade.initiatorConfirmed && isInitiator ? '✅' : '⬜'} Votre offre`,
            value: format(mine, isInitiator ? trade.initiatorCoins : trade.partnerCoins),
            inline: true,
          },
          {
            name: `${(isInitiator ? trade.partnerConfirmed : trade.initiatorConfirmed) ? '✅' : '⬜'} Offre de ${partnerName}`,
            value: format(theirs, isInitiator ? trade.partnerCoins : trade.initiatorCoins),
            inline: true,
          },
        ],
      }),
    ],
    components: [
      row(
        button({
          namespace: 'trade',
          action: 'add_item',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: 'Ajouter un objet',
          emoji: '📦',
        }),
        button({
          namespace: 'trade',
          action: 'add_coins',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: 'Ajouter des pièces',
          emoji: '🪙',
        }),
        button({
          namespace: 'trade',
          action: 'confirm',
          ownerId: context.player.discordId,
          params: [trade.id, trade.revision],
          label: 'Confirmer',
          emoji: '✅',
          style: ButtonStyle.Success,
        }),
        button({
          namespace: 'trade',
          action: 'cancel',
          ownerId: context.player.discordId,
          params: [trade.id],
          label: 'Annuler',
          emoji: '✖️',
          style: ButtonStyle.Danger,
        }),
      ),
    ],
  };
}

export const commands: Command[] = [hdv, echange];
export { inventoryService, MessageFlags };
