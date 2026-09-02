import type { Balance } from '../config/gameplay/schemas';
import { clampMoney, feeOf, scaleMoney, scaleMoneyUp } from './money';
import type { Rng } from './rng';

/**
 * ---------------------------------------------------------------------------
 * MARCHÉ DYNAMIQUE
 * ---------------------------------------------------------------------------
 * Le prix d'un objet suit l'offre réelle des joueurs. Modèle, appliqué toutes
 * les heures :
 *
 *   1. On mesure le VOLUME vendu par les joueurs depuis la dernière mise à jour.
 *   2. On le compare à un volume de référence (`referenceVolume`, calibré par
 *      rareté : on n'attend pas autant de safran que de blé).
 *   3. `pression = volume / référence`. Au-dessus de 1, le marché est saturé ;
 *      en dessous, il y a pénurie.
 *   4. L'indice de demande glisse vers `1 / pression` avec un lissage
 *      (`demandSmoothing = 0,35`) : le prix ne s'effondre pas en un cycle, ce qui
 *      éviterait toute stratégie et rendrait le marché illisible.
 *   5. Le prix cible est `basePrice × demandIndex`, borné à [55 %, 180 %] du prix
 *      de base, plus un bruit aléatoire de ±8 % (`volatility`) pour que le graphe
 *      reste vivant même sans activité.
 *   6. Le volume est ensuite amorti (`demandDecay = 0,5`) plutôt que remis à
 *      zéro : la mémoire du marché s'estompe sur ~3 cycles.
 *
 * Pourquoi des BORNES DURES : sans plancher, un serveur de 10 000 joueurs qui
 * spamme le blé écraserait son prix à 0 et rendrait la culture inutile pour les
 * débutants. Sans plafond, un objet jamais vendu deviendrait un jackpot
 * exploitable. Les bornes garantissent que la spéculation reste un bonus
 * (±80 %), jamais la seule stratégie viable.
 *
 * C'est aussi le principal frein anti-inflation : plus les joueurs produisent,
 * moins ça paie, donc la masse monétaire ne croît pas linéairement avec le nombre
 * de joueurs.
 */

export interface MarketState {
  itemKey: string;
  basePrice: number;
  currentPrice: number;
  previousPrice: number;
  demandIndex: number;
  volumeWindow: number;
  referenceVolume: number;
  volatility: number;
  priceFloorPct: number;
  priceCeilPct: number;
  featured: boolean;
}

export interface MarketUpdate {
  itemKey: string;
  price: number;
  previousPrice: number;
  demandIndex: number;
  trend: number;
  volumeWindow: number;
}

/** Volume de référence attendu par cycle pour un objet, selon sa rareté. */
export function referenceVolumeFor(rarity: string, balance: Balance): number {
  const divisor = balance.market.referenceVolumeRarityDivisor[
    rarity as keyof typeof balance.market.referenceVolumeRarityDivisor
  ];
  return Math.max(1, Math.round(balance.market.referenceVolumeBase / (divisor ?? 1)));
}

/**
 * Calcule le nouveau prix d'un objet. Fonction pure : le service se charge de
 * lire l'état, d'appeler ceci, puis d'écrire le résultat et l'historique.
 */
export function updatePrice(state: MarketState, balance: Balance, rng: Rng): MarketUpdate {
  const config = balance.market;

  const pressure = state.volumeWindow / Math.max(1, state.referenceVolume);
  // `1 / (1 + pression)` normalisé : pression 0 → 2 (pénurie), 1 → 1 (équilibre),
  // 3 → 0,5 (saturation). Fonction strictement décroissante et bornée.
  const targetDemand = 2 / (1 + pressure);

  const smoothing = config.demandSmoothing;
  const demandIndex = state.demandIndex * (1 - smoothing) + targetDemand * smoothing;

  const noise = 1 + (rng.next() * 2 - 1) * state.volatility;
  const featuredBonus = state.featured ? 1 + config.featuredBonus : 1;

  const floor = Math.max(1, scaleMoney(state.basePrice, state.priceFloorPct));
  const ceil = Math.max(floor + 1, scaleMoneyUp(state.basePrice, state.priceCeilPct));
  const price = clampMoney(state.basePrice * demandIndex * noise * featuredBonus, floor, ceil);

  const previousPrice = state.currentPrice;
  const trend = previousPrice > 0 ? (price - previousPrice) / previousPrice : 0;

  return {
    itemKey: state.itemKey,
    price,
    previousPrice,
    demandIndex: Math.round(demandIndex * 10_000) / 10_000,
    trend: Math.round(trend * 10_000) / 10_000,
    // Mémoire décroissante : le marché « oublie » progressivement.
    volumeWindow: Math.floor(state.volumeWindow * config.demandDecay),
  };
}

