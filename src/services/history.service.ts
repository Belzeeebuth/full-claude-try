import { getConfig, type GameConfig } from '../config';
import * as economyRepo from '../repositories/economy.repo';
import { COIN, GEM, discordTimestamp, escapeMarkdown, formatNumber } from '../utils/format';
import type { LedgerWindowTotals, TransactionType } from '../repositories/economy.repo';
import type { Translator } from '../types';

/**
 * `/history` — « où sont passées mes pièces ? » (proposition E-01).
 *
 * Le journal `transactions` existe depuis le premier jour pour l'audit et
 * l'anti-triche, mais le joueur n'y avait aucun accès : un solde qui fond
 * après une taxe, une commission d'enchère ou un vétérinaire restait un
 * mystère — et un mystère sur l'argent ressemble à un bug. Ce service ne fait
 * que LIRE ce journal ; il n'écrit rien, ne touche ni solde ni inventaire.
 *
 * Tout ce qui est décidable sans base — familles de types, bornes de page,
 * mise en forme d'une ligne — est pur et testé dans `tests/history.test.ts`.
 * `getHistory` ne fait qu'enchaîner totaux → bornage → page.
 */

/**
 * Familles proposées au joueur à la place des quarante valeurs brutes de
 * `transaction_type`. Un type appartient à EXACTEMENT une famille (vérifié en
 * test contre l'énumération) : ajouter un type sans le classer casse la CI
 * plutôt que de le faire disparaître silencieusement des filtres.
 */
export const HISTORY_FAMILIES = {
  sales: ['harvest_sale', 'market_sale', 'animal_sale'],
  purchases: [
    'shop_purchase',
    'seed_purchase',
    'animal_purchase',
    'plot_purchase',
    'building_purchase',
    'building_upgrade',
    'craft_cost',
    'repair_cost',
    'vet_cost',
    'feed_cost',
    'reroll_cost',
  ],
  rewards: [
    'starting_bonus',
    'quest_reward',
    'achievement_reward',
    'daily_reward',
    'vote_reward',
    'referral_reward',
    'season_pass_reward',
    'event_reward',
    'level_reward',
  ],
  auctions: ['auction_listing_fee', 'auction_sale', 'auction_purchase', 'auction_refund'],
  trades: ['trade_in', 'trade_out', 'gift_in', 'gift_out'],
  bank: ['bank_deposit', 'bank_withdraw', 'bank_interest'],
  coop: ['coop_contribution', 'coop_payout', 'coop_upgrade'],
  taxes: ['tax'],
  other: ['prestige_reset', 'admin_grant', 'admin_remove'],
} as const satisfies Record<string, readonly TransactionType[]>;

export type HistoryFamily = keyof typeof HISTORY_FAMILIES | 'all';

/** Ordre d'affichage des choix Discord : « tout » d'abord, puis du plus courant au plus rare. */
export const HISTORY_FAMILY_CHOICES: readonly HistoryFamily[] = [
  'all',
  'sales',
  'purchases',
  'rewards',
  'auctions',
  'trades',
  'bank',
  'coop',
  'taxes',
  'other',
];

export function isHistoryFamily(value: string): value is HistoryFamily {
  return (HISTORY_FAMILY_CHOICES as readonly string[]).includes(value);
}

/**
 * Le paramètre arrive d'un choix Discord ou d'un custom_id : dans les deux cas
 * une valeur inconnue (ancien bouton, famille renommée) retombe sur « tout »
 * plutôt que de refuser l'affichage.
 */
export function normalizeFamily(raw: string | null | undefined): HistoryFamily {
  return raw && isHistoryFamily(raw) ? raw : 'all';
}

/** Types d'une famille ; `undefined` pour « tout » (aucun filtre SQL). */
export function familyTypes(family: HistoryFamily): readonly TransactionType[] | undefined {
  return family === 'all' ? undefined : HISTORY_FAMILIES[family];
}

