/**
 * Arithmétique monétaire.
 *
 * Les soldes sont stockés en `BIGINT` côté PostgreSQL et manipulés en `number`
 * entier côté TypeScript. C'est un choix assumé plutôt qu'un raccourci :
 *  - un `number` JavaScript représente exactement tous les entiers jusqu'à
 *    2^53-1 ≈ 9,007 × 10^15. Même un joueur à 100 milliards de pièces est à
 *    cinq ordres de grandeur de la limite ;
 *  - travailler en `BigInt` obligerait à convertir à chaque calcul de rendement
 *    (qui implique des multiplicateurs fractionnaires) et rendrait la logique de
 *    jeu illisible, pour un bénéfice nul dans notre plage de valeurs ;
 *  - le vrai risque n'est pas la précision de l'entier mais l'apparition
 *    silencieuse d'un flottant après une multiplication (`prix × 1,35`). Ce
 *    module centralise donc la troncature, et `assertMoney()` refuse tout
 *    non-entier : impossible d'écrire `1234.9999` en base.
 *
 * Règle d'or : AUCUN calcul monétaire ailleurs que via ces helpers.
 */

/** Plus grande valeur monétaire acceptée (marge de sécurité sous 2^53). */
export const MAX_MONEY = 9_000_000_000_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Valide qu'une valeur est un montant utilisable (entier, fini, dans les bornes). */
export function assertMoney(value: number, label = 'montant'): number {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${label} non fini : ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} non entier : ${value}`);
  }
  if (Math.abs(value) > MAX_MONEY) {
    throw new MoneyError(`${label} hors bornes : ${value}`);
  }
  return value;
}

/**
 * Applique un multiplicateur et arrondit vers le bas.
 * Toujours arrondi À LA BAISSE côté gain joueur : cumulé sur des millions
 * d'opérations, un `Math.round` créerait de la monnaie ex nihilo.
 */
export function scaleMoney(amount: number, multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new MoneyError(`multiplicateur invalide : ${multiplier}`);
  }
  return assertMoney(Math.floor(amount * multiplier));
}

/** Part d'un montant (taxe, commission), arrondie au supérieur pour le puits. */
export function feeOf(amount: number, rate: number): number {
  if (rate <= 0) return 0;
  if (rate >= 1) return assertMoney(Math.floor(amount));
  return assertMoney(Math.ceil(amount * rate));
}

export function addMoney(a: number, b: number): number {
  return assertMoney(a + b);
}

export function subtractMoney(a: number, b: number): number {
  return assertMoney(a - b);
}

/** Somme d'une liste de montants, avec validation. */
export function sumMoney(values: readonly number[]): number {
  return assertMoney(values.reduce((total, value) => total + Math.trunc(value), 0));
}

/** Vrai si le solde permet la dépense. */
export function canAfford(balance: number, cost: number): boolean {
  return balance >= cost && cost >= 0;
}

/**
 * Coût total d'une quantité, en gardant l'entier exact.
 * `unitPrice × quantity` peut dépasser la sécurité : on vérifie avant.
 */
export function totalCost(unitPrice: number, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantité invalide : ${quantity}`);
  }
  return assertMoney(Math.trunc(unitPrice) * quantity);
}

/** Borne un montant dans un intervalle (utilisé par le marché). */
export function clampMoney(value: number, min: number, max: number): number {
  return assertMoney(Math.min(max, Math.max(min, Math.trunc(value))));
}
