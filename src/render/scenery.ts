import type { SKRSContext2D } from '@napi-rs/canvas';
import { lighten, verticalGradient } from './canvas';

/**
 * Décor commun aux scènes d'extérieur : ciel, herbe, voile météo, bâtiments.
 *
 * Né de `farm.ts`, où tout cela vivait en privé. La basse-cour de `/animals`
 * se joue sous le même ciel que le champ : un joueur qui passe de l'une à
 * l'autre doit reconnaître la même journée — même dégradé de saison, même
 * pluie, mêmes nuages. Copier ces fonctions aurait figé deux versions qui
 * auraient fini par diverger ; les partager garantit qu'un réglage de palette
 * profite aux deux images d'un coup.
 *
 * Tout est DÉTERMINISTE : les positions « aléatoires » viennent d'une graine,
 * jamais de `Math.random()`, parce que le cache d'images suppose qu'un même
 * état produit un même PNG.
 */

export interface SceneryPalette {
  skyTop: string;
  skyBottom: string;
  grass: string;
  grassDark: string;
}

/**
 * Palette de SAISON : la couche de base du décor.
 *
 * À distinguer de `THEME_PALETTES` (canvas.ts), qui est un choix cosmétique du
 * joueur. La saison vient du monde, le thème vient de la boutique ; quand le
 * joueur a posé un thème, il l'emporte.
 */
export const SEASON_PALETTES: Record<string, SceneryPalette> = {
  spring: { skyTop: '#8fd3f4', skyBottom: '#d8f0d2', grass: '#7ec850', grassDark: '#5da13c' },
  summer: { skyTop: '#5cb8e8', skyBottom: '#bfe9c6', grass: '#6fb844', grassDark: '#4e8f33' },
  autumn: { skyTop: '#e8a95c', skyBottom: '#f6d9a8', grass: '#b08b3e', grassDark: '#8a6b2c' },
  winter: { skyTop: '#b9d8ee', skyBottom: '#eef6fb', grass: '#c8d8d2', grassDark: '#a4b8b2' },
};

/** Palette d'une saison, avec l'été en repli pour une saison inconnue du catalogue. */
export function seasonPalette(season: string): SceneryPalette {
  return SEASON_PALETTES[season] ?? SEASON_PALETTES.summer!;
}

/** Générateur déterministe : même graine, même décor, à chaque rendu. */
export function seededRandom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Hachage FNV-1a d'un texte (identifiant de ferme, d'animal) vers une graine entière. */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 0x7fffffff;
}

// ---------------------------------------------------------------------------
// CIEL, HERBE, MÉTÉO
// ---------------------------------------------------------------------------