export const HISTORY_DAYS = [1, 7, 30, 90] as const;
export type HistoryDays = (typeof HISTORY_DAYS)[number];
export const DEFAULT_HISTORY_DAYS: HistoryDays = 7;

export function normalizeDays(raw: string | number | null | undefined): HistoryDays {
  const value = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  return (HISTORY_DAYS as readonly number[]).includes(value)
    ? (value as HistoryDays)
    : DEFAULT_HISTORY_DAYS;
}

export function windowStart(now: Date, days: HistoryDays): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Dix lignes : au-delà, l'embed dépasse l'écran d'un téléphone et l'en-tête sort de vue. */
export const HISTORY_PAGE_SIZE = 10;

export function pageCount(total: number, pageSize = HISTORY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/**
 * Ramène une page demandée dans [1, totalPages]. Un numéro hors bornes vient
 * d'une option tapée à la main ou d'un bouton périmé (lignes purgées depuis) :
 * on montre la page la plus proche plutôt qu'une erreur.
 */
export function clampPage(page: number, totalPages: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, totalPages), Math.max(1, Math.trunc(page)));
}

export interface HistoryLine {
  id: number;
  type: TransactionType;
  currency: 'coins' | 'gems';
  /** Signé : négatif = sortie. */
  amount: number;
  balanceAfter: number;
  createdAt: Date;
  /** Objet, animal ou bâtiment concerné, résolu dans la langue du joueur. */
  item: { emoji: string; name: string } | null;
  quantity: number | null;
  unitPrice: number | null;
  /** Nom de l'autre joueur (don, échange, enchère) ; `null` si aucun. */
  counterpartyName: string | null;
  /** Une contrepartie était enregistrée mais son compte n'existe plus. */
  counterpartyMissing: boolean;
}

export interface HistoryPage {
  family: HistoryFamily;
  days: HistoryDays;
  since: Date;
  /** Page réellement affichée, après bornage. */
  page: number;
  totalPages: number;
  totals: LedgerWindowTotals;
  lines: HistoryLine[];
}

/**
 * Libellé d'une clé de transaction. `item_key` porte indifféremment un objet,
 * un animal (`animal_purchase`) ou un bâtiment (`building_purchase`) : on
 * cherche dans les trois catalogues, et une clé retirée de la configuration
 * s'affiche telle quelle plutôt que de faire disparaître la ligne.
 */
export function resolveItemLabel(config: GameConfig, key: string): { emoji: string; name: string } {
  const entry = config.items.get(key) ?? config.animals.get(key) ?? config.buildings.get(key);
  return entry ? { emoji: entry.emoji, name: entry.name } : { emoji: '📦', name: key };
}

function toLine(
  row: { entry: economyRepo.TransactionRow; counterpartyName: string | null },
  config: GameConfig,
): HistoryLine {
  const { entry, counterpartyName } = row;
  return {
    id: entry.id,
    type: entry.type,
    currency: entry.currency,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    createdAt: entry.createdAt,
    item: entry.itemKey ? resolveItemLabel(config, entry.itemKey) : null,
    quantity: entry.quantity,
    unitPrice: entry.unitPrice,
    counterpartyName,
    counterpartyMissing: entry.counterpartyId !== null && counterpartyName === null,
  };
}

export async function getHistory(
  userId: string,
  input: { family: HistoryFamily; days: HistoryDays; page: number },
  locale?: string,
  now: Date = new Date(),
): Promise<HistoryPage> {
  const since = windowStart(now, input.days);
  const window: economyRepo.LedgerWindow = { userId, types: familyTypes(input.family), since };

  // Les totaux d'abord : ils donnent le nombre de lignes, donc la dernière
  // page, donc la borne du numéro demandé. Une ligne écrite entre les deux
  // requêtes décale la page d'une position — sans conséquence pour une
  // consultation, et bien moins coûteux qu'une transaction pour de la lecture.
  const totals = await economyRepo.summarizeLedgerWindow(window);
  const totalPages = pageCount(totals.count);
  const page = clampPage(input.page, totalPages);

  const rows =
    totals.count === 0
      ? []
      : await economyRepo.listLedgerPage(window, {
          limit: HISTORY_PAGE_SIZE,
          offset: (page - 1) * HISTORY_PAGE_SIZE,
        });

  const config = getConfig(locale);
  return {
    family: input.family,
    days: input.days,
    since,
    page,
    totalPages,
    totals,
    lines: rows.map((row) => toLine(row, config)),
  };
}

