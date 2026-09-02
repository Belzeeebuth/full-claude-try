import { balance as getBalance, getConfig } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import {
  alertDirectionSymbol,
  alertExpiry,
  alertPriceBounds,
  isAlertTriggered,
  isThresholdPlausible,
  matchesAlertId,
  normalizeAlertIdInput,
  shortAlertId,
  sortAlertsForDisplay,
  type AlertDirection,
} from '../game/alerts';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as alertRepo from '../repositories/alert.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as systemRepo from '../repositories/system.repo';
import * as webhookService from './webhook.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('alerts');

/**
 * Alertes de prix (proposition E-02) : le pendant vendeur des ordres d'achat
 * permanents. Le joueur pose « préviens-moi quand {objet} passe au-dessus (ou
 * en dessous) de {seuil} » ; l'évaluation a lieu une fois par heure, à la fin
 * de `updateMarket`, sur les prix fraîchement recalculés.
 *
 * Ce service ne touche ni à l'argent ni à l'inventaire : une alerte ne fait
 * qu'écrire une notification et un évènement webhook. C'est délibéré — un vrai
 * « ordre de vente » exécuté par le bot serait un puits d'objets sans acheteur
 * réel, et la roadmap l'exclut.
 *
 * Le prix comparé est le prix du MARCHÉ (`market_prices.current_price`), hors
 * qualité et hors bonus d'événement : c'est la seule valeur commune à tous les
 * joueurs, celle que borne `updatePrice`, et donc la seule sur laquelle les
 * bornes de seuil ont un sens.
 */

