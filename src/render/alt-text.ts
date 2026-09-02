/**
 * Texte alternatif des images générées.
 *
 * Toute l'interface du bot est une image : sans description, un lecteur
 * d'écran n'annonce que « farm.png ». Chaque rendu produit donc, à côté du
 * PNG, une description de ce qu'il montre — factuelle, dans la langue du
 * spectateur — transmise à Discord comme `description` de la pièce jointe.
 * C'est ce qui permet de garder les images pour tout le monde au lieu
 * d'imposer le mode compact à ceux qui ne les voient pas.
 *
 * Ce fichier ne porte que les outils communs. Chaque `describeX()` vit à côté
 * de son `renderX()`, dans le même fichier, pour que le texte et le dessin
 * évoluent ensemble : un compteur ajouté à l'image doit l'être à la phrase.
 */

/** Limite de l'API Discord pour le champ `description` d'une pièce jointe. */
export const ALT_TEXT_MAX_LENGTH = 1024;

/**
 * Tronque proprement : on recule jusqu'au dernier espace pour ne pas couper un
 * mot ou un nombre en deux, puis on termine par « … ». Une description de
 * 1 025 caractères est rejetée par Discord EN BLOC, image comprise — d'où
 * l'application systématique en sortie de chaque `describeX()`.
 */
export function clampAltText(text: string, maxLength = ALT_TEXT_MAX_LENGTH): string {
  // Blancs ASCII seulement, pas `\s` : celui-ci avalerait l'espace fine
  // insécable (U+202F) qu'`Intl` place dans « 12 480 » en français, et la
  // troncature n'a pas à réécrire la typographie des nombres.
  const clean = text.replace(/[ \t\r\n]+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;

  const budget = maxLength - 1; // la place du « … » final
  const cut = clean.lastIndexOf(' ', budget);
  // Sans espace utilisable dans la moitié haute du budget — un seul mot
  // démesuré —, on coupe net : un mot tronqué vaut mieux qu'une description
  // réduite à rien.
  const head = cut > budget / 2 ? clean.slice(0, cut) : clean.slice(0, budget);
  return `${head.replace(/[\s,;:•—-]+$/u, '')}…`;
}

/** Assemble des phrases déjà ponctuées, en ignorant celles qui n'ont rien à dire. */
export function joinSentences(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

/**
 * Énumère au plus `max` éléments ; au-delà, un seul « et N autres » remplace
 * la suite. Décrire 64 parcelles une à une dépasserait la limite de Discord
 * avant même d'arriver aux informations utiles.
 */
export function listSome(items: string[], max: number, more: (rest: number) => string): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, ${more(rest)}` : shown.join(', ');
}