// ---------------------------------------------------------------------------
// Mise en forme (pure)
// ---------------------------------------------------------------------------

function currencyIcon(currency: 'coins' | 'gems'): string {
  return currency === 'gems' ? GEM : COIN;
}

/** `+120 🪙` / `−45 💎` : le signe est l'information principale de la ligne. */
export function formatSignedAmount(
  amount: number,
  currency: 'coins' | 'gems',
  locale?: string,
): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${formatNumber(Math.abs(amount), locale)} ${currencyIcon(currency)}`;
}

/**
 * Une ligne du journal, prête pour l'embed. Le nom de la contrepartie vient de
 * la base (pseudo choisi par un autre joueur) : il est neutralisé avant
 * injection dans le markdown, comme partout ailleurs.
 */
export function formatHistoryLine(line: HistoryLine, t: Translator, locale?: string): string {
  const icon = currencyIcon(line.currency);
  const details: string[] = [];

  if (line.item) {
    details.push(
      t('history.line_item', {
        emoji: line.item.emoji,
        name: line.item.name,
        quantity:
          line.quantity !== null && line.quantity > 0
            ? ` ×${formatNumber(line.quantity, locale)}`
            : '',
      }),
    );
  }
  // Le prix unitaire n'apporte quelque chose que sur un lot : sur une pièce
  // unique, il répète le montant.
  if (line.unitPrice !== null && line.unitPrice > 0 && (line.quantity ?? 0) > 1) {
    details.push(t('history.line_unit', { price: `${formatNumber(line.unitPrice, locale)} ${icon}` }));
  }
  if (line.counterpartyName !== null || line.counterpartyMissing) {
    const name =
      line.counterpartyName !== null
        ? escapeMarkdown(line.counterpartyName)
        : t('history.unknown_player');
    details.push(t(line.amount > 0 ? 'history.line_from' : 'history.line_to', { name }));
  }

  return t('history.line', {
    when: discordTimestamp(line.createdAt, 'R'),
    type: t(`history.type.${line.type}`),
    amount: formatSignedAmount(line.amount, line.currency, locale),
    balance: `${formatNumber(line.balanceAfter, locale)} ${icon}`,
    details: details.join(''),
  });
}

/**
 * En-tête de l'embed : entrées, sorties et net en pièces sur la fenêtre, puis
 * une seconde ligne pour les gemmes seulement si elles ont bougé — la plupart
 * des joueurs n'en manipulent jamais.
 */
export function formatHistoryTotals(
  totals: LedgerWindowTotals,
  windowLabel: string,
  t: Translator,
  locale?: string,
): string[] {
  const lines = [
    t('history.totals', {
      window: windowLabel,
      incoming: `${formatNumber(totals.coinsIn, locale)} ${COIN}`,
      outgoing: `${formatNumber(totals.coinsOut, locale)} ${COIN}`,
      net: formatSignedAmount(totals.coinsIn - totals.coinsOut, 'coins', locale),
    }),
  ];
  if (totals.gemsIn > 0 || totals.gemsOut > 0) {
    lines.push(
      t('history.totals_gems', {
        incoming: `${formatNumber(totals.gemsIn, locale)} ${GEM}`,
        outgoing: `${formatNumber(totals.gemsOut, locale)} ${GEM}`,
        net: formatSignedAmount(totals.gemsIn - totals.gemsOut, 'gems', locale),
      }),
    );
  }
  return lines;
}
