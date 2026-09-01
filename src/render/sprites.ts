import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import type { CropForm, CropPalette } from '../config/gameplay/schemas';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';
import { PALETTE, fillRoundRect, lighten } from './canvas';

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
