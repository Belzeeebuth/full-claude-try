import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balance as getBalance } from '../src/config';
import {
  ALERT_SHORT_ID_LENGTH,
  alertDirectionSymbol,
  alertExpiry,
  alertPriceBounds,
  isAlertTriggered,
  isThresholdPlausible,
  matchesAlertId,
  normalizeAlertIdInput,
  shortAlertId,
  sortAlertsForDisplay,
} from '../src/game/alerts';
import { updatePrice, type MarketState } from '../src/game/market';
import { createRng } from '../src/game/rng';
import { uuidv7 } from '../src/utils/uuid';

/**
 * Alertes de prix : tout ce qui est décidable sans base de données. La
 * condition de déclenchement, les bornes de seuil et l'ordre d'affichage sont
 * des fonctions pures de `game/alerts.ts` ; le service ne fait que les brancher
 * sur le dépôt.
 */

const balance = getBalance();

describe('alertes de prix : condition de déclenchement', () => {
  it('déclenche « au-dessus » quand le prix atteint ou dépasse le seuil', () => {
    expect(isAlertTriggered('above', 30, 31)).toBe(true);
    expect(isAlertTriggered('above', 30, 29)).toBe(false);
  });

  it('déclenche « en dessous » quand le prix atteint ou passe sous le seuil', () => {
    expect(isAlertTriggered('below', 30, 29)).toBe(true);
    expect(isAlertTriggered('below', 30, 31)).toBe(false);
  });

  it("l'égalité déclenche dans les deux sens", () => {
    // Le marché saute d'un entier à l'autre une fois par heure : « strictement
    // supérieur » raterait exactement le pic visé.
    expect(isAlertTriggered('above', 30, 30)).toBe(true);
    expect(isAlertTriggered('below', 30, 30)).toBe(true);
  });

  it('affiche le bon symbole', () => {
    expect(alertDirectionSymbol('above')).toBe('≥');
    expect(alertDirectionSymbol('below')).toBe('≤');
  });
});

describe('alertes de prix : bornes plausibles', () => {
  it('reprend les bornes dures du marché avec les mêmes arrondis', () => {
    // 20 × 0,55 = 11 ; 20 × 1,8 = 36.
    expect(alertPriceBounds(20, 0.55, 1.8)).toEqual({ min: 11, max: 36 });
    // 7 × 0,55 = 3,85 → plancher 3 ; 7 × 1,8 = 12,6 → plafond 13.
    expect(alertPriceBounds(7, 0.55, 1.8)).toEqual({ min: 3, max: 13 });
  });

  it('garde un plancher d\'au moins 1 et un plafond strictement supérieur', () => {
    expect(alertPriceBounds(1, 0.55, 1.8)).toEqual({ min: 1, max: 2 });
    expect(alertPriceBounds(1, 0.55, 1.0)).toEqual({ min: 1, max: 2 });
  });

  it('accepte exactement les seuils que le marché peut atteindre', () => {
    const bounds = alertPriceBounds(20, 0.55, 1.8);
    expect(isThresholdPlausible(11, bounds)).toBe(true);
    expect(isThresholdPlausible(36, bounds)).toBe(true);
    expect(isThresholdPlausible(10, bounds)).toBe(false);
    expect(isThresholdPlausible(37, bounds)).toBe(false);
    expect(isThresholdPlausible(20.5, bounds)).toBe(false);
    expect(isThresholdPlausible(Number.NaN, bounds)).toBe(false);
  });

  it('encadre toujours le prix produit par updatePrice', () => {
    // Si `updatePrice` et `alertPriceBounds` divergeaient, un seuil accepté
    // pourrait être inatteignable (ou un seuil refusé, atteignable). On
    // martèle donc le modèle avec des pressions et des graines variées.
    const floorPct = balance.market.priceFloorPct;
    const ceilPct = balance.market.priceCeilPct;
    for (const basePrice of [1, 7, 20, 150, 4_800]) {
      const bounds = alertPriceBounds(basePrice, floorPct, ceilPct);
      for (let seed = 0; seed < 40; seed += 1) {
        const state: MarketState = {
          itemKey: 'wheat',
          basePrice,
          currentPrice: basePrice,
          previousPrice: basePrice,
          demandIndex: seed % 2 === 0 ? 2 : 0.4,
          volumeWindow: seed % 3 === 0 ? 0 : 5_000,
          referenceVolume: 100,
          volatility: balance.market.volatility,
          priceFloorPct: floorPct,
          priceCeilPct: ceilPct,
          featured: seed % 4 === 0,
        };
        const { price } = updatePrice(state, balance, createRng(seed));
        expect(price).toBeGreaterThanOrEqual(bounds.min);
        expect(price).toBeLessThanOrEqual(bounds.max);
      }
    }
  });
});

