import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Générateur d'UUID v7 (RFC 9562) : 48 bits de timestamp Unix en millisecondes,
 * 12 bits de compteur monotone, puis 62 bits d'aléa.
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
let lastTimestamp = 0;
let counter = 0;

/**
 * Réserve un couple (milliseconde, compteur) strictement croissant.
 *
 * Le timestamp seul ne suffit pas : `Date.now()` a une résolution d'une
 * milliseconde, et l'application génère facilement plusieurs identifiants dans
 * la même — à la création d'un compte, neuf parcelles sont insérées d'affilée.
 * Deux UUID de la même milliseconde ne seraient alors ordonnés que par leurs
 * bits aléatoires, c'est-à-dire pas ordonnés du tout, ce qui annule justement
 * la propriété recherchée.
 *
 * On applique donc la méthode « compteur monotone » de la RFC 9562 §6.2 : les
 * 12 bits de `rand_a` portent un compteur incrémenté à chaque appel dans la
 * même milliseconde (4096 identifiants/ms), et non de l'aléa.
 */
function nextSlot(): { timestamp: number; counter: number } {
  for (;;) {
    const now = Date.now();

    if (now > lastTimestamp) {
      lastTimestamp = now;
      // Départ aléatoire sur 8 bits : deux process qui démarrent dans la même
      // milliseconde ne parcourent pas la même séquence de compteurs.
      counter = randomBytes(1)[0] ?? 0;
      return { timestamp: lastTimestamp, counter };
    }

    // Même milliseconde — ou horloge qui recule (resynchronisation NTP). Dans
    // les deux cas on reste sur `lastTimestamp` : la monotonie prime sur
    // l'exactitude de l'horodatage, qui n'est de toute façon qu'indicatif.
    if (counter < 0xfff) {
      counter += 1;
      return { timestamp: lastTimestamp, counter };
    }

    // Compteur épuisé : on attend la milliseconde suivante. En pratique
    // inatteignable (4096 UUID en 1 ms), mais mieux vaut boucler que produire
    // un identifiant hors séquence.
    while (Date.now() <= lastTimestamp) {
      /* attente active, bornée à une milliseconde */
    }
  }
}

export function uuidv7(): string {
  const slot = nextSlot();
  const bytes = randomBytes(16);

  // 48 bits de timestamp, big-endian.
  bytes[0] = (slot.timestamp / 2 ** 40) & 0xff;
  bytes[1] = (slot.timestamp / 2 ** 32) & 0xff;
  bytes[2] = (slot.timestamp / 2 ** 24) & 0xff;
  bytes[3] = (slot.timestamp / 2 ** 16) & 0xff;
  bytes[4] = (slot.timestamp / 2 ** 8) & 0xff;
  bytes[5] = slot.timestamp & 0xff;

  // Octet 6 : version 7 sur les 4 bits hauts, puis les 4 bits hauts du compteur.
  bytes[6] = 0x70 | ((slot.counter >> 8) & 0x0f);
  // Octet 7 : les 8 bits bas du compteur.
  bytes[7] = slot.counter & 0xff;
  // Variante RFC 4122 (10xx) sur les 2 bits hauts de l'octet 8 ; le reste
  // (`rand_b`, 62 bits) demeure aléatoire, ce qui rend l'ID non devinable.
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
