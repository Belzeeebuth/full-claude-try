import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type {
  AnimalForm,
  AnimalPalette,
  AnimalVariant,
  CropForm,
  CropPalette,
} from '../config/gameplay/schemas';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';
import { PALETTE, fillRoundRect, font, lighten } from './canvas';

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

/**
 * Planche de terre en relief.
 *
 * L'ancienne version était un rectangle uni traversé de trois traits : à
 * vingt-cinq exemplaires, ça donnait un tableur. Une face avant, un dégradé
 * piloté par la VRAIE fertilité et un grain déterministe suffisent à lui donner
 * du volume — et rendent au passage la fertilité lisible sans chiffre : terre
 * pauvre claire et grisée, terre riche sombre et chaude.
 */
export function drawBed(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  size: number,
  options: { fertility: number; wet?: boolean },
): void {
  const depth = size * 0.1;
  const topHeight = size - depth;
  const ratio = Math.min(1, Math.max(0, options.fertility / 100));
  const top = mixHex('#c4a074', '#8a6038', ratio);
  const side = mixHex('#9c7b56', '#664428', ratio);

  fillRoundRect(ctx, x, y + topHeight - size * 0.06, size, depth + size * 0.06, size * 0.06, side);
  fillRoundRect(ctx, x, y, size, topHeight, size * 0.07, top);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, topHeight);
  ctx.clip();

  // Lumière en haut à gauche : un dégradé diagonal casse l'aplat sans coûter
  // un sprite. Posé sous les sillons pour qu'ils restent lisibles.
  const shade = ctx.createLinearGradient(x, y, x + size, y + topHeight);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, size, topHeight);

  // Sillons : un trait sombre doublé d'un liseré clair au-dessus. C'est ce
  // décalage d'un pixel qui donne l'impression de creux.
  const stroke = Math.max(1.5, size / 30);
  for (let index = 1; index <= 3; index += 1) {
    const lineY = y + (topHeight / 4) * index;
    ctx.strokeStyle = 'rgba(0,0,0,0.20)';
    ctx.lineWidth = stroke;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.08, lineY);
    ctx.lineTo(x + size * 0.92, lineY);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    ctx.moveTo(x + size * 0.08, lineY - stroke);
    ctx.lineTo(x + size * 0.92, lineY - stroke);
    ctx.stroke();
  }

  // Grain : mouchetis pseudo-aléatoire mais DÉTERMINISTE (semé sur la position),
  // pour que deux rendus de la même ferme donnent exactement la même image et
  // restent interchangeables dans le cache.
  let seed = Math.floor(x * 7 + y * 13) + 1;
  for (let index = 0; index < 26; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const px = x + ((seed >> 5) % Math.max(1, Math.floor(size)));
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const py = y + ((seed >> 5) % Math.max(1, Math.floor(topHeight)));
    ctx.fillStyle = (seed & 1) === 0 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.07)';
    ctx.fillRect(px, py, Math.max(1, size / 48), Math.max(1, size / 48));
  }

  if (options.wet) {
    ctx.fillStyle = 'rgba(40,90,140,0.20)';
    ctx.fillRect(x, y, size, topHeight);
  }
  ctx.restore();
}

export function drawLockedTile(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  fillRoundRect(ctx, x, y, size, size * 0.9, size * 0.07, 'rgba(38,44,36,0.45)');
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(1.5, size / 44);
  ctx.setLineDash([size / 14, size / 18]);
  ctx.strokeRect(x + 1, y + 1, size - 2, size * 0.9 - 2);
  ctx.setLineDash([]);

  // Cadenas vectoriel (pas d'emoji : voir la note sur `drawBadge`).
  const cx = x + size / 2;
  const cy = y + size * 0.45;
  const lockWidth = size * 0.24;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(cx - lockWidth / 2, cy - size * 0.02, lockWidth, size * 0.17);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(2, size / 24);
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.02, lockWidth * 0.36, Math.PI, 0);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// SILHOUETTES DE CULTURE
// ---------------------------------------------------------------------------

/**
 * Apparence résolue d'une culture.
 *
 * Elle vient de `crops.json` (`form` + `palette`). Le repli n'est plus un hash
 * du nom — qui donnait une tige toujours verte et une couleur de fruit sans
 * rapport avec la plante, tomate bleue comprise — mais un vert neutre assumé.
 */
export interface CropSkin {
  form: CropForm;
  leaf: string;
  leafDark: string;
  fruit: string;
  fruitDark: string;
}

const NEUTRAL_SKIN: CropSkin = {
  form: 'bush',
  leaf: '#4f9a4a',
  leafDark: '#356b32',
  fruit: '#d8c04a',
  fruitDark: '#a08f2f',
};

export function cropSkin(crop?: { form?: CropForm; palette?: CropPalette }): CropSkin {
  if (!crop) return NEUTRAL_SKIN;
  const palette = crop.palette;
  return {
    form: crop.form ?? NEUTRAL_SKIN.form,
    leaf: palette?.leaf ?? NEUTRAL_SKIN.leaf,
    leafDark: palette?.leafDark ?? NEUTRAL_SKIN.leafDark,
    fruit: palette?.fruit ?? NEUTRAL_SKIN.fruit,
    fruitDark: palette?.fruitDark ?? NEUTRAL_SKIN.fruitDark,
  };
}

export interface CropDrawOptions {
  x: number;
  y: number;
  size: number;
  /** 1 à 5, comme les cinq stades de croissance du moteur. */
  stage: number;
  skin: CropSkin;
  ready: boolean;
  withered: boolean;
  /** Semence de variation : deux parcelles voisines ne sont pas superposables. */
  seed: number;
}

/**
 * Dessine la culture. La SILHOUETTE porte l'identité de la plante, et sa taille
 * porte le stade — ce qui permet de supprimer les comptes à rebours par tuile :
 * la plante est déjà la barre de progression.
 */
