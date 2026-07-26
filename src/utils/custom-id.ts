/**
 * ---------------------------------------------------------------------------
 * CUSTOM IDs STRUCTURÉS
 * ---------------------------------------------------------------------------
 * Format : `namespace:action:ownerId:param1:param2:...`
 *
 * Contraintes Discord : 100 caractères maximum, chaîne opaque côté API. C'est
 * la SEULE information que le client renvoie : il ne faut donc jamais lui faire
 * confiance sur ce qui relève de l'autorisation.
 *
 * Trois règles non négociables :
 *  1. `ownerId` (identifiant Discord du propriétaire du message) est TOUJOURS
 *     présent, et `assertOwner()` est appelé avant toute action : sans cela,
 *     n'importe qui pourrait cliquer sur « Récolter » dans le message d'un autre.
 *     Un `ownerId` à `0` marque explicitement un composant public (pagination
 *     d'encyclopédie par exemple).
 *  2. Les paramètres sont des identifiants courts (slug de culture, numéro de
 *     parcelle), jamais des données de confiance : quantité, prix et cible sont
 *     revalidés côté serveur à partir de la base.
 *  3. Aucun caractère `:` dans les paramètres — `encodeParam` refuse la valeur.
 */

export const CUSTOM_ID_SEPARATOR = ':';
export const CUSTOM_ID_MAX_LENGTH = 100;
/** Marque un composant utilisable par tout le monde. */
export const PUBLIC_OWNER = '0';

export interface ParsedCustomId {
  namespace: string;
  action: string;
  ownerId: string;
  params: string[];
  raw: string;
}

export class CustomIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomIdError';
  }
}

/** Erreur levée quand un joueur clique sur le composant de quelqu'un d'autre. */
export class NotOwnerError extends Error {
  constructor(
    public readonly ownerId: string,
    public readonly clickerId: string,
  ) {
    super("This button belongs to someone else.");
    this.name = 'NotOwnerError';
  }
}

const SAFE_PARAM = /^[A-Za-z0-9_\-.=|]*$/;

function encodeParam(value: string | number | boolean): string {
  const str = String(value);
  if (!SAFE_PARAM.test(str)) {
    throw new CustomIdError(
      `Invalid custom_id parameter: "${str}" (allowed characters: A-Z a-z 0-9 _ - . = |)`,
    );
  }
  return str;
}

/**
 * Construit un custom_id validé.
 * @param namespace domaine fonctionnel (`farm`, `shop`, `quest`…)
 * @param action    action à exécuter (`harvest`, `page`, `confirm`…)
 * @param ownerId   identifiant Discord autorisé à cliquer, ou `PUBLIC_OWNER`
 */
export function buildCustomId(
  namespace: string,
  action: string,
  ownerId: string,
  ...params: Array<string | number | boolean>
): string {
  const parts = [
    encodeParam(namespace),
    encodeParam(action),
    encodeParam(ownerId),
    ...params.map(encodeParam),
  ];
  const id = parts.join(CUSTOM_ID_SEPARATOR);
  if (id.length > CUSTOM_ID_MAX_LENGTH) {
    throw new CustomIdError(
      `custom_id too long (${id.length} > ${CUSTOM_ID_MAX_LENGTH}): ${id}. ` +
        'Shorten the parameters, or cache the state in Redis behind a short token.',
    );
  }
  return id;
}

export function parseCustomId(raw: string): ParsedCustomId {
  const parts = raw.split(CUSTOM_ID_SEPARATOR);
  if (parts.length < 3) {
    throw new CustomIdError(`Malformed custom_id: "${raw}"`);
  }
  const [namespace, action, ownerId, ...params] = parts as [string, string, string, ...string[]];
  if (!namespace || !action || !ownerId) {
    throw new CustomIdError(`incomplete custom_id: « ${raw} »`);
  }
  return { namespace, action, ownerId, params, raw };
}

/** Vrai si le custom_id est public ou appartient au cliqueur. */
export function isOwner(parsed: ParsedCustomId, clickerDiscordId: string): boolean {
  return parsed.ownerId === PUBLIC_OWNER || parsed.ownerId === clickerDiscordId;
}

export function assertOwner(parsed: ParsedCustomId, clickerDiscordId: string): void {
  if (!isOwner(parsed, clickerDiscordId)) {
    throw new NotOwnerError(parsed.ownerId, clickerDiscordId);
  }
}

/** Lit un paramètre positionnel typé entier, avec bornes et valeur de repli. */
export function paramInt(
  parsed: ParsedCustomId,
  index: number,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  const raw = parsed.params[index];
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    if (options.fallback !== undefined) return options.fallback;
    throw new CustomIdError(`Expected an integer parameter at position ${index} of "${parsed.raw}"`);
  }
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, value));
}

export function paramString(parsed: ParsedCustomId, index: number, fallback = ''): string {
  return parsed.params[index] ?? fallback;
}
