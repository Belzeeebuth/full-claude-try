import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Générateur d'UUID v7 (RFC 9562) : 48 bits de timestamp Unix en millisecondes
 * puis 74 bits d'aléa.
 *
 * Pourquoi pas v4 : les clés primaires v4 sont uniformément réparties, donc
 * chaque insertion touche une page aléatoire de l'index B-tree. Sur une table
 * de plusieurs millions de lignes, cela multiplie les écritures disque et
 * fragmente l'index. Un v7 est monotone croissant : les insertions vont toutes
 * dans la page la plus à droite, exactement comme un BIGSERIAL, tout en restant
 * non devinable et générable côté application sans coordination entre shards.
 *
 * Bonus : `uuidTimestamp()` permet de retrouver l'instant de création d'une
 * ligne sans lire `created_at` (pratique en débogage sur un ID trouvé dans un log).
 */
export function uuidv7(): string {
  const timestamp = Date.now();
  const bytes = randomBytes(16);

  // 48 bits de timestamp, big-endian.
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 sur les 4 bits hauts de l'octet 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Variante RFC 4122 (10xx) sur les 2 bits hauts de l'octet 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Extrait l'instant de création encodé dans un UUID v7. */
export function uuidTimestamp(uuid: string): Date | undefined {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) return undefined;
  const version = Number.parseInt(hex[12] ?? '0', 16);
  if (version !== 7) return undefined;
  return new Date(Number.parseInt(hex.slice(0, 12), 16));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** UUID v4, pour les cas où la monotonie n'a aucun intérêt (jetons éphémères). */
export const uuidv4 = randomUUID;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1

/** Code de parrainage lisible à l'oral et sans ambiguïté visuelle. */
export function referralCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return out;
}