export function drawCrop(ctx: SKRSContext2D, options: CropDrawOptions): void {
  const { x, y, size, stage, skin } = options;
  const cx = x + size / 2;
  const baseY = y + size * 0.8;
  const growth = Math.min(1, Math.max(0.28, stage / 5)) * 1.32;

  if (options.withered) {
    drawWithered(ctx, cx, baseY, size);
    return;
  }

  // Ombre portée : sans elle, la plante flotte au-dessus de la planche.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, baseY + size * 0.03, size * 0.24 * growth, size * 0.07 * growth, 0, 0, Math.PI * 2);
  ctx.fill();

  if (stage <= 1) {
    drawSeedling(ctx, cx, baseY, size, skin);
    return;
  }

  switch (skin.form) {
    case 'stalk':
      return drawStalk(ctx, cx, baseY, size, growth, skin, options.ready, options.seed);
    case 'tall':
      return drawTall(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    case 'bush':
      return drawBush(ctx, cx, baseY, size, growth, skin, options.ready, stage, options.seed);
    case 'vine':
      return drawVine(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    case 'ground':
      return drawGroundFruit(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    case 'tree':
      return drawTree(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    case 'root':
      return drawRoot(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    case 'leafy':
      return drawLeafy(ctx, cx, baseY, size, growth, skin, options.ready);
    case 'flower':
      return drawFlower(ctx, cx, baseY, size, growth, skin, options.ready, stage);
    default: {
      const exhaustive: never = skin.form;
      throw new Error(`unknown crop form: ${String(exhaustive)}`);
    }
  }
}

/** Semis : la butte de terre retournée dit « planté », un point vert non. */
function drawSeedling(ctx: SKRSContext2D, cx: number, baseY: number, size: number, skin: CropSkin): void {
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx, baseY, size * 0.2, size * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = skin.leafDark;
  ctx.lineWidth = Math.max(1.6, size / 34);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - size * 0.12);
  ctx.stroke();
  for (const direction of [-1, 1]) {
    ctx.fillStyle = skin.leaf;
    ctx.beginPath();
    ctx.ellipse(cx + direction * size * 0.06, baseY - size * 0.13, size * 0.06, size * 0.035, direction * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Céréale : une touffe d'épis inclinés. */
function drawStalk(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, seed: number,
): void {
  const stalks = 7;
  const height = size * 0.72 * growth;
  for (let index = 0; index < stalks; index += 1) {
    const offset = (index - (stalks - 1) / 2) * size * 0.12;
    const lean = (((index * 37 + seed) % 7) - 3) * size * 0.012;
    const topX = cx + offset + lean;
    const topY = baseY - height * (0.82 + ((index * 13 + seed) % 5) * 0.045);

    ctx.strokeStyle = skin.leafDark;
    ctx.lineWidth = Math.max(1.8, size / 30);
    ctx.beginPath();
    ctx.moveTo(cx + offset * 0.5, baseY);
    ctx.quadraticCurveTo(cx + offset, baseY - height * 0.5, topX, topY);
    ctx.stroke();

    if (growth > 0.55) {
      ctx.fillStyle = ready ? skin.fruit : skin.leaf;
      const earLength = size * 0.2 * growth;
      for (let grain = 0; grain < 4; grain += 1) {
        const along = grain / 4;
        const gx = topX + (topX - cx - offset) * along * 0.2;
        const gy = topY + earLength * along;
        ctx.beginPath();
        ctx.ellipse(gx, gy, size * 0.03, size * 0.05, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Tige haute à tête : maïs, tournesol. */
function drawTall(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  const height = size * 0.78 * growth;
  ctx.strokeStyle = skin.leafDark;
  ctx.lineWidth = Math.max(2.4, size / 20);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - height);
  ctx.stroke();

  // Longues feuilles retombantes, alternées
  for (const [index, direction] of [-1, 1, -1, 1].entries()) {
    const anchorY = baseY - height * (0.3 + index * 0.17);
    ctx.fillStyle = index % 2 === 0 ? skin.leafDark : skin.leaf;
    ctx.beginPath();
    ctx.moveTo(cx, anchorY);
    ctx.quadraticCurveTo(
      cx + direction * size * 0.2, anchorY - size * 0.08,
      cx + direction * size * 0.28, anchorY + size * 0.06,
    );
    ctx.quadraticCurveTo(
      cx + direction * size * 0.17, anchorY - size * 0.01,
      cx, anchorY,
    );
    ctx.fill();
  }

  if (stage >= 4) {
    const headHeight = size * (ready ? 0.2 : 0.15);
    const headWidth = size * (ready ? 0.1 : 0.08);
    ctx.fillStyle = skin.fruitDark;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - height - headHeight * 0.25, headWidth, headHeight * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = skin.fruit;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - height - headHeight * 0.32, headWidth * 0.82, headHeight * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Buisson : masse foliaire ronde, fruits à partir du stade 4. */
function drawBush(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number, seed: number,
): void {
  const radius = size * 0.34 * growth;
  ctx.strokeStyle = skin.leafDark;
  ctx.lineWidth = Math.max(1.6, size / 34);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - radius * 1.1);
  ctx.stroke();

  const lobes = [
    { dx: -radius * 0.75, dy: -radius * 0.7, r: radius * 0.78 },
    { dx: radius * 0.75, dy: -radius * 0.65, r: radius * 0.72 },
    { dx: 0, dy: -radius * 1.15, r: radius * 0.85 },
  ];
  for (const lobe of lobes) {
    ctx.fillStyle = skin.leafDark;
    ctx.beginPath();
    ctx.ellipse(cx + lobe.dx, baseY + lobe.dy, lobe.r, lobe.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    // Le lobe clair est décalé vers le haut : la lumière vient du ciel.
    ctx.fillStyle = skin.leaf;
    ctx.beginPath();
    ctx.ellipse(cx + lobe.dx, baseY + lobe.dy - lobe.r * 0.16, lobe.r * 0.82, lobe.r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (stage >= 4) {
    const count = ready ? 3 : 2;
    for (let index = 0; index < count; index += 1) {
      const angle = -Math.PI / 2 + (index - (count - 1) / 2) * 0.9 + ((seed % 5) - 2) * 0.08;
      const fx = cx + Math.cos(angle) * radius * 0.8;
      const fy = baseY - radius * 0.75 + Math.sin(angle) * radius * 0.5;
      drawFruit(ctx, fx, fy, size * (ready ? 0.075 : 0.055), skin);
    }
  }
}

/** Treille : deux montants, une barre, des grappes. */
function drawVine(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  const height = size * 0.66 * growth;
  ctx.strokeStyle = '#8a6a45';
  ctx.lineWidth = Math.max(1.6, size / 36);
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.2, baseY);
  ctx.lineTo(cx - size * 0.2, baseY - height);
  ctx.moveTo(cx + size * 0.2, baseY);
  ctx.lineTo(cx + size * 0.2, baseY - height);
  ctx.moveTo(cx - size * 0.24, baseY - height * 0.9);
  ctx.lineTo(cx + size * 0.24, baseY - height * 0.9);
  ctx.stroke();

  for (const [offsetY, color] of [[0.92, skin.leafDark], [0.95, skin.leaf]] as const) {
    ctx.fillStyle = color;
    for (let index = -2; index <= 2; index += 1) {
      ctx.beginPath();
      ctx.ellipse(cx + index * size * 0.1, baseY - height * offsetY, size * 0.06, size * 0.045, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (stage >= 4) {
    const bunchTop = baseY - height * 0.82;
    const berry = size * (ready ? 0.038 : 0.03);
    for (let row = 0; row < (ready ? 4 : 3); row += 1) {
      const count = 3 - Math.floor(row / 2);
      for (let col = 0; col < count; col += 1) {
        const bx = cx + (col - (count - 1) / 2) * berry * 1.8;
        const by = bunchTop + row * berry * 1.5;
        ctx.fillStyle = skin.fruitDark;
        ctx.beginPath();
        ctx.arc(bx, by, berry, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = skin.fruit;
        ctx.beginPath();
        ctx.arc(bx - berry * 0.15, by - berry * 0.18, berry * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Courge posée au sol, sous de larges feuilles. */
function drawGroundFruit(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  ctx.fillStyle = skin.leafDark;
  for (const direction of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + direction * size * 0.23, baseY - size * 0.06, size * 0.19 * growth, size * 0.13 * growth, direction * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = skin.leaf;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - size * 0.14, size * 0.21 * growth, size * 0.14 * growth, 0, 0, Math.PI * 2);
  ctx.fill();

  if (stage >= 3) {
    const radius = size * (stage >= 5 ? 0.21 : stage >= 4 ? 0.16 : 0.11);
    ctx.fillStyle = skin.fruitDark;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - radius * 0.75, radius, radius * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = skin.fruit;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - radius * 0.85, radius * 0.88, radius * 0.74, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = skin.fruitDark;
    ctx.lineWidth = Math.max(1, size / 60);
    for (const offset of [-0.45, 0, 0.45]) {
      ctx.beginPath();
      ctx.ellipse(cx + radius * offset * 0.5, baseY - radius * 0.85, radius * 0.24, radius * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (ready) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.ellipse(cx - radius * 0.38, baseY - radius * 1.2, radius * 0.2, radius * 0.13, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Arbuste : tronc, houppier, fruits. */
function drawTree(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  const height = size * 0.48 * growth;
  ctx.strokeStyle = '#7a5537';
  ctx.lineWidth = Math.max(2, size / 22);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - height);
  ctx.stroke();

  const crown = size * 0.22 * growth;
  ctx.fillStyle = skin.leafDark;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - height - crown * 0.4, crown * 1.15, crown, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = skin.leaf;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - height - crown * 0.6, crown * 0.95, crown * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();

  if (stage >= 4) {
    const berry = size * 0.032;
    for (const [dx, dy] of [[-0.55, 0.1], [0.5, -0.15], [0.05, 0.35]] as const) {
      ctx.fillStyle = ready ? skin.fruit : skin.leafDark;
      ctx.beginPath();
      ctx.arc(cx + crown * dx, baseY - height - crown * 0.4 + crown * dy, berry, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Racine : fanes vertes, épaule colorée qui sort de terre à maturité. */
function drawRoot(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  if (stage >= 4) {
    const shoulder = size * (ready ? 0.09 : 0.06);
    ctx.fillStyle = skin.fruitDark;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - shoulder * 0.2, shoulder, shoulder * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = skin.fruit;
    ctx.beginPath();
    ctx.ellipse(cx, baseY - shoulder * 0.3, shoulder * 0.85, shoulder * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = skin.leaf;
  ctx.lineWidth = Math.max(1.5, size / 40);
  for (const angle of [-0.6, -0.2, 0.2, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(cx, baseY - size * 0.04);
    ctx.quadraticCurveTo(
      cx + Math.sin(angle) * size * 0.1,
      baseY - size * 0.2 * growth,
      cx + Math.sin(angle) * size * 0.19,
      baseY - size * 0.34 * growth,
    );
    ctx.stroke();
  }
}

/** Rosette : des feuilles et rien d'autre — la salade n'a pas de fruit. */
function drawLeafy(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean,
): void {
  const radius = size * 0.28 * growth;
  const rings: Array<[number, string]> = [
    [1, skin.leafDark],
    [0.72, skin.leaf],
    [0.42, ready ? skin.fruit : skin.leaf],
  ];
  for (const [scale, color] of rings) {
    ctx.fillStyle = color;
    const petals = 7;
    for (let index = 0; index < petals; index += 1) {
      const angle = (index / petals) * Math.PI * 2 + scale;
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(angle) * radius * scale * 0.5,
        baseY - radius * 0.42 + Math.sin(angle) * radius * scale * 0.3,
        radius * scale * 0.52,
        radius * scale * 0.4,
        angle,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
}

/** Hampe et corolle : lavande, vanille, safran, lotus. */
function drawFlower(
  ctx: SKRSContext2D, cx: number, baseY: number, size: number,
  growth: number, skin: CropSkin, ready: boolean, stage: number,
): void {
  const height = size * 0.55 * growth;
  ctx.strokeStyle = skin.leafDark;
  ctx.lineWidth = Math.max(1.6, size / 34);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - height);
  ctx.stroke();

  ctx.fillStyle = skin.leaf;
  for (const direction of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + direction * size * 0.08, baseY - height * 0.42, size * 0.075, size * 0.035, direction * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (stage >= 3) {
    const petal = size * (ready ? 0.075 : 0.055);
    const petals = 6;
    ctx.fillStyle = skin.fruit;
    for (let index = 0; index < petals; index += 1) {
      const angle = (index / petals) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(angle) * petal * 0.85,
        baseY - height + Math.sin(angle) * petal * 0.85,
        petal * 0.62,
        petal * 0.4,
        angle,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.fillStyle = skin.fruitDark;
    ctx.beginPath();
    ctx.arc(cx, baseY - height, petal * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Fruit sphérique avec ombre propre et point spéculaire : c'est ce qui donne le volume. */
function drawFruit(ctx: SKRSContext2D, x: number, y: number, radius: number, skin: CropSkin): void {
  // Base sombre : elle détache le fruit du feuillage derrière lui.
  ctx.fillStyle = skin.fruitDark;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Dégradé radial plutôt qu'un aplat plus un point blanc : le volume est plus
  // franc, pour le même nombre d'appels de dessin.
  const shine = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.05,
    x,
    y,
    radius * 1.1,
  );
  shine.addColorStop(0, lighten(skin.fruit, 0.5));
  shine.addColorStop(1, skin.fruit);
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.12, radius * 0.88, 0, Math.PI * 2);
  ctx.fill();
}

function drawWithered(ctx: SKRSContext2D, cx: number, baseY: number, size: number): void {
  ctx.strokeStyle = '#8a7757';
  ctx.lineWidth = Math.max(2.4, size / 22);
  for (const angle of [-0.8, -0.25, 0.25, 0.8]) {
    ctx.beginPath();
    ctx.moveTo(cx, baseY);
    ctx.quadraticCurveTo(
      cx + Math.sin(angle) * size * 0.12,
      baseY - size * 0.3,
      cx + Math.sin(angle) * size * 0.26,
      baseY - size * 0.22,
    );
    ctx.stroke();
  }
  ctx.fillStyle = '#6f5d42';
  for (const direction of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + direction * size * 0.17, baseY - size * 0.16, size * 0.07, size * 0.035, direction * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

export type BadgeKind = 'ready' | 'water' | 'pest' | 'mutation' | 'weeds' | 'feed' | 'sick' | 'pet';

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
    case 'feed': {
      // Gamelle : un bol vu de face, le repère universel du « à nourrir ».
      ctx.beginPath();
      ctx.arc(x, y - radius * 0.05, radius * 0.48, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, size / 10);
      ctx.beginPath();
      ctx.moveTo(x - radius * 0.58, y - radius * 0.1);
      ctx.lineTo(x + radius * 0.58, y - radius * 0.1);
      ctx.stroke();
      break;
    }
    case 'sick': {
      // Croix : le signe du soin, lisible même à 8 px.
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.beginPath();
      ctx.moveTo(x - radius * 0.45, y);
      ctx.lineTo(x + radius * 0.45, y);
      ctx.moveTo(x, y - radius * 0.45);
      ctx.lineTo(x, y + radius * 0.45);
      ctx.stroke();
      break;
    }
    case 'pet': {
      // Cœur : deux lobes et une pointe.
      const top = y - radius * 0.3;
      ctx.beginPath();
      ctx.moveTo(x, y + radius * 0.5);
      ctx.bezierCurveTo(x - radius * 0.9, y - radius * 0.1, x - radius * 0.45, top - radius * 0.4, x, top);
      ctx.bezierCurveTo(x + radius * 0.45, top - radius * 0.4, x + radius * 0.9, y - radius * 0.1, x, y + radius * 0.5);
      ctx.closePath();
      ctx.fill();
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

// ---------------------------------------------------------------------------
// SILHOUETTES D'ANIMAUX
// ---------------------------------------------------------------------------

/**
 * Apparence résolue d'un animal : `form` + `palette` de `animals.json`.
 *
 * Renvoie `undefined` quand l'espèce n'en déclare pas : l'appelant retombe
 * alors sur `drawAnimal()`, la silhouette générique, plutôt que sur une forme
 * devinée — mieux vaut un animal beige qu'une poule dessinée en vache.
 */
export interface AnimalSkin {
  form: AnimalForm;
  palette: AnimalPalette;
}

export function animalSkin(
  animal?: { form?: AnimalForm | null; palette?: AnimalPalette | null },
): AnimalSkin | undefined {
  if (!animal?.form || !animal.palette) return undefined;
  return { form: animal.form, palette: animal.palette };
}

export interface AnimalDrawOptions {
  x: number;
  y: number;
  size: number;
  form: AnimalForm;
  palette: AnimalPalette;
  /** `1` regarde vers la droite (défaut), `-1` vers la gauche. */
  facing?: 1 | -1;
  /** Semence de variation : deux bêtes voisines ne sont pas superposables. */
  seed?: number;
  /** Œil fermé et « zz » : l'animal dort (bonheur au plus haut, rien à faire). */
  sleeping?: boolean;
  /** Pansement sur le flanc : l'animal est malade. */
  sick?: boolean;
  /**
   * Variante : `shiny` ajoute un halo d'étincelles semé, `golden` tire la
   * palette de l'espèce vers l'or et pose un reflet. Absente → `normal`.
   */
  variant?: AnimalVariant;
}

/** Position de l'œil rendue par chaque forme, pour que l'œil soit dessiné en dernier. */
interface EyeSpot {
  x: number;
  y: number;
  r: number;
}

type FormPainter = (
  ctx: SKRSContext2D,
  cx: number,
  groundY: number,
  size: number,
  palette: AnimalPalette,
  seed: number,
) => EyeSpot;

/**
 * Dessine un animal selon sa SILHOUETTE d'espèce.
 *
 * Même parti pris que `drawCrop()` : la forme dit l'espèce, la palette la
 * colore, et un seul œil suffit à donner vie. Chaque silhouette tient dans
 * la boîte `[x, x+size] × [y, y+size]`, pieds au sol vers `y + 0.86 × size`,
 * pour rester lisible à 34 px (pied de page de la ferme) comme à 96 px.
 *
 * Le regard va vers la DROITE par défaut ; `facing: -1` retourne la bête par
 * un miroir horizontal, ce qui évite de coder chaque forme deux fois. Les
 * indicateurs (pansement, « zz ») sont posés après le miroir : un « zz »
 * retourné se lirait à l'envers.
 */
export function drawAnimalForm(ctx: SKRSContext2D, options: AnimalDrawOptions): void {
  const { x, y, size, form } = options;
  const variant = options.variant ?? 'normal';
  // Une dorée garde sa silhouette et ses proportions : seule la palette
  // change, tirée vers l'or — on reconnaît toujours l'espèce.
  const palette = variant === 'golden' ? goldenPalette(options.palette) : options.palette;
  const facing = options.facing ?? 1;
  const seed = Math.abs(Math.floor(options.seed ?? 0));
  const cx = x + size / 2;
  const groundY = y + size * 0.86;

  // Ombre portée : sans elle, la bête flotte au-dessus de l'herbe. Un insecte
  // vole, son ombre est plus petite et plus pâle.
  const hovering = form === 'insect';
  ctx.fillStyle = hovering ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, groundY + size * 0.02, size * (hovering ? 0.18 : 0.3), size * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  if (facing < 0) {
    ctx.translate(cx * 2, 0);
    ctx.scale(-1, 1);
  }
  const eye = ANIMAL_PAINTERS[form](ctx, cx, groundY, size, palette, seed);
  drawEye(ctx, eye, options.sleeping === true);
  ctx.restore();

  // La marque de variante passe AVANT pansement et « zz » : ce sont des
  // indicateurs d'action, ils doivent rester lisibles par-dessus le décor.
  drawVariantMark(ctx, { x, y, size, variant, seed });
  if (options.sick) drawBandage(ctx, cx - size * 0.08, groundY - size * 0.42, size);
  if (options.sleeping) drawSleep(ctx, x + size * 0.72, y + size * 0.02, size);
}

// ---------------------------------------------------------------------------
// VARIANTES : SHINY ET DORÉE
// ---------------------------------------------------------------------------

/** Teintes de l'or vers lesquelles on TIRE la palette de l'espèce, sans la remplacer. */
const GOLD_PALETTE: AnimalPalette = {
  body: '#f4c94e',
  bodyDark: '#b98a2a',
  accent: '#fff1b3',
  accentDark: '#d9a63c',
};

/**
 * Palette d'une bête dorée : 70 % d'or sur le corps, un peu moins sur
 * l'accent pour que bec, cornes ou crête gardent une trace de leur teinte —
 * une poule dorée reste une poule, pas une statue. `mixHex` (plus bas) rend
 * une couleur `rgb()`, que le canvas accepte comme un hexadécimal.
 */
export function goldenPalette(palette: AnimalPalette): AnimalPalette {
  return {
    body: mixHex(palette.body, GOLD_PALETTE.body, 0.7),
    bodyDark: mixHex(palette.bodyDark, GOLD_PALETTE.bodyDark, 0.7),
    accent: mixHex(palette.accent, GOLD_PALETTE.accent, 0.55),
    accentDark: mixHex(palette.accentDark, GOLD_PALETTE.accentDark, 0.55),
  };
}

/** Étoile à quatre branches : une étincelle lisible à 4 px comme à 12 px. */
function drawStar(ctx: SKRSContext2D, x: number, y: number, radius: number, fill: string): void {
  const inner = radius * 0.32;
  ctx.beginPath();
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + inner, y - inner);
  ctx.lineTo(x + radius, y);
  ctx.lineTo(x + inner, y + inner);
  ctx.lineTo(x, y + radius);
  ctx.lineTo(x - inner, y + inner);
  ctx.lineTo(x - radius, y);
  ctx.lineTo(x - inner, y - inner);
  ctx.closePath();
  // Liseré sombre : sur la paille claire du poulailler, une étoile blanche
  // nue disparaîtrait.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, radius * 0.25);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineJoin = 'miter';
}

/**
 * Marque de variante autour d'une bête déjà dessinée (silhouette OU sprite
 * PNG : la marque ne dépend pas de la façon dont le corps a été peint).
 *
 *  - shiny : cinq étincelles blanches et bleutées sur un anneau autour du
 *    corps, à des angles SEMÉS sur la graine de la bête — deux shiny voisines
 *    ne scintillent pas au même endroit, mais la même bête scintille toujours
 *    pareil (cache d'images) ;
 *  - dorée : un reflet clair sur l'épaule et une étoile d'or au-dessus de la
 *    tête, en couronne — la teinte seule ne suffit pas à 34 px, l'étoile la
 *    confirme. Au centre et non dans un coin : les quatre coins sont ceux
 *    des pastilles d'action (`drawResident`), qui la recouvriraient.
 *
 * Volontairement petit : la variante est un bonus, pas l'espèce.
 */
export function drawVariantMark(
  ctx: SKRSContext2D,
  options: { x: number; y: number; size: number; variant: AnimalVariant; seed?: number },
): void {
  const { x, y, size, variant } = options;
  if (variant === 'normal') return;
  const seed = Math.abs(Math.floor(options.seed ?? 0));
  const cx = x + size / 2;
  const cy = y + size * 0.5;

  if (variant === 'shiny') {
    const colors = ['#ffffff', '#cfefff', '#ffffff', '#e9f7ff', '#ffffff'];
    for (let index = 0; index < 5; index += 1) {
      // Angle semé sur un cinquième de tour, rayon légèrement varié :
      // l'anneau reste régulier de loin, vivant de près.
      const angle = (index / 5) * Math.PI * 2 + ((seed * 7 + index * 13) % 40) / 40 * 1.1 - 0.4;
      const wobble = ((seed * 3 + index * 5) % 10) / 10;
      const rx = size * (0.36 + wobble * 0.06);
      const ry = size * (0.33 + wobble * 0.05);
      // Plancher en pixels : à 34 px, une étincelle proportionnelle ferait
      // deux pixels et ne se verrait plus.
      const radius = Math.max(index % 2 === 0 ? 3.2 : 2.4, size * (index % 2 === 0 ? 0.075 : 0.05));
      drawStar(ctx, cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry, radius, colors[index]!);
    }
    return;
  }

  // Dorée : reflet sur l'épaule (trait clair, arrondi, semi-transparent) puis
  // l'étoile d'or.
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = Math.max(1.5, size * 0.045);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.2, y + size * 0.5);
  ctx.lineTo(cx - size * 0.08, y + size * 0.4);
  ctx.stroke();
  ctx.lineCap = 'butt';
  drawStar(ctx, cx, y + size * 0.08, Math.max(4, size * 0.1), '#ffd84a');
}

/** Œil : sclère claire et pupille sombre — lisible sur un corps clair comme sombre. */
function drawEye(ctx: SKRSContext2D, eye: EyeSpot, sleeping: boolean): void {
  if (sleeping) {
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(1, eye.r * 0.6);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(eye.x, eye.y - eye.r * 0.2, eye.r, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.lineCap = 'butt';
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(eye.x, eye.y, eye.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.beginPath();
  ctx.arc(eye.x + eye.r * 0.25, eye.y, eye.r * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

/** Pansement : un petit rectangle clair en travers du flanc, avec deux bandes. */
function drawBandage(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  const w = size * 0.24;
  const h = size * 0.1;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.6);
  fillRoundRect(ctx, -w / 2, -h / 2, w, h, h / 2, '#f3e9d6');
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = Math.max(1, size / 60);
  ctx.beginPath();
  ctx.moveTo(-w * 0.2, -h / 2);
  ctx.lineTo(-w * 0.2, h / 2);
  ctx.moveTo(w * 0.2, -h / 2);
  ctx.lineTo(w * 0.2, h / 2);
  ctx.stroke();
  ctx.restore();
}

/** « zz » au-dessus de la tête : deux lettres, pas une bulle. */
function drawSleep(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  const px = Math.max(8, Math.round(size * 0.18));
  ctx.font = font(px, 'bold');
  ctx.textBaseline = 'top';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(1.5, px / 6);
  ctx.strokeText('z', x, y + px * 0.4);
  ctx.strokeText('z', x + px * 0.7, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('z', x, y + px * 0.4);
  ctx.fillText('z', x + px * 0.7, y);
}

function ellipse(ctx: SKRSContext2D, x: number, y: number, rx: number, ry: number, color: string, rotation = 0): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

function legs(
  ctx: SKRSContext2D,
  color: string,
  groundY: number,
  xs: number[],
  top: number,
  width: number,
): void {
  ctx.fillStyle = color;
  for (const lx of xs) {
    ctx.fillRect(lx - width / 2, top, width, groundY - top);
  }
}

/** Volaille : corps rond, queue en éventail, crête et bec en accent. */
function paintFowl(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.05;
  const bodyY = groundY - size * 0.32;
  legs(ctx, p.bodyDark, groundY, [bodyX - size * 0.06, bodyX + size * 0.08], bodyY + size * 0.12, size * 0.04);
  // Queue : trois plumes en éventail, la tenue dépend de la graine.
  for (const [index, angle] of [-0.9, -0.55, -0.2].entries()) {
    const lean = angle + ((seed + index) % 3) * 0.06;
    ellipse(ctx, bodyX - size * 0.3, bodyY - size * 0.1, size * 0.17, size * 0.06, index === 1 ? p.bodyDark : p.body, lean);
  }
  ellipse(ctx, bodyX, bodyY, size * 0.3, size * 0.22, p.body);
  // Aile : un lobe plus sombre sur le flanc.
  ellipse(ctx, bodyX - size * 0.04, bodyY + size * 0.02, size * 0.17, size * 0.1, p.bodyDark, 0.25);
  const headX = cx + size * 0.24;
  const headY = groundY - size * 0.54;
  // Cou court : relie la tête au corps sans laisser d'espace.
  ellipse(ctx, headX - size * 0.08, headY + size * 0.1, size * 0.1, size * 0.12, p.body);
  ellipse(ctx, headX, headY, size * 0.13, size * 0.13, p.body);
  // Crête : trois bosses, et caroncule sous le bec.
  ctx.fillStyle = p.accent;
  for (const [dx, r] of [[-0.07, 0.045], [0, 0.055], [0.07, 0.045]] as const) {
    ctx.beginPath();
    ctx.arc(headX + size * dx, headY - size * 0.12, size * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ellipse(ctx, headX + size * 0.09, headY + size * 0.12, size * 0.035, size * 0.05, p.accent);
  // Bec
  ctx.fillStyle = p.accentDark;
  ctx.beginPath();
  ctx.moveTo(headX + size * 0.11, headY - size * 0.02);
  ctx.lineTo(headX + size * 0.24, headY + size * 0.03);
  ctx.lineTo(headX + size * 0.11, headY + size * 0.07);
  ctx.closePath();
  ctx.fill();
  return { x: headX + size * 0.03, y: headY - size * 0.02, r: size * 0.045 };
}

/** Grand oiseau à long cou : corps ovale, cou en S, longues pattes. */
function paintLongneck(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.1;
  const bodyY = groundY - size * 0.36;
  ctx.strokeStyle = p.accentDark;
  ctx.lineWidth = Math.max(1.5, size * 0.035);
  ctx.lineCap = 'round';
  for (const lx of [bodyX - size * 0.04, bodyX + size * 0.08]) {
    ctx.beginPath();
    ctx.moveTo(lx, bodyY + size * 0.1);
    ctx.lineTo(lx, groundY);
    ctx.lineTo(lx + size * 0.07, groundY);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  // Plumes de queue relevées
  for (const [index, angle] of [-1.1, -0.8].entries()) {
    ellipse(ctx, bodyX - size * 0.26, bodyY - size * 0.02, size * 0.14, size * 0.05, index === 0 ? p.accentDark : p.bodyDark, angle);
  }
  ellipse(ctx, bodyX, bodyY, size * 0.26, size * 0.17, p.body);
  ellipse(ctx, bodyX - size * 0.02, bodyY - size * 0.02, size * 0.16, size * 0.09, p.bodyDark, 0.2);
  // Cou : une courbe en S dont l'inclinaison varie avec la graine.
  const headX = cx + size * 0.26 + ((seed % 3) - 1) * size * 0.02;
  const headY = groundY - size * 0.76;
  ctx.strokeStyle = p.body;
  ctx.lineWidth = size * 0.09;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bodyX + size * 0.16, bodyY - size * 0.04);
  ctx.bezierCurveTo(bodyX + size * 0.3, bodyY - size * 0.16, headX - size * 0.06, headY + size * 0.26, headX, headY);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ellipse(ctx, headX, headY, size * 0.09, size * 0.08, p.body);
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(headX + size * 0.07, headY - size * 0.03);
  ctx.lineTo(headX + size * 0.22, headY + size * 0.01);
  ctx.lineTo(headX + size * 0.07, headY + size * 0.05);
  ctx.closePath();
  ctx.fill();
  return { x: headX + size * 0.02, y: headY - size * 0.015, r: size * 0.035 };
}

/** Petit mammifère à oreilles : boule compacte, grandes oreilles, queue en pompon. */
function paintSmallFurry(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyY = groundY - size * 0.24;
  ellipse(ctx, cx - size * 0.3, bodyY - size * 0.04, size * 0.07, size * 0.07, lighten(p.body, 0.45));
  ellipse(ctx, cx - size * 0.02, bodyY, size * 0.3, size * 0.22, p.body);
  // Pattes arrière et avant, posées.
  ellipse(ctx, cx - size * 0.12, groundY - size * 0.04, size * 0.1, size * 0.045, p.bodyDark);
  ellipse(ctx, cx + size * 0.2, groundY - size * 0.04, size * 0.08, size * 0.04, p.bodyDark);
  const headX = cx + size * 0.18;
  const headY = groundY - size * 0.42;
  // Oreilles : longues, légèrement écartées ; l'écart dépend de la graine.
  const spread = 0.12 + (seed % 3) * 0.05;
  for (const direction of [-1, 1]) {
    const ex = headX + direction * size * 0.06;
    const rot = direction * spread;
    ellipse(ctx, ex, headY - size * 0.26, size * 0.055, size * 0.16, p.body, rot);
    ellipse(ctx, ex, headY - size * 0.25, size * 0.028, size * 0.11, p.accent, rot);
  }
  ellipse(ctx, headX, headY, size * 0.17, size * 0.15, p.body);
  ellipse(ctx, headX + size * 0.15, headY + size * 0.02, size * 0.035, size * 0.03, p.accentDark);
  return { x: headX + size * 0.05, y: headY - size * 0.03, r: size * 0.045 };
}

/** Laineux : corps en nuage de boucles, tête et pattes fines en accent. */
function paintWoolly(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.04;
  const bodyY = groundY - size * 0.38;
  legs(ctx, p.accent, groundY, [bodyX - size * 0.18, bodyX - size * 0.06, bodyX + size * 0.08, bodyX + size * 0.18], bodyY + size * 0.14, size * 0.045);
  // Boucles : une couronne de cercles, les plus bas plus sombres pour le volume.
  const curls: Array<[number, number, number]> = [
    [-0.24, 0.06, 0.13], [-0.1, 0.1, 0.14], [0.06, 0.1, 0.14], [0.2, 0.06, 0.12],
    [-0.2, -0.08, 0.13], [-0.04, -0.12, 0.15], [0.12, -0.1, 0.14], [0.24, -0.04, 0.11],
  ];
  for (const [dx, dy, r] of curls) {
    ellipse(ctx, bodyX + size * dx, bodyY + size * dy, size * r, size * r, dy > 0 ? p.bodyDark : p.body);
  }
  for (const [dx, dy, r] of curls) {
    if (dy > 0) continue;
    ellipse(ctx, bodyX + size * dx, bodyY + size * dy - size * 0.02, size * r * 0.85, size * r * 0.85, p.body);
  }
  // Cou court et tête en accent, oreilles tombantes.
  const headX = cx + size * 0.3;
  const headY = groundY - size * 0.46 - (seed % 2) * size * 0.03;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bodyX + size * 0.2, bodyY - size * 0.02);
  ctx.lineTo(headX - size * 0.04, headY + size * 0.02);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ellipse(ctx, headX - size * 0.1, headY - size * 0.04, size * 0.05, size * 0.03, p.accentDark, -0.6);
  ellipse(ctx, headX, headY, size * 0.12, size * 0.1, p.accent);
  ellipse(ctx, headX - size * 0.02, headY - size * 0.1, size * 0.09, size * 0.06, p.body);
  return { x: headX + size * 0.04, y: headY - size * 0.01, r: size * 0.04 };
}

/** Ongulé : boîte sur quatre pattes, tête carrée, museau et cornes en accent. */
function paintHoofed(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.34;
  const bodyY = groundY - size * 0.6;
  const bodyW = size * 0.6;
  const bodyH = size * 0.32;
  legs(ctx, p.bodyDark, groundY, [bodyX + size * 0.08, bodyX + size * 0.18, bodyX + size * 0.42, bodyX + size * 0.52], bodyY + bodyH - size * 0.04, size * 0.07);
  // Queue : un trait qui pend, terminé par une touffe.
  ctx.strokeStyle = p.bodyDark;
  ctx.lineWidth = size * 0.035;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bodyX + size * 0.02, bodyY + size * 0.06);
  ctx.quadraticCurveTo(bodyX - size * 0.06, bodyY + size * 0.16, bodyX - size * 0.04, bodyY + size * 0.3);
  ctx.stroke();
  ctx.lineCap = 'butt';
  fillRoundRect(ctx, bodyX, bodyY, bodyW, bodyH, size * 0.09, p.body);
  // Taches : une ou deux selon la graine — vache pie, chèvre unie de dos.
  for (let index = 0; index <= seed % 2; index += 1) {
    ellipse(ctx, bodyX + size * (0.16 + index * 0.24), bodyY + size * (0.08 + index * 0.1), size * 0.1, size * 0.07, p.bodyDark, 0.3 * index);
  }
  const headX = cx + size * 0.22;
  const headY = groundY - size * 0.74;
  fillRoundRect(ctx, headX - size * 0.06, headY + size * 0.08, size * 0.16, size * 0.16, size * 0.04, p.body);
  fillRoundRect(ctx, headX - size * 0.08, headY, size * 0.24, size * 0.2, size * 0.06, p.body);
  fillRoundRect(ctx, headX + size * 0.04, headY + size * 0.1, size * 0.14, size * 0.1, size * 0.04, p.accent);
  ellipse(ctx, headX + size * 0.13, headY + size * 0.15, size * 0.015, size * 0.015, p.accentDark);
  // Cornes et oreilles
  ctx.strokeStyle = p.accentDark;
  ctx.lineWidth = size * 0.03;
  ctx.lineCap = 'round';
  for (const direction of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(headX + direction * size * 0.04, headY);
    ctx.quadraticCurveTo(headX + direction * size * 0.07, headY - size * 0.1, headX + direction * size * 0.12, headY - size * 0.12);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ellipse(ctx, headX - size * 0.09, headY + size * 0.03, size * 0.05, size * 0.03, p.bodyDark, -0.5);
  return { x: headX + size * 0.05, y: headY + size * 0.06, r: size * 0.035 };
}

/** Porcin : tonneau, tête ronde, groin en accent, oreilles tombantes, queue en tire-bouchon. */
function paintSwine(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.06;
  const bodyY = groundY - size * 0.3;
  legs(ctx, p.bodyDark, groundY, [bodyX - size * 0.2, bodyX - size * 0.08, bodyX + size * 0.1, bodyX + size * 0.2], bodyY + size * 0.12, size * 0.06);
  // Queue en tire-bouchon
  ctx.strokeStyle = p.bodyDark;
  ctx.lineWidth = size * 0.03;
  ctx.beginPath();
  ctx.arc(bodyX - size * 0.34, bodyY - size * 0.06, size * 0.04, Math.PI * 0.5, Math.PI * 2.2);
  ctx.stroke();
  ellipse(ctx, bodyX, bodyY, size * 0.32, size * 0.22, p.body);
  const headX = cx + size * 0.24;
  const headY = groundY - size * 0.38;
  // Oreilles tombantes, l'inclinaison dépend de la graine.
  const droop = 0.3 + (seed % 3) * 0.12;
  ellipse(ctx, headX - size * 0.06, headY - size * 0.14, size * 0.05, size * 0.09, p.bodyDark, -droop);
  ellipse(ctx, headX + size * 0.06, headY - size * 0.14, size * 0.05, size * 0.09, p.bodyDark, droop);
  ellipse(ctx, headX, headY, size * 0.17, size * 0.16, p.body);
  ellipse(ctx, headX + size * 0.13, headY + size * 0.03, size * 0.09, size * 0.07, p.accent);
  ellipse(ctx, headX + size * 0.1, headY + size * 0.03, size * 0.018, size * 0.022, p.accentDark);
  ellipse(ctx, headX + size * 0.16, headY + size * 0.03, size * 0.018, size * 0.022, p.accentDark);
  return { x: headX + size * 0.02, y: headY - size * 0.05, r: size * 0.04 };
}

/** Insecte : abdomen rayé, ailes translucides en accent, antennes. Il vole. */
function paintInsect(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const cy = groundY - size * 0.46 - (seed % 2) * size * 0.03;
  const bodyX = cx - size * 0.06;
  // Ailes : deux ellipses claires légèrement transparentes, avec leur bord.
  ctx.globalAlpha = 0.8;
  ellipse(ctx, bodyX - size * 0.02, cy - size * 0.2, size * 0.18, size * 0.08, p.accent, -0.55);
  ellipse(ctx, bodyX + size * 0.1, cy - size * 0.19, size * 0.15, size * 0.07, p.accent, -0.25);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = p.accentDark;
  ctx.lineWidth = Math.max(1, size * 0.015);
  ctx.beginPath();
  ctx.ellipse(bodyX - size * 0.02, cy - size * 0.2, size * 0.18, size * 0.08, -0.55, 0, Math.PI * 2);
  ctx.stroke();
  // Pattes : trois traits sous le corps.
  ctx.strokeStyle = p.bodyDark;
  ctx.lineWidth = Math.max(1, size * 0.02);
  for (const dx of [-0.1, 0, 0.1]) {
    ctx.beginPath();
    ctx.moveTo(bodyX + size * dx, cy + size * 0.08);
    ctx.lineTo(bodyX + size * dx - size * 0.03, cy + size * 0.18);
    ctx.stroke();
  }
  // Dard
  ctx.fillStyle = p.bodyDark;
  ctx.beginPath();
  ctx.moveTo(bodyX - size * 0.2, cy - size * 0.03);
  ctx.lineTo(bodyX - size * 0.3, cy + size * 0.02);
  ctx.lineTo(bodyX - size * 0.2, cy + size * 0.06);
  ctx.closePath();
  ctx.fill();
  ellipse(ctx, bodyX, cy, size * 0.22, size * 0.13, p.body);
  // Rayures : clip sur l'abdomen pour ne pas déborder.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(bodyX, cy, size * 0.22, size * 0.13, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = p.bodyDark;
  for (const dx of [-0.13, -0.02, 0.09]) {
    ctx.fillRect(bodyX + size * dx - size * 0.025, cy - size * 0.14, size * 0.05, size * 0.28);
  }
  ctx.restore();
  const headX = cx + size * 0.2;
  ellipse(ctx, headX, cy, size * 0.1, size * 0.1, p.bodyDark);
  ctx.strokeStyle = p.accentDark;
  ctx.lineWidth = Math.max(1, size * 0.02);
  ctx.lineCap = 'round';
  for (const direction of [-0.5, 0.2]) {
    ctx.beginPath();
    ctx.moveTo(headX + size * 0.02, cy - size * 0.08);
    ctx.quadraticCurveTo(headX + size * 0.08, cy - size * 0.2, headX + size * (0.12 + direction * 0.1), cy - size * 0.24);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  return { x: headX + size * 0.03, y: cy - size * 0.02, r: size * 0.035 };
}

/** Carapace : dôme en accent orné d'écailles, tête et pattes courtes qui dépassent. */
function paintShelled(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const shellX = cx - size * 0.04;
  const shellBase = groundY - size * 0.1;
  ellipse(ctx, shellX - size * 0.24, groundY - size * 0.06, size * 0.08, size * 0.06, p.bodyDark);
  ellipse(ctx, shellX + size * 0.2, groundY - size * 0.06, size * 0.08, size * 0.06, p.bodyDark);
  // Queue
  ctx.fillStyle = p.body;
  ctx.beginPath();
  ctx.moveTo(shellX - size * 0.28, shellBase - size * 0.04);
  ctx.lineTo(shellX - size * 0.38, shellBase);
  ctx.lineTo(shellX - size * 0.26, shellBase + size * 0.02);
  ctx.closePath();
  ctx.fill();
  const headX = cx + size * 0.3;
  const headY = groundY - size * 0.2;
  ellipse(ctx, headX - size * 0.1, headY + size * 0.03, size * 0.1, size * 0.06, p.body);
  ellipse(ctx, headX, headY, size * 0.1, size * 0.08, p.body);
  // Dôme
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.ellipse(shellX, shellBase, size * 0.3, size * 0.32, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  fillRoundRect(ctx, shellX - size * 0.32, shellBase - size * 0.04, size * 0.64, size * 0.08, size * 0.03, p.bodyDark);
  // Écailles : quelques disques, disposés selon la graine.
  ctx.fillStyle = p.accentDark;
  const spots: Array<[number, number, number]> = [[0, -0.18, 0.07], [-0.14, -0.1, 0.055], [0.14, -0.1, 0.055], [-0.05, -0.05, 0.04], [0.07, -0.04, 0.04]];
  for (const [index, [dx, dy, r]] of spots.entries()) {
    if ((seed + index) % 5 === 4) continue;
    ctx.beginPath();
    ctx.arc(shellX + size * dx, shellBase + size * dy, size * r, 0, Math.PI * 2);
    ctx.fill();
  }
  return { x: headX + size * 0.03, y: headY - size * 0.02, r: size * 0.035 };
}

/** Ailé : corps, cou, ailes déployées en accent, longue queue à pointe. */
function paintWinged(ctx: SKRSContext2D, cx: number, groundY: number, size: number, p: AnimalPalette, seed: number): EyeSpot {
  const bodyX = cx - size * 0.02;
  const bodyY = groundY - size * 0.3;
  legs(ctx, p.bodyDark, groundY, [bodyX - size * 0.1, bodyX + size * 0.1], bodyY + size * 0.1, size * 0.06);
  // Queue : une courbe vers l'arrière, terminée par une pointe en accent.
  ctx.strokeStyle = p.body;
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bodyX - size * 0.2, bodyY);
  ctx.quadraticCurveTo(bodyX - size * 0.42, bodyY + size * 0.06, bodyX - size * 0.4, bodyY - size * 0.22);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(bodyX - size * 0.4, bodyY - size * 0.32);
  ctx.lineTo(bodyX - size * 0.48, bodyY - size * 0.18);
  ctx.lineTo(bodyX - size * 0.32, bodyY - size * 0.18);
  ctx.closePath();
  ctx.fill();
  // Ailes : l'arrière plus sombre, l'avant en accent, l'envergure varie avec la graine.
  const span = 0.3 + (seed % 3) * 0.04;
  const wing = (baseX: number, color: string, scale: number): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(baseX, bodyY - size * 0.08);
    ctx.lineTo(baseX - size * span * scale, bodyY - size * 0.62 * scale);
    ctx.lineTo(baseX - size * 0.05 * scale, bodyY - size * 0.4 * scale);
    ctx.lineTo(baseX + size * 0.18 * scale, bodyY - size * 0.5 * scale);
    ctx.lineTo(baseX + size * 0.1, bodyY - size * 0.1);
    ctx.closePath();
    ctx.fill();
  };
  wing(bodyX - size * 0.06, p.accentDark, 0.85);
  ellipse(ctx, bodyX, bodyY, size * 0.27, size * 0.17, p.body);
  ellipse(ctx, bodyX + size * 0.02, bodyY + size * 0.06, size * 0.17, size * 0.08, lighten(p.body, 0.35));
  wing(bodyX + size * 0.02, p.accent, 1);
  // Cou et tête, avec une petite corne.
  const headX = cx + size * 0.28;
  const headY = groundY - size * 0.62;
  ctx.strokeStyle = p.body;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bodyX + size * 0.18, bodyY - size * 0.06);
  ctx.quadraticCurveTo(bodyX + size * 0.26, bodyY - size * 0.22, headX - size * 0.04, headY + size * 0.04);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ellipse(ctx, headX, headY, size * 0.12, size * 0.1, p.body);
  ellipse(ctx, headX + size * 0.1, headY + size * 0.03, size * 0.06, size * 0.045, p.body);
  ctx.fillStyle = p.accentDark;
  ctx.beginPath();
  ctx.moveTo(headX - size * 0.04, headY - size * 0.08);
  ctx.lineTo(headX - size * 0.08, headY - size * 0.2);
  ctx.lineTo(headX + size * 0.02, headY - size * 0.09);
  ctx.closePath();
  ctx.fill();
  return { x: headX + size * 0.03, y: headY - size * 0.02, r: size * 0.04 };
}

const ANIMAL_PAINTERS: Record<AnimalForm, FormPainter> = {
  fowl: paintFowl,
  longneck: paintLongneck,
  smallfurry: paintSmallFurry,
  woolly: paintWoolly,
  hoofed: paintHoofed,
  swine: paintSwine,
  insect: paintInsect,
  shelled: paintShelled,
  winged: paintWinged,
};

/**
 * Silhouette d'animal générique (corps + tête + pattes) : le REPLI d'une espèce
 * sans `form` dans `animals.json`. Toutes en déclarent une aujourd'hui ; on la
 * garde pour qu'une espèce ajoutée à la va-vite s'affiche quand même.
 */
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
 * Couleur dérivée d'une clé quelconque.
 *
 * Ce n'est PLUS la source d'apparence des cultures — elles déclarent leur
 * palette dans `crops.json`, voir `cropSkin()` — mais elle reste le bon outil
 * pour un objet sans identité configurée : `drawItemIcon()` doit produire une
 * couleur stable pour n'importe quelle clé, sans table à maintenir.
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

/** Interpolation linéaire entre deux couleurs hexadécimales. */
export function mixHex(from: string, to: string, ratio: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const clamped = Math.min(1, Math.max(0, ratio));
  return `rgb(${Math.round(a.r + (b.r - a.r) * clamped)},${Math.round(
    a.g + (b.g - a.g) * clamped,
  )},${Math.round(a.b + (b.b - a.b) * clamped)})`;
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

/** Teinte de repli par compagnon (voir `game/pets.ts`) ; `#cccccc` pour une clé inconnue. */
const PET_COLORS: Record<string, string> = {
  chick: '#f4d35e',
  kitten: '#e8a33d',
  puppy: '#b5804a',
  piglet: '#f4b6c2',
  bunny: '#f2efe9',
  fox: '#e0672c',
  owl: '#8a6d4b',
  dragon: '#4caf6a',
};

/**
 * Icône ronde d'un compagnon de ferme équipé, affichée près de l'avatar sur
 * `/farm`. Silhouette générique (même famille que `drawAnimal`) teintée par
 * espèce plutôt que dessinée au trait : un vrai sprite PNG par compagnon
 * resterait le repère visuel le plus lisible, ceci n'est que le repli
 * vectoriel (voir `docs/05-pipeline-assets.md`).
 */
export function drawPetIcon(ctx: SKRSContext2D, x: number, y: number, radius: number, petKey: string): void {
  const base = PET_COLORS[petKey] ?? '#cccccc';
  const shine = ctx.createRadialGradient(
    x - radius * 0.3,
    y - radius * 0.35,
    radius * 0.05,
    x,
    y,
    radius * 1.1,
  );
  shine.addColorStop(0, lighten(base, 0.35));
  shine.addColorStop(1, base);

  // Deux oreilles avant le corps, pour que le contour de tête se lise même à
  // très petite taille.
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(x - radius * 0.5, y - radius * 0.65, radius * 0.24, 0, Math.PI * 2);
  ctx.arc(x + radius * 0.5, y - radius * 0.65, radius * 0.24, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, radius / 10);
  ctx.stroke();

  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath();
  ctx.arc(x - radius * 0.22, y - radius * 0.05, radius * 0.09, 0, Math.PI * 2);
  ctx.arc(x + radius * 0.22, y - radius * 0.05, radius * 0.09, 0, Math.PI * 2);
  ctx.fill();
}