export interface PriceAlertView {
  id: string;
  /** Huit premiers caractères, ce que le joueur voit et retape. */
  shortId: string;
  itemKey: string;
  itemName: string;
  itemEmoji: string;
  direction: AlertDirection;
  /** `≥` ou `≤`, pour l'affichage. */
  symbol: string;
  threshold: number;
  /** Prix du marché au moment de la lecture ; `null` si la ligne de marché manque. */
  currentPrice: number | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreatedPriceAlert extends PriceAlertView {
  /** La condition est déjà vraie : l'alerte partira à la prochaine mise à jour. */
  alreadyMet: boolean;
  nextUpdateAt: Date;
}

function toView(
  row: alertRepo.PriceAlertRow,
  item: { name: string; emoji: string },
  currentPrice: number | null,
): PriceAlertView {
  return {
    id: row.id,
    shortId: shortAlertId(row.id),
    itemKey: row.itemKey,
    itemName: item.name,
    itemEmoji: item.emoji,
    direction: row.direction,
    symbol: alertDirectionSymbol(row.direction),
    threshold: row.threshold,
    currentPrice,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function createAlert(
  player: PlayerContext,
  input: { itemKey: string; threshold: number; direction: AlertDirection },
  now: Date = new Date(),
): Promise<CreatedPriceAlert> {
  const balance = getBalance();
  const config = getConfig(player.locale);
  const item = config.items.get(input.itemKey);

  if (!item || !item.enabled || !item.marketTracked) {
    throw gameError('not_found', `${input.itemKey} is not tracked by the market.`, {
      i18nKey: 'errors.alerts.not_tracked',
      params: { item: item?.name ?? input.itemKey },
      suggestedCommand: 'market',
    });
  }

  // La ligne de marché peut manquer juste après l'ajout d'un objet à la
  // configuration (`ensureMarketRows` ne tourne qu'au démarrage) : sans elle,
  // ni bornes ni prix courant — on refuse plutôt que d'inventer des bornes.
  const market = await economyRepo.getMarketPrice(input.itemKey);
  if (!market) {
    throw gameError('not_found', `${item.name} has no market price yet.`, {
      i18nKey: 'errors.alerts.not_tracked',
      params: { item: item.name },
      suggestedCommand: 'market',
    });
  }

  const threshold = Math.floor(input.threshold);
  const bounds = alertPriceBounds(
    market.basePrice,
    Number(market.priceFloorPct),
    Number(market.priceCeilPct),
  );
  if (!isThresholdPlausible(threshold, bounds)) {
    throw gameError(
      'quantity_invalid',
      `The price of ${item.name} always stays between ${bounds.min} and ${bounds.max}.`,
      {
        i18nKey: 'errors.alerts.threshold_out_of_bounds',
        params: { item: item.name, min: bounds.min, max: bounds.max },
        context: { threshold, basePrice: market.basePrice },
      },
    );
  }

  const row = await withTransaction(async (tx) => {
    // Comptage et insertion sous le verrou du joueur : deux `/alert create`
    // simultanés (double-clic, deux clients) ne peuvent pas dépasser le plafond.
    await lockUserRow(tx, player.id);

    const active = await alertRepo.countActiveAlerts(player.id, tx);
    if (active >= balance.alerts.maxPerUser) {
      throw gameError(
        'forbidden',
        `You already have ${active} active alerts (maximum ${balance.alerts.maxPerUser}).`,
        {
          i18nKey: 'errors.alerts.too_many',
          params: { active, max: balance.alerts.maxPerUser },
        },
      );
    }

    return alertRepo.createAlert(
      {
        userId: player.id,
        itemKey: item.key,
        direction: input.direction,
        threshold,
        expiresAt: alertExpiry(now, balance.alerts.durationDays),
      },
      tx,
    );
  });

  log.debug({ userId: player.id, itemKey: item.key, threshold, direction: input.direction }, 'alerte de prix créée');

  return {
    ...toView(row, item, market.currentPrice),
    alreadyMet: isAlertTriggered(input.direction, threshold, market.currentPrice),
    nextUpdateAt: market.nextUpdateAt,
  };
}

export async function listAlerts(userId: string, locale?: string): Promise<PriceAlertView[]> {
  const config = getConfig(locale);
  const rows = await alertRepo.listActiveAlerts(userId);
  if (rows.length === 0) return [];

  const prices = await economyRepo.getMarketPrices([...new Set(rows.map((row) => row.alert.itemKey))]);
  const views = rows.map(({ alert, itemName, itemEmoji }) =>
    toView(
      alert,
      // Libellé pris dans la configuration en mémoire : la colonne jointe est
      // peuplée par le seed en français, quelle que soit la locale du joueur.
      { name: config.items.get(alert.itemKey)?.name ?? itemName, emoji: itemEmoji },
      prices.get(alert.itemKey)?.currentPrice ?? null,
    ),
  );
  return sortAlertsForDisplay(views, locale);
}

/** Supprime (annule) une alerte désignée par son identifiant complet ou ses premiers caractères. */
export async function deleteAlert(player: PlayerContext, input: string): Promise<PriceAlertView> {
  const prefix = normalizeAlertIdInput(input);
  if (!prefix) {
    throw gameError('not_found', 'Alert not found.', { i18nKey: 'errors.alerts.not_found' });
  }

  const candidates = (await alertRepo.findActiveAlertsByPrefix(player.id, prefix)).filter((row) =>
    matchesAlertId(row.alert.id, prefix),
  );
  if (candidates.length === 0) {
    throw gameError('not_found', 'Alert not found.', { i18nKey: 'errors.alerts.not_found' });
  }
  if (candidates.length > 1) {
    throw gameError('target_invalid', `Several alerts start with ${prefix}.`, {
      i18nKey: 'errors.alerts.ambiguous_id',
      params: { prefix },
    });
  }

  const target = candidates[0]!;
  const cancelled = await alertRepo.cancelAlert(target.alert.id, player.id);
  if (!cancelled) {
    // Déclenchée ou expirée entre la lecture et l'annulation : pour le joueur,
    // elle n'existe déjà plus.
    throw gameError('not_found', 'Alert not found.', { i18nKey: 'errors.alerts.not_found' });
  }

  const config = getConfig(player.locale);
  return toView(
    target.alert,
    { name: config.items.get(target.alert.itemKey)?.name ?? target.itemName, emoji: target.itemEmoji },
    null,
  );
}

export interface EvaluationResult {
  triggered: number;
  expired: number;
}

/**
 * Passage d'évaluation, appelé à la fin de `updateMarket` avec les prix qui
 * viennent d'être écrits.
 *
 * Ordre volontaire : on expire d'abord, on déclenche ensuite — une alerte dont
 * l'échéance est dépassée ne doit pas partir « in extremis ». Chaque
 * déclenchement est sa propre transaction : le passage en `triggered` et la
 * mise en file de la notification réussissent ou échouent ensemble, et un
 * échec sur une alerte ne bloque pas les autres. Le webhook, lui, part APRÈS
 * la validation : un serveur tiers injoignable ne doit jamais annuler le
 * message privé du joueur.
 */
export async function evaluate(
  prices: ReadonlyArray<{ itemKey: string; price: number }>,
  now: Date = new Date(),
): Promise<EvaluationResult> {
  const expired = await alertRepo.expireDueAlerts(now);
  if (prices.length === 0) return { triggered: 0, expired };

  const priceByItem = new Map(prices.map((entry) => [entry.itemKey, entry.price]));
  const active = await alertRepo.listAllActiveAlerts();
  let triggered = 0;

  for (const { alert, locale } of active) {
    const price = priceByItem.get(alert.itemKey);
    if (price === undefined) continue;
    if (!isAlertTriggered(alert.direction, alert.threshold, price)) continue;

    const item = getConfig(locale).items.get(alert.itemKey);
    const itemName = item?.name ?? alert.itemKey;
    const itemEmoji = item?.emoji ?? '📦';

    try {
      const fired = await withTransaction(async (tx) => {
        if (!(await alertRepo.markAlertTriggered(alert.id, price, now, tx))) return false;
        await systemRepo.enqueueNotification(
          {
            userId: alert.userId,
            type: 'price_alert',
            payload: {
              titleKey: 'notifications.price_alert_title',
              bodyKey:
                alert.direction === 'above'
                  ? 'notifications.price_alert_above_body'
                  : 'notifications.price_alert_below_body',
              params: { item: itemName, emoji: itemEmoji, price, threshold: alert.threshold },
            },
            dedupeKey: `price-alert:${alert.id}`,
          },
          tx,
        );
        return true;
      });
      if (!fired) continue;
      triggered += 1;

      try {
        await webhookService.enqueueEvent(alert.userId, 'price_alert', {
          alertId: alert.id,
          itemKey: alert.itemKey,
          price,
          threshold: alert.threshold,
          direction: alert.direction,
        });
      } catch (error) {
        log.warn({ err: error, alertId: alert.id }, 'webhook d\'alerte de prix non mis en file');
      }
    } catch (error) {
      log.warn({ err: error, alertId: alert.id }, 'alerte de prix non déclenchée');
    }
  }

  if (triggered > 0 || expired > 0) log.info({ triggered, expired }, 'alertes de prix évaluées');
  return { triggered, expired };
}
