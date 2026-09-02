import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { moduleLogger } from '../utils/logger';
import type { Translator } from '../types';

const log = moduleLogger('i18n');

/**
 * Internationalisation minimaliste mais complète pour nos besoins.
 *
 * Pourquoi pas i18next : nous n'avons besoin que de trois choses — recherche par
 * clé pointée, interpolation `{nom}`, et repli sur le français. Un fichier de
 * 80 lignes fait le travail sans ajouter 400 Ko de dépendances et sans imposer
 * un cycle d'initialisation asynchrone au démarrage du bot.
 *
 * Le FRANÇAIS est la langue de référence : toute clé manquante dans une autre
 * langue tombe automatiquement sur `fr`, et une clé absolument introuvable
 * renvoie la clé elle-même (visible en test, jamais silencieuse).
 */

export const DEFAULT_LOCALE = 'fr';
export const SUPPORTED_LOCALES = ['fr', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

type Catalog = Record<string, unknown>;

const catalogs = new Map<string, Catalog>();

/**
 * Fusion profonde de deux catalogues. Les objets se fusionnent clé par clé, les
 * chaînes du second l'emportent — un fragment peut donc compléter un espace de
 * noms existant (`quests.*`) sans le remplacer.
 */
function mergeCatalogs(base: Catalog, extra: Catalog): Catalog {
  const result: Catalog = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = result[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = mergeCatalogs(existing as Catalog, value as Catalog);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Charge un catalogue complet : le fichier principal `locales/<locale>.json`,
 * puis chaque fragment `locales/<locale>/*.json` par ordre alphabétique.
 *
 * Les fragments existent pour que chaque fonctionnalité apporte SES clés dans
 * SON fichier (`locales/fr/history.json`) au lieu d'éditer un fichier de 1 200
 * clés partagé par tout le monde — c'est ce qui rend possible le développement
 * en parallèle sans conflit de fusion, et ce qui permet de retirer une
 * fonctionnalité en supprimant un fichier. La règle de parité fr/en s'applique
 * au catalogue FUSIONNÉ (voir `tests/config-and-balance.test.ts`).
 */
export function loadMergedCatalog(locale: string): Catalog {
  const root = join(__dirname, 'locales');
  let catalog: Catalog = {};

  try {
    catalog = JSON.parse(readFileSync(join(root, `${locale}.json`), 'utf8')) as Catalog;
  } catch (error) {
    log.warn({ locale, err: error }, 'catalogue de traduction introuvable');
  }

  const fragmentsDir = join(root, locale);
  if (existsSync(fragmentsDir)) {
    const fragments = readdirSync(fragmentsDir)
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of fragments) {
      try {
        const fragment = JSON.parse(readFileSync(join(fragmentsDir, file), 'utf8')) as Catalog;
        catalog = mergeCatalogs(catalog, fragment);
      } catch (error) {
        log.warn({ locale, file, err: error }, 'fragment de traduction illisible');
      }
    }
  }

  return catalog;
}

function loadCatalog(locale: string): Catalog {
  const cached = catalogs.get(locale);
  if (cached) return cached;
  const loaded = loadMergedCatalog(locale);
  catalogs.set(locale, loaded);
  return loaded;
}

/** Résout `a.b.c` dans un objet imbriqué. */
function lookup(catalog: Catalog, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = catalog;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Interpole `{nom}` par la valeur correspondante. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (!locale) return DEFAULT_LOCALE;
  const short = locale.slice(0, 2).toLowerCase();
  return (SUPPORTED_LOCALES as readonly string[]).includes(short)
    ? (short as SupportedLocale)
    : DEFAULT_LOCALE;
}

export function translate(
  locale: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  const normalized = normalizeLocale(locale);
  const direct = lookup(loadCatalog(normalized), key);
  if (direct !== undefined) return interpolate(direct, params);

  if (normalized !== DEFAULT_LOCALE) {
    const fallback = lookup(loadCatalog(DEFAULT_LOCALE), key);
    if (fallback !== undefined) return interpolate(fallback, params);
  }

  // Clé manquante : on renvoie la clé pour que le trou soit visible immédiatement.
  log.debug({ locale, key }, 'clé de traduction manquante');
  return key;
}

/** Fabrique un traducteur lié à une locale, injecté dans `CommandContext`. */
export function translatorFor(locale: string): Translator {
  return (key, params) => translate(locale, key, params);
}

/** Vide le cache (utilisé par `/admin reload-config`). */
export function reloadCatalogs(): void {
  catalogs.clear();
  log.warn('catalogues de traduction rechargés');
}