export function drawSky(
  ctx: SKRSContext2D,
  width: number,
  horizon: number,
  palette: { skyTop: string; skyBottom: string },
  weather: string,
): void {
  ctx.fillStyle = verticalGradient(ctx, 0, 0, horizon + 40, palette.skyTop, palette.skyBottom);
  ctx.fillRect(0, 0, width, horizon + 40);

  if (weather === 'sunny' || weather === 'clear' || weather === 'heatwave') {
    const glow = ctx.createRadialGradient(width * 0.8, 26, 4, width * 0.8, 26, 130);
    glow.addColorStop(0, 'rgba(255,246,200,0.8)');
    glow.addColorStop(1, 'rgba(255,246,200,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(width * 0.8 - 130, -104, 260, 230);
  }

  const overcast = weather === 'rainy' || weather === 'storm' || weather === 'snow';
  const clouds = overcast ? 5 : 3;
  for (let index = 0; index < clouds; index += 1) {
    const cx = (((index * 173) % 100) / 100) * width;
    const cy = 24 + ((index * 61) % 40);
    const scale = 0.7 + ((index * 37) % 40) / 100;
    ctx.fillStyle = overcast ? 'rgba(120,132,148,0.55)' : 'rgba(255,255,255,0.6)';
    for (const [dx, dy, r] of [[-30, 4, 22], [0, -6, 30], [28, 6, 20]] as const) {
      ctx.beginPath();
      ctx.ellipse(cx + dx * scale, cy + dy * scale, r * scale, r * scale * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawGrass(
  ctx: SKRSContext2D,
  width: number,
  horizon: number,
  height: number,
  palette: { grass: string; grassDark: string },
): void {
  ctx.fillStyle = palette.grassDark;
  ctx.fillRect(0, horizon - 10, width, height - horizon + 10);
  // Dégradé plutôt qu'aplat : l'herbe s'éclaircit vers l'horizon, ce qui donne
  // de la profondeur au champ sans rien dessiner de plus.
  ctx.fillStyle = verticalGradient(ctx, 0, horizon, height, lighten(palette.grass, 0.12), palette.grass);
  ctx.fillRect(0, horizon, width, height - horizon);

  // Touffes : un aplat vert de 800 px de large se voit comme un aplat.
  const random = seededRandom(987654321);
  const band = Math.max(1, height - horizon);
  for (let index = 0; index < 420; index += 1) {
    const gx = random() * width;
    const gy = horizon + random() * band;
    ctx.strokeStyle = random() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + 1.5, gy - 4);
    ctx.stroke();
  }
}

/**
 * Voile météo : pluie, neige ou chaleur par-dessus la scène. À appeler AVANT
 * les panneaux de texte, sinon les libellés sortent striés de pluie.
 */
export function drawWeatherOverlay(ctx: SKRSContext2D, width: number, height: number, weather: string): void {
  if (weather === 'rainy' || weather === 'storm') {
    const random = seededRandom(24680);
    ctx.strokeStyle = weather === 'storm' ? 'rgba(190,215,240,0.55)' : 'rgba(200,225,245,0.42)';
    ctx.lineWidth = 1.4;
    for (let index = 0; index < (weather === 'storm' ? 340 : 220); index += 1) {
      const rx = random() * width;
      const ry = random() * height;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 3, ry + 11);
      ctx.stroke();
    }
    ctx.fillStyle = weather === 'storm' ? 'rgba(40,52,78,0.20)' : 'rgba(60,80,110,0.12)';
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (weather === 'snow') {
    const random = seededRandom(13579);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let index = 0; index < 190; index += 1) {
      const sx = random() * width;
      const sy = random() * height;
      ctx.beginPath();
      ctx.arc(sx, sy, 1 + random() * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(210,230,255,0.14)';
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (weather === 'heatwave') {
    // Voile chaud : la canicule doit se voir, elle coûte des récoltes.
    ctx.fillStyle = 'rgba(255,170,60,0.13)';
    ctx.fillRect(0, 0, width, height);
  }
}

// ---------------------------------------------------------------------------
// BÂTIMENTS — ce que le joueur a construit, enfin visible
// ---------------------------------------------------------------------------

/** Petit bâtiment vectoriel, identifié par sa clé de `buildings.json` ; remise générique sinon. */
export function drawBuilding(ctx: SKRSContext2D, key: string, x: number, y: number, size: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size * 0.97, size * 0.34, size * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();

  switch (key) {
    case 'house':
      return drawHouse(ctx, x, y, size, '#d9e2ea', '#c0563f');
    case 'barn':
    case 'pen':
      return drawBarn(ctx, x, y, size);
    case 'coop':
      return drawHouse(ctx, x, y, size * 0.78, '#e8d8b7', '#8a6a45');
    case 'apiary':
      return drawHive(ctx, x, y, size);
    case 'mythic_pen':
      return drawLair(ctx, x, y, size);
    case 'well':
      return drawWell(ctx, x, y, size);
    case 'greenhouse':
      return drawGreenhouse(ctx, x, y, size);
    case 'mill':
      return drawMill(ctx, x, y, size);
    default:
      return drawShed(ctx, x, y, size);
  }
}

function drawHouse(ctx: SKRSContext2D, x: number, y: number, size: number, wall: string, roof: string): void {
  const bodyY = y + size * 0.42;
  ctx.fillStyle = wall;
  ctx.fillRect(x + size * 0.14, bodyY, size * 0.72, size * 0.55);
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x + size * 0.06, bodyY);
  ctx.lineTo(x + size / 2, y + size * 0.08);
  ctx.lineTo(x + size * 0.94, bodyY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b5033';
  ctx.fillRect(x + size * 0.42, bodyY + size * 0.22, size * 0.18, size * 0.33);
  ctx.fillStyle = '#ffd45e';
  ctx.fillRect(x + size * 0.2, bodyY + size * 0.12, size * 0.14, size * 0.14);
}

function drawBarn(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  const bodyY = y + size * 0.4;
  ctx.fillStyle = '#b0453a';
  ctx.fillRect(x + size * 0.12, bodyY, size * 0.76, size * 0.57);
  // Toit en croupe : la silhouette qui dit « étable » sans légende.
  ctx.fillStyle = '#8c332a';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.06, bodyY);
  ctx.lineTo(x + size * 0.3, y + size * 0.1);
  ctx.lineTo(x + size * 0.7, y + size * 0.1);
  ctx.lineTo(x + size * 0.94, bodyY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f2e6d8';
  ctx.fillRect(x + size * 0.42, bodyY + size * 0.16, size * 0.16, size * 0.41);
  ctx.fillRect(x + size * 0.14, bodyY + size * 0.26, size * 0.72, size * 0.05);
}

/** Ruche en paille : dôme strié sur un socle, l'image d'Épinal du rucher. */
function drawHive(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = '#7a5c3c';
  ctx.fillRect(x + size * 0.2, y + size * 0.86, size * 0.6, size * 0.1);
  const cx = x + size / 2;
  const rows: Array<[number, number]> = [[0.8, 0.34], [0.64, 0.3], [0.48, 0.24], [0.34, 0.16]];
  for (const [cy, radius] of rows) {
    ctx.fillStyle = '#e0b85a';
    ctx.beginPath();
    ctx.ellipse(cx, y + size * cy, size * radius, size * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.ellipse(cx, y + size * (cy + 0.05), size * radius, size * 0.04, 0, 0, Math.PI);
    ctx.fill();
  }
  ctx.fillStyle = '#3a2f0b';
  ctx.beginPath();
  ctx.ellipse(cx, y + size * 0.74, size * 0.07, size * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Antre mythique : une grotte sombre aux reflets violets, avec un halo à l'entrée. */
function drawLair(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = '#4a3b5c';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.06, y + size * 0.96);
  ctx.quadraticCurveTo(x + size * 0.1, y + size * 0.2, x + size * 0.5, y + size * 0.1);
  ctx.quadraticCurveTo(x + size * 0.9, y + size * 0.2, x + size * 0.94, y + size * 0.96);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6a5580';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.2, y + size * 0.96);
  ctx.quadraticCurveTo(x + size * 0.3, y + size * 0.3, x + size * 0.5, y + size * 0.26);
  ctx.quadraticCurveTo(x + size * 0.56, y + size * 0.3, x + size * 0.6, y + size * 0.96);
  ctx.closePath();
  ctx.fill();
  const glow = ctx.createRadialGradient(x + size / 2, y + size * 0.8, 2, x + size / 2, y + size * 0.8, size * 0.26);
  glow.addColorStop(0, 'rgba(255,140,60,0.85)');
  glow.addColorStop(1, 'rgba(255,140,60,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size * 0.8, size * 0.26, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1c1426';
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size * 0.86, size * 0.16, size * 0.22, 0, Math.PI, 0);
  ctx.fill();
}

function drawWell(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = '#8d949c';
  ctx.fillRect(x + size * 0.26, y + size * 0.56, size * 0.48, size * 0.4);
  ctx.fillStyle = '#5c6268';
  ctx.fillRect(x + size * 0.26, y + size * 0.56, size * 0.48, size * 0.08);
  ctx.fillStyle = '#7a5c3c';
  ctx.fillRect(x + size * 0.3, y + size * 0.24, size * 0.06, size * 0.36);
  ctx.fillRect(x + size * 0.64, y + size * 0.24, size * 0.06, size * 0.36);
  ctx.fillStyle = '#a5825a';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.18, y + size * 0.28);
  ctx.lineTo(x + size / 2, y + size * 0.08);
  ctx.lineTo(x + size * 0.82, y + size * 0.28);
  ctx.closePath();
  ctx.fill();
}

function drawGreenhouse(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = 'rgba(190,235,225,0.85)';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.12, y + size * 0.96);
  ctx.lineTo(x + size * 0.12, y + size * 0.44);
  ctx.quadraticCurveTo(x + size / 2, y + size * 0.02, x + size * 0.88, y + size * 0.44);
  ctx.lineTo(x + size * 0.88, y + size * 0.96);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7fa89c';
  ctx.lineWidth = Math.max(1.5, size / 32);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + size * 0.1);
  ctx.lineTo(x + size / 2, y + size * 0.96);
  ctx.moveTo(x + size * 0.12, y + size * 0.68);
  ctx.lineTo(x + size * 0.88, y + size * 0.68);
  ctx.stroke();
}

function drawMill(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = '#d9d2c4';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.3, y + size * 0.96);
  ctx.lineTo(x + size * 0.38, y + size * 0.34);
  ctx.lineTo(x + size * 0.62, y + size * 0.34);
  ctx.lineTo(x + size * 0.7, y + size * 0.96);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b5033';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.32, y + size * 0.34);
  ctx.lineTo(x + size / 2, y + size * 0.14);
  ctx.lineTo(x + size * 0.68, y + size * 0.34);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#8a6a45';
  ctx.lineWidth = Math.max(2, size / 20);
  const cx = x + size / 2;
  const cy = y + size * 0.3;
  for (const angle of [0.5, 2.07, 3.64, 5.21]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * size * 0.3, cy + Math.sin(angle) * size * 0.3);
    ctx.stroke();
  }
}

function drawShed(ctx: SKRSContext2D, x: number, y: number, size: number): void {
  ctx.fillStyle = '#c8b393';
  ctx.fillRect(x + size * 0.16, y + size * 0.46, size * 0.68, size * 0.5);
  ctx.fillStyle = '#8a6a45';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.1, y + size * 0.5);
  ctx.lineTo(x + size * 0.26, y + size * 0.22);
  ctx.lineTo(x + size * 0.9, y + size * 0.22);
  ctx.lineTo(x + size * 0.74, y + size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + size * 0.36, y + size * 0.62, size * 0.28, size * 0.34);
}
