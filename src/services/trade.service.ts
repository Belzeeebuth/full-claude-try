import { balance as getBalance, getConfig } from '../config';
import { lockUserRow, lockUserRows, withTransaction } from '../db/client';
import { auctionCommission, auctionListingFee, auctionPriceBounds, minimumBid } from '../game/market';
import { feeOf } from '../game/money';
import { gameError } from '../utils/errors';
import { formatNumber } from '../utils/format';
import { moduleLogger } from '../utils/logger';
import * as tradeRepo from '../repositories/trade.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as systemRepo from '../repositories/system.repo';
import * as economyService from './economy.service';
import * as inventoryService from './inventory.service';
import { trackAction } from './tracker.service';
import * as webhookService from './webhook.service';
import type { Mutation, Quality } from '../repositories/inventory.repo';
import type { PlayerContext } from '../types';

const log = moduleLogger('trade');

/**
 * Hôtel des ventes et échanges directs.
 *
 * Deux principes non négociables :
 *  1. Les objets mis en vente sont RETIRÉS de l'inventaire immédiatement. Sinon
 *     un joueur pourrait vendre le même lot dix fois en parallèle.
 *  2. Toute annulation ou expiration REND les objets. Le chemin de retour est
 *     donc aussi important que le chemin d'aller, et il est journalisé.
 */

// ---------------------------------------------------------------------------
// HÔTEL DES VENTES
// ---------------------------------------------------------------------------

export interface ListingView {
  id: string;
  itemKey: string;
  itemName: string;
  itemEmoji: string;
  quality: Quality;
  mutation: Mutation;
  quantity: number;
  startPrice: number;
  buyoutPrice: number | null;
  currentBid: number | null;
  minimumBid: number;
  sellerName: string;
  sellerDiscordId: string;
  isOwn: boolean;
  expiresAt: Date;
}

