/**
 * Formatage francophone : nombres, durées, dates Discord, barres de progression.
 * Aucune dépendance au reste du bot pour rester testable et réutilisable dans
 * le renderer d'images.
 */

const NUMBER_FORMAT = new Intl.NumberFormat('fr-FR');
const COMPACT_FORMAT = new Intl.NumberFormat('fr-FR', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const COIN = '🪙';
export const GEM = '💎';
export const XP = '✨';
export const ENERGY = '⚡';

/** `1234567` → `1 234 567` (espace insécable fine, comme la typographie FR). */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(Math.trunc(value));
}

/** `1234567` → `1,2 M` : pour les embeds étroits et les classements. */
export function formatCompact(value: number): string {
  return COMPACT_FORMAT.format(Math.trunc(value));
}

export function formatCoins(value: number, compact = false): string {
  return `${compact ? formatCompact(value) : formatNumber(value)} ${COIN}`;
}

export function formatGems(value: number): string {
  return `${formatNumber(value)} ${GEM}`;
}

/** Variation en pourcentage signée : `+12,4 %`. */
export function formatPercent(ratio: number, digits = 1): string {
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${(ratio * 100).toFixed(digits).replace('.', ',')} %`;
}

/**
 * Durée lisible en français : `2 j 5 h`, `3 min 20 s`, `< 1 s`.
 * On n'affiche jamais plus de deux unités : « 1 j 4 h 32 min 12 s » est illisible.
 */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1_000) return '< 1 s';

  const totalSeconds = Math.floor(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} j`);
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} min`);
  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds} s`);
  return parts.slice(0, 2).join(' ') || '< 1 s';
}

export type DiscordTimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/**
 * Horodatage Discord natif : affiché dans le fuseau du lecteur, et `R` se met à
 * jour tout seul (« dans 3 minutes ») sans qu'on ait à rafraîchir le message.
 * C'est LA bonne façon d'afficher une échéance dans un embed.
 */
export function discordTimestamp(date: Date, style: DiscordTimestampStyle = 'R'): string {
  return `<t:${Math.floor(date.getTime() / 1_000)}:${style}>`;
}

/** Barre de progression en blocs unicode : `▰▰▰▰▱▱▱▱▱▱`. */
export function progressBar(
  current: number,
  total: number,
  width = 10,
  filledChar = '▰',
  emptyChar = '▱',
): string {
  const safeTotal = total <= 0 ? 1 : total;
  const ratio = Math.min(1, Math.max(0, current / safeTotal));
  const filled = Math.round(ratio * width);
  return filledChar.repeat(filled) + emptyChar.repeat(Math.max(0, width - filled));
}

/** Jauge colorée pour les statistiques animales (faim, bonheur, santé). */
export function gaugeBar(value: number, width = 8): string {
  const clamped = Math.min(100, Math.max(0, value));
  const emoji = clamped >= 70 ? '🟩' : clamped >= 40 ? '🟨' : clamped >= 15 ? '🟧' : '🟥';
  const filled = Math.round((clamped / 100) * width);
  return emoji.repeat(Math.max(1, filled)) + '⬛'.repeat(Math.max(0, width - filled));
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return Math.abs(count) >= 2 ? (plural ?? `${singular}s`) : singular;
}

/** Tronque proprement pour respecter les limites d'embed Discord. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Neutralise le markdown d'un pseudo avant de l'injecter dans un embed. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([*_`~\\|>])/g, '\\$1');
}

const QUALITY_LABELS: Record<string, string> = {
  normal: 'Normale',
  silver: 'Argent',
  gold: 'Or',
  iridium: 'Iridium',
};

const QUALITY_ICONS: Record<string, string> = {
  normal: '',
  silver: '🥈',
  gold: '🥇',
  iridium: '💠',
};

export function qualityLabel(quality: string): string {
  return QUALITY_LABELS[quality] ?? quality;
}

export function qualityIcon(quality: string): string {
  return QUALITY_ICONS[quality] ?? '';
}

const MUTATION_ICONS: Record<string, string> = {
  none: '',
  giant: '🔆',
  rainbow: '🌈',
  ancient: '🏺',
};

export function mutationIcon(mutation: string): string {
  return MUTATION_ICONS[mutation] ?? '';
}

const RARITY_LABELS: Record<string, string> = {
  common: 'Commune',
  uncommon: 'Peu commune',
  rare: 'Rare',
  epic: 'Épique',
  legendary: 'Légendaire',
  mythic: 'Mythique',
};

export const RARITY_COLORS: Record<string, number> = {
  common: 0x9e9e9e,
  uncommon: 0x4caf50,
  rare: 0x2196f3,
  epic: 0x9c27b0,
  legendary: 0xff9800,
  mythic: 0xf44336,
};

export function rarityLabel(rarity: string): string {
  return RARITY_LABELS[rarity] ?? rarity;
}

/** Aligne une valeur à droite dans un tableau en bloc de code. */
export function padStart(value: string | number, width: number, char = ' '): string {
  return String(value).padStart(width, char);
}

export function padEnd(value: string | number, width: number, char = ' '): string {
  return String(value).padEnd(width, char);
}