/**
 * Prix de vente immédiate au village (`/sell`), inférieur au marché.
 * La décote de 15 % est le prix de la commodité : vendre tout de suite sans
 * passer par l'hôtel des ventes. C'est aussi un puits monétaire discret.
 */
export function directSellPrice(marketPrice: number, balance: Balance): number {
  return Math.max(1, scaleMoney(marketPrice, 1 - balance.economy.sellDirectPenalty));
}

/**
 * Taxe de vente, exonérée sous le niveau `salesTaxFreeLevel`.
 * Puits monétaire principal : appliquée à toutes les ventes, elle retire en
 * permanence un pourcentage de la masse monétaire créée par les récoltes.
 */
export function salesTax(amount: number, level: number, balance: Balance): number {
  if (level < balance.economy.salesTaxFreeLevel) return 0;
  return feeOf(amount, balance.economy.salesTaxRate);
}

/** Tendance lisible : symbole et clé de libellé (résolue par l'appelant via son traducteur). */
export function describeTrend(trend: number): { emoji: string; labelKey: string } {
  if (trend >= 0.1) return { emoji: '📈', labelKey: 'market.trend_strong_rise' };
  if (trend >= 0.02) return { emoji: '↗️', labelKey: 'market.trend_rise' };
  if (trend <= -0.1) return { emoji: '📉', labelKey: 'market.trend_strong_drop' };
  if (trend <= -0.02) return { emoji: '↘️', labelKey: 'market.trend_drop' };
  return { emoji: '➡️', labelKey: 'market.trend_stable' };
}

/**
 * Commission de l'hôtel des ventes, prélevée au vendeur sur le prix final.
 * Deuxième puits monétaire important : 5 % de chaque transaction entre joueurs
 * disparaissent, ce qui limite le blanchiment (vendre à un complice pour
 * transférer de l'argent coûte 5 % à chaque aller-retour).
 */
export function auctionCommission(salePrice: number, balance: Balance): number {
  return feeOf(salePrice, balance.auction.commissionRate);
}

/** Frais de mise en vente, non remboursables (anti-spam d'annonces). */
export function auctionListingFee(askPrice: number, balance: Balance): number {
  return Math.max(
    balance.auction.minListingFee,
    feeOf(askPrice, balance.auction.listingFeeRate),
  );
}

/**
 * Bornes de prix autorisées à l'hôtel des ventes, en pourcentage du prix marché.
 * Empêche deux abus : brader à 1 pièce pour transférer discrètement de l'argent
 * à un complice, et afficher un prix absurde pour polluer les listes.
 */
export function auctionPriceBounds(
  marketPrice: number,
  quantity: number,
  balance: Balance,
): { min: number; max: number } {
  const reference = Math.max(1, marketPrice * quantity);
  return {
    min: Math.max(1, scaleMoney(reference, balance.auction.minPricePctOfMarket)),
    max: scaleMoneyUp(reference, balance.auction.maxPricePctOfMarket),
  };
}

/** Mise minimale acceptable sur une enchère en cours. */
export function minimumBid(listing: { startPrice: number; currentBid: number | null }, balance: Balance): number {
  if (listing.currentBid === null) return listing.startPrice;
  return scaleMoneyUp(listing.currentBid, 1 + balance.auction.minBidIncrementPct);
}