export async function browse(
  viewerId: string,
  options: { itemKey?: string; page?: number; pageSize?: number } = {},
  locale?: string,
): Promise<{ listings: ListingView[]; total: number; page: number; totalPages: number }> {
  const config = getConfig(locale);
  const balance = getBalance();
  const pageSize = options.pageSize ?? 6;
  const page = Math.max(1, options.page ?? 1);

  const [rows, total] = await Promise.all([
    tradeRepo.listActiveListings({
      itemKey: options.itemKey,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    tradeRepo.countActiveListingsTotal(options.itemKey),
  ]);

  return {
    listings: rows.map((row) => ({
      id: row.listing.id,
      itemKey: row.listing.itemKey,
      itemName: config.items.get(row.listing.itemKey)?.name ?? row.itemName,
      itemEmoji: row.itemEmoji,
      quality: row.listing.quality as Quality,
      mutation: row.listing.mutation as Mutation,
      quantity: row.listing.quantity,
      startPrice: row.listing.startPrice,
      buyoutPrice: row.listing.buyoutPrice,
      currentBid: row.listing.currentBid,
      minimumBid: minimumBid(
        { startPrice: row.listing.startPrice, currentBid: row.listing.currentBid },
        balance,
      ),
      sellerName: row.sellerName,
      sellerDiscordId: row.sellerDiscordId,
      isOwn: row.listing.sellerId === viewerId,
      expiresAt: row.listing.expiresAt,
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface CreateListingInput {
  itemKey: string;
  quantity: number;
  price: number;
  buyout?: boolean;
  durationHours?: number;
  quality?: Quality;
  mutation?: Mutation;
}

export async function createListing(
  player: PlayerContext,
  input: CreateListingInput,
): Promise<{ id: string; fee: number; expiresAt: Date; price: number; quantity: number }> {
  const balance = getBalance();
  const item = inventoryService.requireItem(input.itemKey, player.locale);
  if (!item.tradable) {
    throw gameError('item_not_tradable', `${item.emoji} ${item.name} cannot be traded.`, {
      i18nKey: 'errors.trade.item_not_tradable',
      params: { item: item.name },
    });
  }
  const quantity = Math.max(1, Math.floor(input.quantity));
  const duration = balance.auction.durationsHours.includes(input.durationHours ?? 0)
    ? input.durationHours!
    : balance.auction.defaultDurationHours;

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);

    const active = await tradeRepo.countActiveListings(player.id, tx);
    if (active >= balance.auction.maxActiveListings) {
      throw gameError(
        'forbidden',
        `You already have ${active} active listings (maximum ${balance.auction.maxActiveListings}).`,
        {
          i18nKey: 'errors.trade.too_many_listings',
          params: { active, max: balance.auction.maxActiveListings },
        },
      );
    }

    // Bornes de prix : empêchent de brader à 1 pièce pour transférer de l'argent
    // à un complice, et d'afficher des prix absurdes qui polluent les listes.
    const market = await economyRepo.getMarketPrice(input.itemKey, tx);
    const reference = market?.currentPrice ?? item.sellPrice;
    const bounds = auctionPriceBounds(reference, quantity, balance);
    if (input.price < bounds.min || input.price > bounds.max) {
      throw gameError(
        'quantity_invalid',
        `Price out of bounds: between ${bounds.min.toLocaleString('en-US')} and ${bounds.max.toLocaleString('en-US')} 🪙 for this lot.`,
        {
          i18nKey: 'errors.trade.price_out_of_bounds',
          hintKey: 'errors.trade.price_out_of_bounds_hint',
          params: {
            min: formatNumber(bounds.min, player.locale),
            max: formatNumber(bounds.max, player.locale),
          },
        },
      );
    }

    // Les objets quittent l'inventaire tout de suite.
    await inventoryService.removeExact(
      player.id,
      { itemKey: input.itemKey, quality: input.quality, mutation: input.mutation },
      quantity,
      tx,
      player.locale,
    );

    const fee = auctionListingFee(input.price, balance);
    await economyService.charge(
      {
        userId: player.id,
        amount: fee,
        type: 'auction_listing_fee',
        itemKey: input.itemKey,
        quantity,
      },
      tx,
    );

    const expiresAt = new Date(Date.now() + duration * 3_600_000);
    const listing = await tradeRepo.createListing(
      {
        sellerId: player.id,
        itemKey: input.itemKey,
        quality: input.quality ?? 'normal',
        mutation: input.mutation ?? 'none',
        quantity,
        startPrice: input.price,
        buyoutPrice: input.buyout === false ? null : input.price,
        commissionRate: balance.auction.commissionRate.toFixed(4),
        listingFee: fee,
        expiresAt,
      },
      tx,
    );

    log.debug({ userId: player.id, listingId: listing.id, price: input.price }, 'listing created');
    return { id: listing.id, fee, expiresAt, price: input.price, quantity };
  });
}

/**
 * Achat immédiat.
 * Ordre : verrouiller l'annonce → marquer vendue (atomique) → débiter l'acheteur
 * → créditer le vendeur net de commission → livrer les objets. Si le débit
 * échoue, tout est annulé et l'annonce reste active.
 */
export async function buyout(
  player: PlayerContext,
  listingId: string,
): Promise<{ itemName: string; emoji: string; quantity: number; price: number; commission: number; sellerId: string }> {
  const config = getConfig(player.locale);
  const balance = getBalance();

  return withTransaction(async (tx) => {
    const listing = await tradeRepo.lockListing(tx, listingId);
    if (!listing) {
      throw gameError('auction_not_found', 'Listing not found.', {
        i18nKey: 'errors.trade.listing_not_found',
      });
    }
    if (listing.status !== 'active') {
      throw gameError('auction_not_found', 'This listing is closed.', {
        i18nKey: 'errors.trade.listing_closed',
      });
    }
    if (listing.sellerId === player.id) {
      throw gameError('auction_own_listing', 'You cannot buy your own listing.', {
        i18nKey: 'errors.trade.cannot_buy_own',
      });
    }
    if (listing.buyoutPrice === null) {
      throw gameError('invalid_state', 'This listing is auction-only.', {
        i18nKey: 'errors.trade.auction_only',
      });
    }

    await lockUserRows(tx, [player.id, listing.sellerId]);

    const price = listing.buyoutPrice;
    await economyService.charge(
      {
        userId: player.id,
        amount: price,
        type: 'auction_purchase',
        itemKey: listing.itemKey,
        quantity: listing.quantity,
        counterpartyId: listing.sellerId,
        referenceType: 'auction',
        referenceId: listing.id,
      },
      tx,
    );

    const sold = await tradeRepo.markSold(listing.id, player.id, price, tx);
    if (!sold) {
      throw gameError('busy', 'This listing was just sold.', {
        i18nKey: 'errors.trade.just_sold',
      });
    }

    const commission = auctionCommission(price, balance);
    await economyService.pay(
      {
        userId: listing.sellerId,
        amount: price - commission,
        type: 'auction_sale',
        itemKey: listing.itemKey,
        quantity: listing.quantity,
        counterpartyId: player.id,
        referenceType: 'auction',
        referenceId: listing.id,
        metadata: { commission },
      },
      tx,
    );

    await inventoryService.addItems(
      player.id,
      [
        {
          itemKey: listing.itemKey,
          quantity: listing.quantity,
          quality: listing.quality as Quality,
          mutation: listing.mutation as Mutation,
        },
      ],
      tx,
      { allowOverflow: true },
    );

    // L'achat immédiat évince TOUS les enchérisseurs, y compris celui en tête :
    // on rend l'intégralité du séquestre encore dû, en s'appuyant sur
    // `auction_bids` plutôt que sur les colonnes de l'annonce.
    const escrowed = await tradeRepo.findUnrefundedBids(listing.id, tx, true);
    for (const escrow of escrowed) {
      await economyService.pay(
        {
          userId: escrow.bidderId,
          amount: escrow.amount,
          type: 'auction_refund',
          referenceType: 'auction',
          referenceId: listing.id,
        },
        tx,
      );
    }
    await tradeRepo.markBidsRefunded(
      escrowed.map((escrow) => escrow.id),
      tx,
    );

    await trackAction(
      { userId: listing.sellerId, coopId: null, level: 1 },
      'auction_sale',
      1,
      {},
      tx,
    );

    const item = config.items.get(listing.itemKey);
    return {
      itemName: item?.name ?? listing.itemKey,
      emoji: item?.emoji ?? '📦',
      quantity: listing.quantity,
      price,
      commission,
      sellerId: listing.sellerId,
    };
  });
}

/** Enchère. La mise précédente est remboursée à son auteur. */
export async function bid(
  player: PlayerContext,
  listingId: string,
  amount: number,
): Promise<{ amount: number; previousBidderId: string | null; expiresAt: Date }> {
  const balance = getBalance();

  return withTransaction(async (tx) => {
    const listing = await tradeRepo.lockListing(tx, listingId);
    if (!listing) {
      throw gameError('auction_not_found', 'Listing not found.', {
        i18nKey: 'errors.trade.listing_not_found',
      });
    }
    if (listing.status !== 'active') {
      throw gameError('auction_not_found', 'Listing closed.', {
        i18nKey: 'errors.trade.listing_closed',
      });
    }
    if (listing.sellerId === player.id) {
      throw gameError('auction_own_listing', 'You cannot bid on your own listing.', {
        i18nKey: 'errors.trade.cannot_bid_own',
      });
    }

    const minimum = minimumBid(
      { startPrice: listing.startPrice, currentBid: listing.currentBid },
      balance,
    );
    if (amount < minimum) {
      throw gameError(
        'auction_bid_too_low',
        `Minimum bid: ${minimum.toLocaleString('en-US')} 🪙.`,
        { i18nKey: 'errors.trade.bid_too_low', params: { minimum: formatNumber(minimum, player.locale) } },
      );
    }

    await lockUserRow(tx, player.id);
    await economyService.charge(
      {
        userId: player.id,
        amount,
        type: 'auction_purchase',
        referenceType: 'auction_bid',
        referenceId: listing.id,
      },
      tx,
    );

    const result = await tradeRepo.placeBid(listing.id, player.id, amount, tx);
    if (!result) {
      throw gameError('busy', 'A higher bid was just placed.', {
        i18nKey: 'errors.trade.higher_bid_placed',
      });
    }

    // Remboursement des mises détrônées, MARQUÉES dans la même transaction.
    // Le marquage n'est pas cosmétique : `closeExpiredListings` rembourse toute
    // mise non marquée, donc rembourser sans marquer paie deux fois.
    const refundedBidIds: number[] = [];
    for (const outbid of result.outbid) {
      if (outbid.refunded) continue;
      await economyService.pay(
        {
          userId: outbid.bidderId,
          amount: outbid.amount,
          type: 'auction_refund',
          referenceType: 'auction',
          referenceId: listing.id,
        },
        tx,
      );
      refundedBidIds.push(outbid.id);
    }
    await tradeRepo.markBidsRefunded(refundedBidIds, tx);
    const previousBidderId = result.outbid[0]?.bidderId ?? null;

    // Anti-snipe : une mise dans les dernières minutes prolonge l'enchère, ce qui
    // évite qu'un joueur ne remporte tout en misant à la dernière seconde.
    let expiresAt = listing.expiresAt;
    const remainingMinutes = (listing.expiresAt.getTime() - Date.now()) / 60_000;
    if (remainingMinutes < balance.auction.antiSnipeExtensionMinutes) {
      await tradeRepo.extendListing(
        listing.id,
        balance.auction.antiSnipeExtensionMinutes,
        tx,
      );
      expiresAt = new Date(
        listing.expiresAt.getTime() + balance.auction.antiSnipeExtensionMinutes * 60_000,
      );
    }

    return { amount, previousBidderId, expiresAt };
  });
}

export async function cancelListing(
  player: PlayerContext,
  listingId: string,
): Promise<{ itemName: string; quantity: number }> {
  const config = getConfig(player.locale);

  return withTransaction(async (tx) => {
    const listing = await tradeRepo.cancelListing(listingId, player.id, tx);
    if (!listing) {
      throw gameError(
        'auction_not_found',
        'Cannot cancel: listing not found, already closed, or a bid was placed.',
        { i18nKey: 'errors.trade.cannot_cancel' },
      );
    }

    await inventoryService.addItems(
      player.id,
      [
        {
          itemKey: listing.itemKey,
          quantity: listing.quantity,
          quality: listing.quality as Quality,
          mutation: listing.mutation as Mutation,
        },
      ],
      tx,
      { allowOverflow: true },
    );

    const item = config.items.get(listing.itemKey);
    return { itemName: item?.name ?? listing.itemKey, quantity: listing.quantity };
  });
}

export async function myListings(userId: string, limit = 10) {
  return tradeRepo.listSellerHistory(userId, limit);
}

/**
 * Clôture les annonces expirées (job toutes les 5 minutes).
 * Trois cas : vendue à l'enchérisseur, non vendue (retour au vendeur), et
 * remboursements des mises perdantes.
 */
export async function closeExpiredListings(limit = 50): Promise<{ sold: number; returned: number }> {
  const balance = getBalance();
  const now = new Date();
  const expired = await tradeRepo.findExpiredListings(now, limit);
  let sold = 0;
  let returned = 0;

  for (const listing of expired) {
    await withTransaction(async (tx) => {
      const locked = await tradeRepo.lockListing(tx, listing.id);
      if (!locked || locked.status !== 'active') return;

      if (locked.currentBidderId && locked.currentBid) {
        const marked = await tradeRepo.markSold(
          locked.id,
          locked.currentBidderId,
          locked.currentBid,
          tx,
        );
        if (!marked) return;

        const commission = feeOf(locked.currentBid, Number(locked.commissionRate));
        await economyService.pay(
          {
            userId: locked.sellerId,
            amount: locked.currentBid - commission,
            type: 'auction_sale',
            itemKey: locked.itemKey,
            quantity: locked.quantity,
            counterpartyId: locked.currentBidderId,
            referenceType: 'auction',
            referenceId: locked.id,
            metadata: { commission, viaBid: true },
          },
          tx,
        );
        await inventoryService.addItems(
          locked.currentBidderId,
          [
            {
              itemKey: locked.itemKey,
              quantity: locked.quantity,
              quality: locked.quality as Quality,
              mutation: locked.mutation as Mutation,
            },
          ],
          tx,
          { allowOverflow: true },
        );
        sold += 1;

        await systemRepo.enqueueNotification({
          userId: locked.sellerId,
          type: 'auction_sold',
          payload: {
            titleKey: 'notifications.auction_sold_title',
            bodyKey: 'notifications.auction_sold_body',
            params: { quantity: locked.quantity, amount: locked.currentBid - commission },
          },
          dedupeKey: `auction-sold:${locked.id}`,
        });
        await systemRepo.enqueueNotification({
          userId: locked.currentBidderId,
          type: 'auction_won',
          payload: {
            titleKey: 'notifications.auction_won_title',
            bodyKey: 'notifications.auction_won_body',
            params: { quantity: locked.quantity, amount: locked.currentBid },
          },
          dedupeKey: `auction-won:${locked.id}`,
        });
        await webhookService.enqueueEvent(locked.currentBidderId, 'auction_won', {
          listingId: locked.id,
          itemKey: locked.itemKey,
          quantity: locked.quantity,
          quality: locked.quality,
          mutation: locked.mutation,
          pricePaid: locked.currentBid,
        });
      } else {
        const marked = await tradeRepo.markExpired(locked.id, tx);
        if (!marked) return;
        await inventoryService.addItems(
          locked.sellerId,
          [
            {
              itemKey: locked.itemKey,
              quantity: locked.quantity,
              quality: locked.quality as Quality,
              mutation: locked.mutation as Mutation,
            },
          ],
          tx,
          { allowOverflow: true },
        );
        returned += 1;
      }

      // Remboursement des mises perdantes. La mise gagnante, elle, finance le
      // vendeur : `findUnrefundedBids` l'exclut tant qu'on ne demande pas
      // explicitement de l'inclure.
      const losing = await tradeRepo.findUnrefundedBids(locked.id, tx);
      for (const losingBid of losing) {
        await economyService.pay(
          {
            userId: losingBid.bidderId,
            amount: losingBid.amount,
            type: 'auction_refund',
            referenceType: 'auction',
            referenceId: locked.id,
          },
          tx,
        );
      }
      await tradeRepo.markBidsRefunded(
        losing.map((entry) => entry.id),
        tx,
      );
    });
  }

  if (sold + returned > 0) {
    log.info({ sold, returned }, 'expired listings processed');
  }
  return { sold, returned };
}

// ---------------------------------------------------------------------------
// ÉCHANGE DIRECT
// ---------------------------------------------------------------------------

export interface TradeView {
  id: string;
  initiatorId: string;
  partnerId: string;
  initiatorCoins: number;
  partnerCoins: number;
  initiatorConfirmed: boolean;
  partnerConfirmed: boolean;
  revision: number;
  status: string;
  expiresAt: Date;
  items: Array<{ userId: string; itemKey: string; name: string; emoji: string; quantity: number; quality: string }>;
}

export async function openTrade(
  player: PlayerContext,
  partnerId: string,
): Promise<TradeView> {
  const balance = getBalance();
  if (player.id === partnerId) {
    throw gameError('target_invalid', 'You cannot trade with yourself.', {
      i18nKey: 'errors.trade.self_trade',
    });
  }
  if (player.level < balance.trade.minLevel) {
    throw gameError(
      'level_too_low',
      `Trading is available from level ${balance.trade.minLevel}.`,
      { i18nKey: 'errors.trade.min_level', params: { level: balance.trade.minLevel } },
    );
  }

  const existing = await tradeRepo.findPendingTradeBetween(player.id, partnerId);
  if (existing) return getTrade(existing.id);

  const trade = await withTransaction(async (tx) =>
    tradeRepo.createTrade(
      {
        initiatorId: player.id,
        partnerId,
        expiresAt: new Date(Date.now() + balance.trade.expiryMinutes * 60_000),
      },
      tx,
    ),
  );

  return getTrade(trade.id);
}

export async function getTrade(tradeId: string, locale?: string): Promise<TradeView> {
  const config = getConfig(locale);
  const trade = await tradeRepo.findTrade(tradeId);
  if (!trade) {
    throw gameError('not_found', 'Trade not found.', { i18nKey: 'errors.trade.not_found' });
  }
  const items = await tradeRepo.listTradeItems(tradeId);

  return {
    id: trade.id,
    initiatorId: trade.initiatorId,
    partnerId: trade.partnerId,
    initiatorCoins: trade.initiatorCoins,
    partnerCoins: trade.partnerCoins,
    initiatorConfirmed: trade.initiatorConfirmed,
    partnerConfirmed: trade.partnerConfirmed,
    revision: trade.revision,
    status: trade.status,
    expiresAt: trade.expiresAt,
    items: items.map((entry) => ({
      userId: entry.item.userId,
      itemKey: entry.item.itemKey,
      name: config.items.get(entry.item.itemKey)?.name ?? entry.name,
      emoji: entry.emoji,
      quantity: entry.item.quantity,
      quality: entry.item.quality,
    })),
  };
}

/** Ajoute une offre. Toute modification réinitialise les confirmations. */
export async function offerItem(
  player: PlayerContext,
  input: { tradeId: string; itemKey: string; quantity: number; quality?: Quality },
): Promise<TradeView> {
  const balance = getBalance();
  const item = inventoryService.requireItem(input.itemKey, player.locale);
  if (!item.tradable) {
    throw gameError('item_not_tradable', `${item.name} cannot be traded.`, {
      i18nKey: 'errors.trade.item_not_tradable',
      params: { item: item.name },
    });
  }

  return withTransaction(async (tx) => {
    const trade = await tradeRepo.lockTrade(tx, input.tradeId);
    if (!trade) {
      throw gameError('not_found', 'Trade not found.', { i18nKey: 'errors.trade.not_found' });
    }
    if (trade.status !== 'pending') {
      throw gameError('trade_expired', 'This trade is closed.', {
        i18nKey: 'errors.trade.trade_closed',
      });
    }
    if (trade.initiatorId !== player.id && trade.partnerId !== player.id) {
      throw gameError('forbidden', "You are not part of this trade.", {
        i18nKey: 'errors.trade.not_a_party',
      });
    }

    const existing = await tradeRepo.listTradeItems(input.tradeId, tx);
    const mine = existing.filter((entry) => entry.item.userId === player.id);
    if (mine.length >= balance.trade.maxItemsPerSide) {
      throw gameError('forbidden', `Maximum ${balance.trade.maxItemsPerSide} items per player.`, {
        i18nKey: 'errors.trade.max_items',
        params: { max: balance.trade.maxItemsPerSide },
      });
    }

    const owned = await inventoryService.count(player.id, input.itemKey, tx);
    if (owned < input.quantity) {
      throw gameError('insufficient_items', `You only have ${owned}× ${item.name}.`, {
        i18nKey: 'errors.trade.not_enough_owned',
        params: { owned, item: item.name },
      });
    }

    await tradeRepo.upsertTradeItem(
      {
        tradeId: input.tradeId,
        userId: player.id,
        itemKey: input.itemKey,
        quality: input.quality ?? 'normal',
        mutation: 'none',
        quantity: input.quantity,
      },
      tx,
    );
    await tradeRepo.bumpTradeRevision(input.tradeId, tx);

    return getTrade(input.tradeId);
  });
}

export async function offerCoins(
  player: PlayerContext,
  input: { tradeId: string; amount: number },
): Promise<TradeView> {
  const balance = getBalance();
  if (input.amount < 0 || input.amount > balance.trade.maxCoinsPerSide) {
    throw gameError('quantity_invalid', 'Invalid amount.', { i18nKey: 'errors.quantity_invalid' });
  }

  return withTransaction(async (tx) => {
    const trade = await tradeRepo.lockTrade(tx, input.tradeId);
    if (!trade) {
      throw gameError('not_found', 'Trade not found.', { i18nKey: 'errors.trade.not_found' });
    }
    if (trade.status !== 'pending') {
      throw gameError('trade_expired', 'This trade is closed.', {
        i18nKey: 'errors.trade.trade_closed',
      });
    }

    const isInitiator = trade.initiatorId === player.id;
    if (!isInitiator && trade.partnerId !== player.id) {
      throw gameError('forbidden', "You are not part of this trade.", {
        i18nKey: 'errors.trade.not_a_party',
      });
    }

    await tx
      .update((await import('../db/schema')).trades)
      .set(isInitiator ? { initiatorCoins: input.amount } : { partnerCoins: input.amount })
      .where((await import('drizzle-orm')).eq((await import('../db/schema')).trades.id, input.tradeId));
    await tradeRepo.bumpTradeRevision(input.tradeId, tx);

    return getTrade(input.tradeId);
  });
}

/**
 * Confirme l'échange. Quand les DEUX parties ont confirmé la même révision,
 * l'échange s'exécute atomiquement.
 */
export async function confirmTrade(
  player: PlayerContext,
  tradeId: string,
  revision: number,
): Promise<{ completed: boolean; trade: TradeView }> {
  const balance = getBalance();

  const result = await withTransaction(async (tx) => {
    const confirmed = await tradeRepo.confirmTrade(tradeId, player.id, revision, tx);
    if (!confirmed) {
      throw gameError(
        'invalid_state',
        "The offer changed since you confirmed. Review it and confirm again.",
        { i18nKey: 'errors.trade.offer_changed' },
      );
    }
    if (!confirmed.initiatorConfirmed || !confirmed.partnerConfirmed) {
      return { completed: false };
    }

    // Exécution : verrous dans un ordre déterministe, puis transferts croisés.
    await lockUserRows(tx, [confirmed.initiatorId, confirmed.partnerId]);
    const items = await tradeRepo.listTradeItems(tradeId, tx);

    for (const entry of items) {
      const from = entry.item.userId;
      const to = from === confirmed.initiatorId ? confirmed.partnerId : confirmed.initiatorId;
      await inventoryService.removeExact(
        from,
        {
          itemKey: entry.item.itemKey,
          quality: entry.item.quality as Quality,
          mutation: entry.item.mutation as Mutation,
        },
        entry.item.quantity,
        tx,
        player.locale,
      );
      await inventoryService.addItems(
        to,
        [
          {
            itemKey: entry.item.itemKey,
            quantity: entry.item.quantity,
            quality: entry.item.quality as Quality,
            mutation: entry.item.mutation as Mutation,
          },
        ],
        tx,
        { allowOverflow: true },
      );
    }

    // Les pièces échangées sont taxées : même logique anti-blanchiment que les dons.
    for (const [payer, receiver, amount] of [
      [confirmed.initiatorId, confirmed.partnerId, confirmed.initiatorCoins],
      [confirmed.partnerId, confirmed.initiatorId, confirmed.partnerCoins],
    ] as const) {
      if (amount <= 0) continue;
      const tax = feeOf(amount, balance.trade.taxRate);
      await economyService.charge(
        {
          userId: payer,
          amount,
          type: 'trade_out',
          counterpartyId: receiver,
          referenceType: 'trade',
          referenceId: tradeId,
          metadata: { tax },
        },
        tx,
      );
      await economyService.pay(
        {
          userId: receiver,
          amount: amount - tax,
          type: 'trade_in',
          counterpartyId: payer,
          referenceType: 'trade',
          referenceId: tradeId,
          metadata: { tax },
        },
        tx,
      );
    }

    await tradeRepo.setTradeStatus(tradeId, 'completed', null, tx);
    log.info({ tradeId, items: items.length }, 'trade completed');
    return { completed: true };
  });

  return { completed: result.completed, trade: await getTrade(tradeId) };
}

export async function cancelTrade(
  player: PlayerContext,
  tradeId: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    const cancelled = await tradeRepo.setTradeStatus(tradeId, 'cancelled', player.id, tx);
    if (!cancelled) {
      throw gameError('invalid_state', 'This trade is already closed.', {
        i18nKey: 'errors.trade.already_closed',
      });
    }
  });
}

export async function expireTrades(limit = 50): Promise<number> {
  const expired = await tradeRepo.findExpiredTrades(new Date(), limit);
  let count = 0;
  for (const trade of expired) {
    await withTransaction(async (tx) => {
      if (await tradeRepo.setTradeStatus(trade.id, 'expired', null, tx)) count += 1;
    });
  }
  return count;
}
