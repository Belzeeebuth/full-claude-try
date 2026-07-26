/**
 * Hiérarchie d'erreurs du jeu.
 *
 * Distinction fondamentale :
 *  - `GameError` = erreur ATTENDUE, causée par le joueur (pas assez d'argent,
 *    parcelle occupée, niveau insuffisant). Elle est affichée telle quelle,
 *    en français, et n'est PAS remontée comme incident (log niveau debug).
 *  - toute autre erreur = incident technique : message générique côté joueur,
 *    stack complète dans les logs + rapport dans le salon d'erreurs.
 *
 * `code` sert aux métriques (`errors_total{code="insufficient_funds"}`) et
 * permet d'attacher des composants de rattrapage (bouton « Boutique » sur une
 * erreur de fonds insuffisants).
 */
export type GameErrorCode =
  | 'not_registered'
  | 'already_registered'
  | 'insufficient_funds'
  | 'insufficient_gems'
  | 'insufficient_items'
  | 'insufficient_energy'
  | 'inventory_full'
  | 'level_too_low'
  | 'plot_locked'
  | 'plot_occupied'
  | 'plot_empty'
  | 'plot_not_found'
  | 'crop_not_ready'
  | 'crop_withered'
  | 'wrong_season'
  | 'no_water_needed'
  | 'no_pest'
  | 'building_required'
  | 'building_full'
  | 'building_max_tier'
  | 'animal_not_found'
  | 'animal_dead'
  | 'animal_not_hungry'
  | 'animal_not_ready'
  | 'breeding_unavailable'
  | 'recipe_unknown'
  | 'no_crafting_slot'
  | 'craft_not_ready'
  | 'item_unknown'
  | 'item_not_sellable'
  | 'item_not_tradable'
  | 'quantity_invalid'
  | 'cooldown'
  | 'rate_limited'
  | 'eco_banned'
  | 'maintenance'
  | 'coop_not_found'
  | 'coop_full'
  | 'coop_already_member'
  | 'coop_not_member'
  | 'coop_forbidden'
  | 'coop_name_taken'
  | 'trade_forbidden'
  | 'trade_expired'
  | 'auction_not_found'
  | 'auction_own_listing'
  | 'auction_bid_too_low'
  | 'bank_capacity'
  | 'target_invalid'
  | 'privacy_blocked'
  | 'not_found'
  | 'forbidden'
  | 'busy'
  | 'invalid_state';

export interface GameErrorOptions {
  /** Suggestion d'action affichée sous le message d'erreur. */
  hint?: string;
  /** Données structurées pour les logs et les métriques. */
  context?: Record<string, unknown>;
  /** Commande à suggérer au joueur (`/shop`). */
  suggestedCommand?: string;
}

export class GameError extends Error {
  public readonly code: GameErrorCode;
  public readonly hint?: string;
  public readonly context?: Record<string, unknown>;
  public readonly suggestedCommand?: string;

  constructor(code: GameErrorCode, message: string, options: GameErrorOptions = {}) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.hint = options.hint;
    this.context = options.context;
    this.suggestedCommand = options.suggestedCommand;
  }
}

/** Raccourci : `throw gameError('insufficient_funds', '...')`. */
export function gameError(
  code: GameErrorCode,
  message: string,
  options?: GameErrorOptions,
): GameError {
  return new GameError(code, message, options);
}

export function isGameError(error: unknown): error is GameError {
  return error instanceof GameError;
}

/** Erreur de validation d'entrée (Zod, bornes, format). */
export class ValidationError extends GameError {
  constructor(message: string, options?: GameErrorOptions) {
    super('quantity_invalid', message, options);
    this.name = 'ValidationError';
  }
}

/** Le joueur est en cooldown ; `retryAt` alimente le message « réessayez dans… ». */
export class CooldownError extends GameError {
  constructor(
    public readonly retryAt: Date,
    commandName: string,
  ) {
    super('cooldown', `La commande \`/${commandName}\` est en temps de recharge.`, {
      context: { retryAt: retryAt.toISOString(), commandName },
    });
    this.name = 'CooldownError';
  }
}

export class MaintenanceError extends GameError {
  constructor(message: string) {
    super('maintenance', message);
    this.name = 'MaintenanceError';
  }
}

/** Normalise une valeur inconnue attrapée dans un `catch` en `Error`. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