describe('alertes de prix : identifiants courts', () => {
  const id = uuidv7();

  it('montre les huit premiers caractères', () => {
    expect(shortAlertId(id)).toHaveLength(ALERT_SHORT_ID_LENGTH);
    expect(id.startsWith(shortAlertId(id))).toBe(true);
  });

  it('normalise la saisie du joueur', () => {
    expect(normalizeAlertIdInput(`  \`${shortAlertId(id).toUpperCase()}\`  `)).toBe(shortAlertId(id));
    expect(normalizeAlertIdInput(id)).toBe(id);
    // Trop court pour désigner quoi que ce soit, ou pas de l'hexadécimal.
    expect(normalizeAlertIdInput('abc')).toBeUndefined();
    expect(normalizeAlertIdInput('zzzzzzzz')).toBeUndefined();
    expect(normalizeAlertIdInput('abcd%efg')).toBeUndefined();
  });

  it('reconnaît un préfixe ou un identifiant complet, jamais un autre', () => {
    expect(matchesAlertId(id, shortAlertId(id))).toBe(true);
    expect(matchesAlertId(id, id)).toBe(true);
    expect(matchesAlertId(id, id.slice(0, 20))).toBe(true);
    expect(matchesAlertId(id, uuidv7().slice(0, 8) + 'zz')).toBe(false);
  });
});

describe('alertes de prix : liste', () => {
  const alerts = [
    { itemName: 'Tomate', direction: 'below' as const, threshold: 8 },
    { itemName: 'Blé', direction: 'below' as const, threshold: 12 },
    { itemName: 'Blé', direction: 'above' as const, threshold: 40 },
    { itemName: 'Blé', direction: 'above' as const, threshold: 30 },
    { itemName: 'Épinard', direction: 'above' as const, threshold: 15 },
  ];

  it('groupe par objet, « au-dessus » avant « en dessous », puis par seuil croissant', () => {
    expect(sortAlertsForDisplay(alerts, 'fr').map((a) => `${a.itemName} ${a.direction} ${a.threshold}`)).toEqual([
      'Blé above 30',
      'Blé above 40',
      'Blé below 12',
      'Épinard above 15',
      'Tomate below 8',
    ]);
  });

  it('ne modifie pas le tableau d\'origine', () => {
    const copy = [...alerts];
    sortAlertsForDisplay(alerts);
    expect(alerts).toEqual(copy);
  });

  it('calcule l\'échéance depuis la durée configurée', () => {
    const now = new Date('2026-09-02T10:00:00.000Z');
    expect(alertExpiry(now, 14).toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(alertExpiry(now, balance.alerts.durationDays).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('alertes de prix : configuration et traductions', () => {
  it('expose un plafond et une durée dans balance.alerts', () => {
    expect(balance.alerts.maxPerUser).toBeGreaterThanOrEqual(1);
    expect(balance.alerts.durationDays).toBeGreaterThanOrEqual(1);
  });

  const fragment = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', locale, 'alerts.json'), 'utf8'),
    ) as Record<string, unknown>;

  const flatten = (value: unknown, prefix = ''): Array<[string, string]> =>
    typeof value === 'string'
      ? [[prefix, value]]
      : Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !key.startsWith('$'))
          .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));

  it('livre le même fragment en français et en anglais', () => {
    const fr = new Map(flatten(fragment('fr')));
    const en = new Map(flatten(fragment('en')));
    expect([...en.keys()].sort()).toEqual([...fr.keys()].sort());

    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
    for (const [key, text] of fr) {
      expect({ key, params: placeholders(en.get(key)!) }).toEqual({ key, params: placeholders(text) });
    }
  });

  it('fournit les clés attendues par le worker de notifications', () => {
    // Contrat avec `alertService.evaluate` : la notification ne transporte que
    // des clés, résolues dans la langue du joueur au moment de l'envoi.
    const keys = new Map(flatten(fragment('fr')));
    for (const key of [
      'notifications.price_alert_title',
      'notifications.price_alert_above_body',
      'notifications.price_alert_below_body',
    ]) {
      expect(keys.has(key), key).toBe(true);
      for (const param of ['item', 'price', 'threshold']) {
        expect(keys.get(key)!.includes(`{${param}}`) || key.endsWith('_title'), `${key} → {${param}}`).toBe(true);
      }
    }
  });
});
