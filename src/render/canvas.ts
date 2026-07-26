import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createCanvas,
  GlobalFonts,
  loadImage,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('render');

/**
 * Socle du rendu d'images (@napi-rs/canvas).
 *
 * Pourquoi @napi-rs/canvas et pas node-canvas : binaire précompilé pour toutes
 * les plateformes (aucun Cairo/Pango à installer dans l'image Docker), API
 * identique à celle du navigateur, et 2 à 3 fois plus rapide sur nos scènes.
 *
 * Pourquoi pas de dépendance à chart.js pour les graphiques : `chartjs-node-canvas`
 * embarque chart.js + une couche d'adaptation, avec des frictions ESM/CJS
 * connues, et ne sait pas dessiner l'esthétique « pixel farm » du reste du bot.
 * Nos courbes sont simples (une série, une grille, un dégradé sous la courbe) :
 * 150 lignes de canvas natif donnent un rendu cohérent, sans dépendance
 * supplémentaire ni risque de rupture à la mise à jour. Ce choix est assumé et
 * documenté dans docs/02-architecture.md.
 */

export const PALETTE = {
  skyTop: '#8fd3f4',
  skyBottom: '#c9f0d2',
  soil: '#8b5a2b',
  soilDark: '#6d4520',
  soilDry: '#a97142',
  grass: '#7ec850',
  grassDark: '#5da13c',
  locked: '#4b4b4b',
  lockedStripe: '#3a3a3a',
  water: '#4aa3df',
  card: '#1f2430',
  cardAlt: '#2a3140',
  border: '#3d4657',
  text: '#f5f7fa',
  textMuted: '#a8b2c3',
  gold: '#ffc93c',
  danger: '#e05a4f',
  success: '#5cb85c',
  xp: '#8e7cff',
  ready: '#ffd93d',
} as const;

export const THEME_PALETTES: Record<string, { skyTop: string; skyBottom: string; grass: string; grassDark: string }> = {
  classic: { skyTop: '#8fd3f4', skyBottom: '#c9f0d2', grass: '#7ec850', grassDark: '#5da13c' },
  autumn: { skyTop: '#f6b26b', skyBottom: '#ffe0b2', grass: '#c98b3c', grassDark: '#a86f2c' },
  winter: { skyTop: '#cfe8ff', skyBottom: '#f4faff', grass: '#e8f1f8', grassDark: '#bcd4e6' },
  neon: { skyTop: '#180f3d', skyBottom: '#3a1a5c', grass: '#2b2f5e', grassDark: '#1b1e42' },
};

let fontsReady = false;

/**
 * Enregistre les polices présentes dans `assets/fonts`.
 * Aucune police n'est embarquée dans le dépôt (question de licence) : si le
 * dossier est vide, on retombe sur les polices système, et le rendu reste
 * correct. Voir docs/05-pipeline-assets.md pour les polices recommandées.
 */
export function ensureFonts(): void {
  if (fontsReady) return;
  fontsReady = true;

  const fontsDir = resolve(env.ASSETS_DIR, 'fonts');
  if (!existsSync(fontsDir)) {
    log.debug({ fontsDir }, 'aucun dossier de polices, repli sur les polices système');
    return;
  }

  try {
    for (const file of readdirSync(fontsDir)) {
      if (!/\.(ttf|otf|woff2?)$/i.test(file)) continue;
      GlobalFonts.registerFromPath(join(fontsDir, file), fontFamilyFromFile(file));
      log.debug({ file }, 'police enregistrée');
    }
  } catch (error) {
    log.warn({ err: error }, "échec de l'enregistrement des polices");
  }
}

function fontFamilyFromFile(file: string): string {
  return file.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_].*$/, '');
}

/** Famille de police à utiliser : la police du projet si présente, sinon sans-serif. */
export function fontFamily(): string {
  ensureFonts();
  const families = GlobalFonts.families.map((family) => family.family);
  for (const preferred of ['Harvest', 'Inter', 'Nunito', 'DejaVu Sans']) {
    if (families.includes(preferred)) return preferred;
  }
  return 'sans-serif';
}

export function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${size}px ${fontFamily()}`;
}

export function newCanvas(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  return { canvas, ctx };
}

export function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function fillRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
): void {
  roundRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function verticalGradient(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  height: number,
  from: string,
  to: string,
) {
  const gradient = ctx.createLinearGradient(x, y, x, y + height);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  return gradient;
}

/** Barre de progression avec fond, remplissage et bordure. */
export function progressBar(
  ctx: SKRSContext2D,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    ratio: number;
    fill: string;
    background?: string;
    label?: string;
  },
): void {
  const ratio = Math.min(1, Math.max(0, options.ratio));
  fillRoundRect(
    ctx,
    options.x,
    options.y,
    options.width,
    options.height,
    options.height / 2,
    options.background ?? 'rgba(255,255,255,0.12)',
  );
  if (ratio > 0) {
    fillRoundRect(
      ctx,
      options.x,
      options.y,
      Math.max(options.height, options.width * ratio),
      options.height,
      options.height / 2,
      options.fill,
    );
  }
  if (options.label) {
    ctx.font = font(Math.round(options.height * 0.7), 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.textAlign = 'center';
    ctx.fillText(
      options.label,
      options.x + options.width / 2,
      options.y + options.height * 0.18,
    );
    ctx.textAlign = 'left';
  }
}

/** Texte tronqué avec « … » si trop long. */
export function clipText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}…`;
}

/** Dessine un avatar Discord circulaire, avec repli sur un cercle coloré. */
export async function drawAvatar(
  ctx: SKRSContext2D,
  url: string | null,
  x: number,
  y: number,
  size: number,
  fallbackColor: string = PALETTE.grass,
): Promise<void> {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  const image = url ? await fetchImage(url) : undefined;
  if (image) {
    ctx.drawImage(image, x, y, size, size);
  } else {
    ctx.fillStyle = fallbackColor;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

const imageCache = new Map<string, Image>();

/**
 * Télécharge et met en cache une image distante (avatar Discord).
 * Le cache mémoire est borné à 200 entrées : les avatars changent rarement, et
 * cela évite un aller-retour réseau par rendu de profil.
 */
export async function fetchImage(url: string): Promise<Image | undefined> {
  const cached = imageCache.get(url);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return undefined;

    const buffer = Buffer.from(await response.arrayBuffer());
    const image = await loadImage(buffer);
    if (imageCache.size >= 200) {
      const oldest = imageCache.keys().next().value;
      if (oldest) imageCache.delete(oldest);
    }
    imageCache.set(url, image);
    return image;
  } catch (error) {
    log.debug({ err: error, url }, 'téléchargement d\'image échoué');
    return undefined;
  }
}

/** Encode le canvas en PNG optimisé. */
export async function encode(canvas: Canvas): Promise<Buffer> {
  return canvas.encode('png');
}

export type { Canvas, SKRSContext2D };
