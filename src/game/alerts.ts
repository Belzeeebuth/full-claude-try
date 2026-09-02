/**
 * ---------------------------------------------------------------------------
 * ALERTES DE PRIX — règles pures
 * ---------------------------------------------------------------------------
 * Le pendant VENDEUR des ordres d'achat permanents. Un ordre achète tout seul
 * quand une annonce passe sous un prix ; une alerte prévient le joueur quand le
 * marché dynamique franchit un seuil, pour qu'il vende au bon moment sans taper
 * `/market` en boucle — le pilier « sessions courtes » du cahier des charges.
 *
 * Pourquoi une alerte et non un « ordre de vente » : un vrai côté achat du
 * marché créerait un puits d'objets sans contrepartie et un vecteur de triche
 * (vendre à soi-même par un compte tiers). L'alerte ne crée ni ne détruit rien :
 * elle se contente de déclencher un message. Tout ce qui est ici est
 * déterministe et sans E/S, conformément à la règle de `src/game/**`.
 */

export type AlertDirection = 'above' | 'below';

export interface AlertBounds {
  /** Plus bas prix que le marché peut atteindre pour cet objet. */
  min: number;
  /** Plus haut prix que le marché peut atteindre pour cet objet. */
  max: number;
}

/**
 * Bornes plausibles d'un seuil : les bornes DURES du marché.
 *
 * `updatePrice` (game/market.ts) borne chaque prix dans
 * `[basePrice × floorPct, basePrice × ceilPct]` avec exactement ces arrondis
 * (plancher vers le bas, plafond vers le haut, plafond > plancher). Reprendre
 * la même formule garantit qu'un seuil accepté ici est un seuil que le marché
 * PEUT atteindre — sinon l'alerte dormirait quatorze jours pour rien, et le
 * joueur croirait le système cassé.
 */
export function alertPriceBounds(
  basePrice: number,
  priceFloorPct: number,
  priceCeilPct: number,
): AlertBounds {
  const min = Math.max(1, Math.floor(basePrice * priceFloorPct));
  const max = Math.max(min + 1, Math.ceil(basePrice * priceCeilPct));
  return { min, max };
}

/** Un seuil est acceptable s'il est entier et atteignable par le marché. */
export function isThresholdPlausible(threshold: number, bounds: AlertBounds): boolean {
  return Number.isInteger(threshold) && threshold >= bounds.min && threshold <= bounds.max;
}

/**
 * Condition de déclenchement. L'égalité déclenche dans les DEUX sens : un joueur
 * qui pose « au-dessus de 30 » veut être prévenu quand le prix vaut 30, et le
 * marché n'est pas continu — il saute d'un entier à l'autre une fois par heure,
 * donc « strictement supérieur » raterait exactement le pic visé.
 */
export function isAlertTriggered(
  direction: AlertDirection,
  threshold: number,
  price: number,
): boolean {
  return direction === 'above' ? price >= threshold : price <= threshold;
}

/** Symbole affiché à côté du seuil (`≥ 30 🪙`, `≤ 12 🪙`). */
export function alertDirectionSymbol(direction: AlertDirection): string {
  return direction === 'above' ? '≥' : '≤';
}

/**
 * Longueur de l'identifiant court montré au joueur.
 *
 * Un UUID v7 commence par 48 bits d'horodatage : deux alertes créées à des
 * instants différents divergent dès les premiers caractères, et un joueur ne
 * peut en avoir que `balance.alerts.maxPerUser`. Huit caractères hexadécimaux
 * (32 bits) sont donc largement uniques PAR JOUEUR — la résolution se fait
 * toujours restreinte au propriétaire, jamais sur toute la table.
 */
export const ALERT_SHORT_ID_LENGTH = 8;

export function shortAlertId(id: string): string {
  return id.slice(0, ALERT_SHORT_ID_LENGTH);
}

/**
 * Normalise ce que le joueur a tapé : espaces et accents graves (copie d'un
 * bloc de code Discord) retirés, minuscules. Renvoie `undefined` si la saisie
 * ne peut désigner aucun identifiant — trop courte pour être discriminante, ou
 * contenant autre chose que de l'hexadécimal et des tirets.
 */
export function normalizeAlertIdInput(input: string): string | undefined {
  const cleaned = input.trim().replace(/`/g, '').toLowerCase();
  if (cleaned.length < ALERT_SHORT_ID_LENGTH) return undefined;
  if (!/^[0-9a-f-]+$/.test(cleaned)) return undefined;
  return cleaned;
}

/** Vrai si `input` (déjà normalisé) désigne `id` : UUID complet ou préfixe. */
export function matchesAlertId(id: string, input: string): boolean {
  return id.toLowerCase().startsWith(input);
}

export interface AlertSortable {
  itemName: string;
  direction: AlertDirection;
  threshold: number;
}

/**
 * Ordre d'affichage de `/alert list` : par objet (ordre alphabétique de la
 * locale), puis les seuils « au-dessus » avant les « en dessous », puis par
 * seuil croissant. Grouper par objet rend la liste lisible d'un coup d'œil ;
 * l'ordre chronologique de création, lui, n'apprend rien au joueur.
 */
export function sortAlertsForDisplay<T extends AlertSortable>(alerts: T[], locale?: string): T[] {
  const collator = new Intl.Collator(locale?.startsWith('en') ? 'en' : 'fr', { sensitivity: 'base' });
  return [...alerts].sort((a, b) => {
    const byName = collator.compare(a.itemName, b.itemName);
    if (byName !== 0) return byName;
    if (a.direction !== b.direction) return a.direction === 'above' ? -1 : 1;
    return a.threshold - b.threshold;
  });
}

/** Date d'expiration d'une alerte créée à `now`. */
export function alertExpiry(now: Date, durationDays: number): Date {
  return new Date(now.getTime() + durationDays * 86_400_000);
}
