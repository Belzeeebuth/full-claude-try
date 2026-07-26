import { readFileSync } from 'node:fs';
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

function loadCatalog(locale: string): Catalog {
  const cached = catalogs.get(locale);
  if (cached) return cached;
  try {
    const raw = readFileSync(join(__dirname, 'locales', `${locale}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Catalog;
    catalogs.set(locale, parsed);
    return parsed;
  } catch (error) {
    log.warn({ locale, err: error }, 'catalogue de traduction introuvable');
    catalogs.set(locale, {});
    return {};
  }
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
