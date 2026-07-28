import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';
import { PALETTE } from './canvas';

const log = moduleLogger('sprites');

/**
 * ---------------------------------------------------------------------------
 * ATLAS DE SPRITES AVEC REPLI PROCÉDURAL
 * ---------------------------------------------------------------------------
 * Convention de nommage (voir docs/05-pipeline-assets.md) :
 *   assets/sprites/crops/<cropKey>_<stage>.png     stage = 1..5
 *   assets/sprites/animals/<animalKey>.png
 *   assets/sprites/buildings/<buildingKey>.png
 *   assets/sprites/tiles/soil.png, soil_dry.png, locked.png
 *   assets/sprites/weather/<weather>.png
 *
 * Le dépôt ne contient AUCUN sprite : impossible de livrer des assets
 * graphiques sous licence claire dans un dépôt de code. Le renderer dessine donc
 * des formes procédurales quand le fichier est absent — c'est volontaire, et ça
 * donne un rendu tout à fait présentable dès la première exécution. Déposer les
 * PNG aux chemins ci-dessus les substitue automatiquement, sans changer une
 * ligne de code.
 */

const SPRITES_DIR = resolve(env.ASSETS_DIR, 'sprites');
const cache = new Map<string, Image | null>();

/** Charge un sprite ; `null` mémorisé si absent, pour ne pas retenter à chaque rendu. */
export async function sprite(category: string, name: string): Promise<Image | undefined> {
  const key = `${category}/${name}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;

  const path = join(SPRITES_DIR, category, `${name}.png`);
  if (!existsSync(path)) {
    cache.set(key, null);
    return undefined;
  }

  try {
    const image = await loadImage(await readFile(path));
    cache.set(key, image);
    return image;
  } catch (error) {
    log.warn({ err: error, path }, 'sprite illisible');
    cache.set(key, null);
    return undefined;
  }
}

export function clearSpriteCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Rendu procédural de secours
// ---------------------------------------------------------------------------

/** Parcelle de terre, teinte selon la fertilité. */
export function drawSoil(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  size: number,
  fertility: number,
): void {
  // La couleur interpole entre terre sèche (fertilité 0) et terre riche (100).
  const ratio = Math.min(1, Math.max(0, fertility / 100));
  const rich = hexToRgb(PALETTE.soil);
  const dry = hexToRgb(PALETTE.soilDry);
  const color = `rgb(${Math.round(dry.r + (rich.r - dry.r) * ratio)}, ${Math.round(
    dry.g + (rich.g - dry.g) * ratio,
  )}, ${Math.round(dry.b + (rich.b - dry.b) * ratio)})`;

  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);

  // Ombrage léger, lumière en haut à gauche : casse l'aplat sans coût de sprite.
  const shade = ctx.createLinearGradient(x, y, x + size, y + size);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, size, size);

  // Sillons : trois traits horizontaux plus sombres.
  ctx.strokeStyle = PALETTE.soilDark;
  ctx.lineWidth = Math.max(1, size / 28);
  for (let index = 1; index <= 3; index += 1) {
    const lineY = y + (size / 4) * index;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.08, lineY);
    ctx.lineTo(x + size * 0.92, lineY);
    ctx.stroke();
  }
}

export function drawLockedTile(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = PALETTE.locked;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = PALETTE.lockedStripe;
  ctx.lineWidth = Math.max(2, size / 16);
  ctx.beginPath();
  for (let offset = -size; offset < size * 2; offset += size / 4) {
    ctx.moveTo(x + offset, y);
    ctx.lineTo(x + offset + size, y + size);
  }
  ctx.save();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.stroke();
  ctx.restore();

  // Cadenas vectoriel (pas d'emoji : voir la note sur `drawBadge`).
  const cx = x + size / 2;
  const cy = y + size / 2;
  const lockWidth = size * 0.28;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(cx - lockWidth / 2, cy - size * 0.02, lockWidth, size * 0.2);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(2, size / 22);
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.02, lockWidth * 0.36, Math.PI, 0);
  ctx.stroke();
}

/**
 * Plante procédurale : tige + feuilles + fruit, dont la taille dépend du stade.
 * Cinq stades donnent une progression visuelle nette même sans sprite dédié.
 */
export function drawPlant(
  ctx: SKRSContext2D,
  options: {
    x: number;
    y: number;
    size: number;
    stage: number;
    color: string;
    fruitColor: string;
    ready: boolean;
    withered: boolean;
  },
): void {
  const { x, y, size, stage } = options;
  const centerX = x + size / 2;
  const baseY = y + size * 0.86;
  const growth = Math.min(1, Math.max(0.15, stage / 5));
  const height = size * 0.62 * growth;

  if (options.withered) {
    ctx.strokeStyle = '#7a6a55';
    ctx.lineWidth = Math.max(2, size / 22);
    ctx.beginPath();
    ctx.moveTo(centerX, baseY);
    ctx.lineTo(centerX + size * 0.1, baseY - height * 0.55);
    ctx.stroke();
    // Croix : la culture est perdue.
    ctx.strokeStyle = '#c0563f';
    ctx.lineWidth = Math.max(2, size / 16);
    const crossSize = size * 0.14;
    ctx.beginPath();
    ctx.moveTo(centerX - crossSize, y + size * 0.18 - crossSize);
    ctx.lineTo(centerX + crossSize, y + size * 0.18 + crossSize);
    ctx.moveTo(centerX + crossSize, y + size * 0.18 - crossSize);
    ctx.lineTo(centerX - crossSize, y + size * 0.18 + crossSize);
    ctx.stroke();
    return;
  }

  // Tige
  ctx.strokeStyle = options.color;
  ctx.lineWidth = Math.max(2, size / 20);
  ctx.beginPath();
  ctx.moveTo(centerX, baseY);
  ctx.lineTo(centerX, baseY - height);
  ctx.stroke();

  // Feuilles : une paire par stade, de plus en plus larges
  const leaves = Math.min(3, Math.max(1, stage - 1));
  for (let index = 0; index < leaves; index += 1) {
    const leafY = baseY - (height / (leaves + 1)) * (index + 1);
    const leafSize = size * 0.13 * growth * (1 + index * 0.15);
    for (const direction of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(
        centerX + direction * leafSize,
        leafY,
        leafSize,
        leafSize * 0.55,
        direction * 0.5,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = options.color;
      ctx.fill();
    }
  }

  // Fruit visible à partir du stade 4, plus gros et lumineux à maturité
  if (stage >= 4) {
    const fruitRadius = size * (options.ready ? 0.16 : 0.11);
    const fruitX = centerX;
    const fruitY = baseY - height - fruitRadius * 0.4;
    const shine = ctx.createRadialGradient(
      fruitX - fruitRadius * 0.35,
      fruitY - fruitRadius * 0.4,
      fruitRadius * 0.05,
      fruitX,
      fruitY,
      fruitRadius * 1.15,
    );
    shine.addColorStop(0, lightenColor(options.fruitColor, 0.5));
    shine.addColorStop(1, options.fruitColor);
    ctx.beginPath();
    ctx.arc(fruitX, fruitY, fruitRadius, 0, Math.PI * 2);
    ctx.fillStyle = shine;
    ctx.fill();
    if (options.ready) {
      ctx.strokeStyle = PALETTE.ready;
      ctx.lineWidth = Math.max(2, size / 30);
      ctx.stroke();
    }
  }
}

export type BadgeKind = 'ready' | 'water' | 'pest' | 'mutation' | 'weeds';

/**
 * Badge circulaire dessiné en VECTORIEL, pas en emoji.
 *
 * Les emoji dépendent d'une police couleur (Noto Color Emoji) qui n'est pas
 * garantie sur toutes les machines : sans elle, on obtient des carrés « tofu ».
 * Les indicateurs critiques de la vue de ferme (prêt / à arroser / nuisible)
 * sont donc tracés à la main et fonctionnent partout, y compris dans une image
 * Docker minimale. Les emoji restent utilisés dans les embeds Discord, où c'est
 * le client qui les rend.
 */
export function drawBadge(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  size: number,
  kind: BadgeKind,
  background: string,
): void {
  const radius = size / 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, size / 16);
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, size / 8);
  ctx.lineCap = 'round';

  switch (kind) {
    case 'ready': {
      // Coche
      ctx.beginPath();
      ctx.moveTo(x - radius * 0.42, y);
      ctx.lineTo(x - radius * 0.1, y + radius * 0.34);
      ctx.lineTo(x + radius * 0.45, y - radius * 0.36);
      ctx.stroke();
      break;
    }
    case 'water': {
      // Goutte
      ctx.beginPath();
      ctx.moveTo(x, y - radius * 0.55);
      ctx.quadraticCurveTo(x + radius * 0.55, y + radius * 0.15, x, y + radius * 0.5);
      ctx.quadraticCurveTo(x - radius * 0.55, y + radius * 0.15, x, y - radius * 0.55);
      ctx.fill();
      break;
    }
    case 'pest': {
      // Insecte stylisé : corps + pattes
      ctx.beginPath();
      ctx.ellipse(x, y, radius * 0.32, radius * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1, size / 14);
      for (const offset of [-0.3, 0, 0.3]) {
        ctx.beginPath();
        ctx.moveTo(x - radius * 0.5, y + radius * offset);
        ctx.lineTo(x + radius * 0.5, y + radius * offset);
        ctx.stroke();
      }
      break;
    }
    case 'mutation': {
      // Étoile à quatre branches
      ctx.beginPath();
      for (let index = 0; index < 4; index += 1) {
        const angle = (Math.PI / 2) * index;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * radius * 0.6, y + Math.sin(angle) * radius * 0.6);
      }
      ctx.stroke();
      break;
    }
    case 'weeds': {
      // Trois brins
      ctx.lineWidth = Math.max(1, size / 12);
      for (const offset of [-0.3, 0, 0.3]) {
        ctx.beginPath();
        ctx.moveTo(x + radius * offset, y + radius * 0.45);
        ctx.quadraticCurveTo(
          x + radius * offset * 2,
          y,
          x + radius * offset * 1.4,
          y - radius * 0.45,
        );
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Icône météo vectorielle (même raison que les badges : aucune dépendance à une
 * police emoji).
 */
export function drawWeatherIcon(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  size: number,
  weather: string,
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;

  const sun = (color = '#ffd93d'): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, size / 14);
    for (let index = 0; index < 8; index += 1) {
      const angle = (Math.PI / 4) * index;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * size * 0.31, cy + Math.sin(angle) * size * 0.31);
      ctx.lineTo(cx + Math.cos(angle) * size * 0.44, cy + Math.sin(angle) * size * 0.44);
      ctx.stroke();
    }
  };

  const cloud = (color = '#e8eef5'): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx - size * 0.16, cy + size * 0.06, size * 0.17, 0, Math.PI * 2);
    ctx.arc(cx + size * 0.02, cy - size * 0.04, size * 0.22, 0, Math.PI * 2);
    ctx.arc(cx + size * 0.2, cy + size * 0.08, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - size * 0.24, cy + size * 0.04, size * 0.48, size * 0.16);
  };

  const drops = (color: string, count = 3): void => {
    ctx.fillStyle = color;
    for (let index = 0; index < count; index += 1) {
      const dx = cx - size * 0.2 + index * size * 0.2;
      ctx.beginPath();
      ctx.moveTo(dx, cy + size * 0.22);
      ctx.lineTo(dx - size * 0.04, cy + size * 0.4);
      ctx.lineTo(dx + size * 0.04, cy + size * 0.4);
      ctx.closePath();
      ctx.fill();
    }
  };

  switch (weather) {
    case 'sunny':
      sun();
      break;
    case 'heatwave':
      sun('#ff8c42');
      break;
    case 'cloudy':
      cloud();
      break;
    case 'rainy':
      cloud('#c8d4e0');
      drops('#4aa3df');
      break;
    case 'storm':
      cloud('#8e99a8');
      ctx.fillStyle = '#ffd93d';
      ctx.beginPath();
      ctx.moveTo(cx, cy + size * 0.18);
      ctx.lineTo(cx - size * 0.12, cy + size * 0.42);
      ctx.lineTo(cx + size * 0.02, cy + size * 0.36);
      ctx.lineTo(cx - size * 0.06, cy + size * 0.5);
      ctx.lineTo(cx + size * 0.16, cy + size * 0.24);
      ctx.lineTo(cx + size * 0.02, cy + size * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    case 'snow':
      cloud('#f4faff');
      drops('#ffffff', 3);
      break;
    case 'frost':
      ctx.strokeStyle = '#9fd8ff';
      ctx.lineWidth = Math.max(2, size / 14);
      for (let index = 0; index < 6; index += 1) {
        const angle = (Math.PI / 3) * index;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * size * 0.36, cy + Math.sin(angle) * size * 0.36);
        ctx.stroke();
      }
      break;
    default:
      cloud();
      break;
  }
}

/** Silhouette d'animal procédurale (corps + tête + pattes). */
export function drawAnimal(
  ctx: SKRSContext2D,
  options: { x: number; y: number; size: number; color: string; emoji: string },
): void {
  const { x, y, size } = options;
  ctx.fillStyle = options.color;
  ctx.beginPath();
  ctx.ellipse(x + size * 0.5, y + size * 0.55, size * 0.28, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + size * 0.74, y + size * 0.44, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x + size * 0.34, y + size * 0.7, size * 0.06, size * 0.16);
  ctx.fillRect(x + size * 0.58, y + size * 0.7, size * 0.06, size * 0.16);

  // Œil, pour donner un peu de vie à la silhouette.
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath();
  ctx.arc(x + size * 0.78, y + size * 0.41, size * 0.025, 0, Math.PI * 2);
  ctx.fill();
}

/** Couleur associée à une rareté, pour les bordures et les accents. */
export function rarityColor(rarity: string): string {
  return (
    {
      common: '#9e9e9e',
      uncommon: '#4caf50',
      rare: '#2196f3',
      epic: '#9c27b0',
      legendary: '#ff9800',
      mythic: '#f44336',
    }[rarity] ?? '#9e9e9e'
  );
}

/**
 * Couleur de plante dérivée de la clé de culture.
 * Un hash simple garantit qu'une culture donnée a TOUJOURS la même teinte, sans
 * table de correspondance à maintenir pour 27 cultures.
 */
export function cropColors(cropKey: string): { stem: string; fruit: string } {
  let hash = 0;
  for (let index = 0; index < cropKey.length; index += 1) {
    hash = (hash * 31 + cropKey.charCodeAt(index)) % 360;
  }
  return {
    stem: `hsl(${100 + (hash % 40)}, 55%, 38%)`,
    fruit: `hsl(${hash}, 70%, 55%)`,
  };
}

/** Éclaircit une couleur `hsl(h, s%, l%)` en poussant la luminosité vers 100 %. */
function lightenColor(hsl: string, amount: number): string {
  const match = /^hsl\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%\)$/.exec(hsl);
  if (!match) return hsl;
  const [, h, s, l] = match;
  const lightness = Number(l) + (100 - Number(l)) * amount;
  return `hsl(${h}, ${s}%, ${lightness}%)`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

/** Pièce d'or vectorielle (centre en x, y). */
export function drawCoin(ctx: SKRSContext2D, x: number, y: number, radius: number): void {
  const shine = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.05,
    x,
    y,
    radius * 1.1,
  );
  shine.addColorStop(0, '#fff2b8');
  shine.addColorStop(0.5, '#ffc93c');
  shine.addColorStop(1, '#e0a41f');

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.strokeStyle = '#b8860b';
  ctx.lineWidth = Math.max(1, radius / 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.55, 0, Math.PI * 2);
  ctx.stroke();

  // Reflet : petit arc clair en haut à gauche, la touche qui lit « métal ».
  ctx.beginPath();
  ctx.arc(x - radius * 0.32, y - radius * 0.32, radius * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
}

/** Gemme vectorielle (centre en x, y). */
export function drawGem(ctx: SKRSContext2D, x: number, y: number, radius: number): void {
  const facet = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  facet.addColorStop(0, '#d4f4ff');
  facet.addColorStop(0.5, '#7fd8ff');
  facet.addColorStop(1, '#3fa8d8');

  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius, y);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - radius, y);
  ctx.closePath();
  ctx.fillStyle = facet;
  ctx.fill();
  ctx.strokeStyle = '#2f8fbe';
  ctx.lineWidth = Math.max(1, radius / 5);
  ctx.stroke();

  // Ligne de facette centrale, pour casser l'aplat en deux plans de lumière.
  ctx.beginPath();
  ctx.moveTo(x, y - radius * 0.7);
  ctx.lineTo(x, y + radius * 0.7);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = Math.max(1, radius / 8);
  ctx.stroke();
}

/**
 * Icône générique pour un objet arbitraire sans forme vectorielle dédiée
 * (utilisée par exemple dans l'en-tête du graphique de marché). Teinte dérivée
 * d'un hachage de `seed` (le nom de l'objet) : jamais deux fois la même forme
 * sans couleur cohérente, sans table de correspondance à maintenir.
 */
export function drawItemIcon(ctx: SKRSContext2D, x: number, y: number, radius: number, seed: string): void {
  const colors = cropColors(seed);
  const shine = ctx.createRadialGradient(
    x - radius * 0.3,
    y - radius * 0.35,
    radius * 0.05,
    x,
    y,
    radius * 1.1,
  );
  shine.addColorStop(0, lightenColor(colors.fruit, 0.4));
  shine.addColorStop(1, colors.fruit);

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.strokeStyle = colors.stem;
  ctx.lineWidth = Math.max(1, radius / 6);
  ctx.stroke();
}
