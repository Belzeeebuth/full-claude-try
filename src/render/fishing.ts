import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { clampAltText } from './alt-text';
import { PALETTE, encode, fillRoundRect, font, lighten, newCanvas, verticalGradient } from './canvas';
import { seedFrom, seededRandom } from './scenery';
import { drawWeatherIcon, mixHex } from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Scène d'étang, volontairement statique : elle ne change qu'avec la météo et
 * la saison, jamais avec l'état du ferrage (ça, c'est le texte de l'embed qui
 * le porte). Résultat : un très petit espace d'états possibles, donc un taux de
 * cache Redis proche de 100 % — la même image sert à tous les joueurs qui
 * pêchent le même jour sous le même ciel.
 *
 * La scène est construite en PLANS, du plus lointain au plus proche : collines
 * fondues dans le ciel, rive, eau et ses reflets, ponton, puis roseaux au
 * premier plan. C'est cet empilement qui donne la profondeur, sans une seule
 * texture. Tout ce qui est « au hasard » est semé sur la saison et la météo,
 * pour que l'image soit la même à chaque rendu — le cache y compte.
 */

const SEASON_WATER: Record<
  string,
  { skyTop: string; skyBottom: string; water: string; waterDeep: string; hill: string; shore: string; reed: string }
> = {
  spring: { skyTop: '#8fd3f4', skyBottom: '#c9f0d2', water: '#4aa3df', waterDeep: '#2f6f9e', hill: '#6fae6a', shore: '#5da13c', reed: '#3f7a3a' },
  summer: { skyTop: '#6fc6f0', skyBottom: '#bfe8c9', water: '#2f97c9', waterDeep: '#1d5f80', hill: '#5f9f5b', shore: '#4e9634', reed: '#356b31' },
  autumn: { skyTop: '#f6b26b', skyBottom: '#ffe0b2', water: '#3f7fa0', waterDeep: '#284f63', hill: '#b48a4e', shore: '#a37b3a', reed: '#7d5a2a' },
  winter: { skyTop: '#cfe8ff', skyBottom: '#f4faff', water: '#6fa8c9', waterDeep: '#3d637a', hill: '#c2d2dc', shore: '#b9c9c2', reed: '#7f8f86' },
};

export interface FishingRenderInput {
  locale: string;
  season: string;
  weather: string;
}

export async function renderFishing(input: FishingRenderInput): Promise<Buffer> {
  const dims = getBalance().render.fishing;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const palette = SEASON_WATER[input.season] ?? SEASON_WATER.spring!;
  const random = seededRandom(seedFrom(`${input.season}:${input.weather}`));
  const overcast = input.weather === 'rainy' || input.weather === 'storm' || input.weather === 'snow';
  const sunny = input.weather === 'sunny' || input.weather === 'clear' || input.weather === 'heatwave';

  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const shoreHeight = Math.round(dims.height * 0.24);
  const waterY = shoreHeight + 8;

  // --- Ciel ---------------------------------------------------------------
  ctx.fillStyle = verticalGradient(ctx, 0, 0, shoreHeight, palette.skyTop, palette.skyBottom);
  ctx.fillRect(0, 0, dims.width, shoreHeight);
  if (sunny) {
    const glow = ctx.createRadialGradient(dims.width * 0.78, 30, 4, dims.width * 0.78, 30, 110);
    glow.addColorStop(0, 'rgba(255,246,200,0.85)');
    glow.addColorStop(1, 'rgba(255,246,200,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(dims.width * 0.78 - 110, -80, 220, 200);
  }

  // --- Collines lointaines : deux plans, le plus loin fondu dans le ciel ----
  const farHill = mixHex(palette.hill, palette.skyBottom, 0.55);
  const nearHill = mixHex(palette.hill, palette.skyBottom, 0.25);
  // Les profils sont tirés UNE fois : le reflet doit être l'image exacte des
  // collines proches, pas un second tirage.
  const farProfile = hillProfile(5, random);
  const nearProfile = hillProfile(7, random);
  drawHills(ctx, dims.width, shoreHeight - 4, shoreHeight * 0.55, farHill, farProfile);
  drawHills(ctx, dims.width, shoreHeight + 2, shoreHeight * 0.3, nearHill, nearProfile);

  // --- Rive ----------------------------------------------------------------
  ctx.fillStyle = palette.shore;
  ctx.fillRect(0, shoreHeight - 10, dims.width, 18);
  ctx.fillStyle = lighten(palette.shore, 0.18);
  ctx.fillRect(0, shoreHeight - 10, dims.width, 3);
  // Touffes sur la rive : la ligne d'herbe cessait d'être un ruban plat.
  ctx.strokeStyle = palette.reed;
  ctx.lineWidth = 1.6;
  for (let index = 0; index < 90; index += 1) {
    const gx = random() * dims.width;
    const gy = shoreHeight - 8 + random() * 10;
    ctx.beginPath();
    ctx.moveTo(gx, gy + 4);
    ctx.lineTo(gx + (random() - 0.5) * 4, gy - 4 - random() * 4);
    ctx.stroke();
  }

  // --- Étang -----------------------------------------------------------------
  ctx.fillStyle = verticalGradient(ctx, 0, waterY, dims.height - waterY, palette.water, palette.waterDeep);
  ctx.fillRect(0, waterY, dims.width, dims.height - waterY);

  // Reflet des collines proches, renversé sous la ligne d'eau et très atténué :
  // c'est lui qui fait lire « eau » plutôt que « aplat bleu ».
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, waterY, dims.width, dims.height - waterY);
  ctx.clip();
  ctx.globalAlpha = 0.18;
  ctx.translate(0, (shoreHeight + 2) * 2 + 12);
  ctx.scale(1, -1);
  drawHills(ctx, dims.width, shoreHeight + 2, shoreHeight * 0.3, mixHex(nearHill, '#000000', 0.4), nearProfile);
  ctx.restore();

  // Reflet du ciel : traînées claires horizontales, denses près de la rive,
  // rares au premier plan — l'eau lointaine reflète le ciel, la proche montre
  // le fond.
  for (let index = 0; index < 140; index += 1) {
    const depth = random() ** 2;
    const ry = waterY + 6 + depth * (dims.height - waterY - 40);
    const rx = random() * dims.width;
    const length = 10 + random() * 40 * (1 - depth * 0.6);
    ctx.strokeStyle = `rgba(255,255,255,${(0.08 + (1 - depth) * 0.16).toFixed(2)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + length, ry);
    ctx.stroke();
  }
  // Chemin de lumière du soleil : colonne de reflets sous lui, par temps clair.
  if (sunny) {
    const sunX = dims.width * 0.78;
    for (let index = 0; index < 40; index += 1) {
      const ry = waterY + 4 + random() * 150;
      const spread = 20 + (ry - waterY) * 0.5;
      const rx = sunX + (random() - 0.5) * spread;
      const length = 6 + random() * 22;
      ctx.strokeStyle = `rgba(255,246,200,${(0.25 + random() * 0.4).toFixed(2)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(rx - length / 2, ry);
      ctx.lineTo(rx + length / 2, ry);
      ctx.stroke();
    }
  }

  // Ondulations discrètes, pour ne pas laisser un aplat mort.
  ctx.strokeStyle = overcast ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  for (let row = 0; row < 5; row += 1) {
    const y = waterY + 34 + row * 40 + (row % 2 === 0 ? 0 : 18);
    ctx.beginPath();
    for (let x = -20; x <= dims.width + 20; x += 40) {
      const yy = y + Math.sin(x / 60 + row) * 6;
      if (x === -20) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  // Nénuphars.
  const lilyAt = (x: number, y: number, size: number): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath();
    ctx.ellipse(x + 2, y + 3, size, size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3f8f4f';
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8d8f5';
    ctx.beginPath();
    ctx.arc(x, y - size * 0.1, size * 0.22, 0, Math.PI * 2);
    ctx.fill();
  };
  lilyAt(dims.width * 0.16, waterY + 60, 22);
  lilyAt(dims.width * 0.82, waterY + 110, 16);
  lilyAt(dims.width * 0.68, waterY + 40, 12);

  // Petit ponton de bois, ancré sur la rive gauche, et son reflet.
  const dockX = dims.width * 0.06;
  const dockWidth = dims.width * 0.16;
  ctx.fillStyle = 'rgba(30,40,60,0.28)';
  ctx.fillRect(dockX, shoreHeight + 10, dockWidth, 34);
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(dockX, shoreHeight - 6, dockWidth, 14);
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(dockX, shoreHeight - 6, dockWidth, 2);
  for (let leg = 0; leg < 3; leg += 1) {
    ctx.fillStyle = '#5e3d22';
    ctx.fillRect(dockX + leg * (dockWidth / 2.4), shoreHeight + 6, 8, 30);
  }
  // Canne à pêche posée au bout du ponton.
  ctx.strokeStyle = '#4a3320';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(dockX + dockWidth - 10, shoreHeight - 2);
  ctx.lineTo(dockX + dockWidth + 46, shoreHeight - 46);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(dockX + dockWidth + 46, shoreHeight - 46);
  ctx.lineTo(dockX + dockWidth + 30, waterY + 20);
  ctx.stroke();
  // Flotteur et ses cercles sur l'eau.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.2;
  for (const radius of [9, 16]) {
    ctx.beginPath();
    ctx.ellipse(dockX + dockWidth + 30, waterY + 22, radius, radius * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = PALETTE.danger;
  ctx.beginPath();
  ctx.arc(dockX + dockWidth + 30, waterY + 20, 5, 0, Math.PI * 2);
  ctx.fill();

  // --- Premier plan : roseaux, plus grands et plus sombres que la rive ------
  drawReeds(ctx, dims.width * 0.86, dims.height, 7, palette.reed, random);
  drawReeds(ctx, dims.width * 0.02, dims.height, 4, palette.reed, random);

  // --- Voile météo ----------------------------------------------------------
  if (overcast) {
    ctx.fillStyle = input.weather === 'snow' ? 'rgba(220,235,255,0.16)' : 'rgba(60,80,110,0.14)';
    ctx.fillRect(0, 0, dims.width, dims.height);
  }
  if (input.weather === 'rainy' || input.weather === 'storm') {
    ctx.strokeStyle = 'rgba(200,225,245,0.42)';
    ctx.lineWidth = 1.3;
    for (let index = 0; index < 160; index += 1) {
      const rx = random() * dims.width;
      const ry = random() * dims.height;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 3, ry + 10);
      ctx.stroke();
    }
  }
  if (input.weather === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let index = 0; index < 120; index += 1) {
      ctx.beginPath();
      ctx.arc(random() * dims.width, random() * dims.height, 1 + random() * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- Bandeau d'en-tête ----------------------------------------------------
  fillRoundRect(ctx, 16, 12, dims.width - 32, 58, 14, 'rgba(20,24,33,0.72)');
  drawWeatherIcon(ctx, 30, 20, 40, input.weather);
  ctx.font = font(20, 'bold');
  ctx.fillStyle = PALETTE.text;
  const weatherKey = `world.weather.${input.weather}`;
  const weatherLabel = t(weatherKey);
  ctx.fillText(weatherLabel === weatherKey ? input.weather : weatherLabel, 80, 22);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(t(`world.season.${input.season}`), 80, 46);

  return encode(canvas);
}

/** Profil d'une ligne de collines : hauteur de sommet et de creux (0..1) par bosse. */
function hillProfile(count: number, random: () => number): Array<{ peak: number; dip: number }> {
  return Array.from({ length: count + 1 }, () => ({ peak: 0.45 + random() * 0.55, dip: 0.25 * random() }));
}

/** Ligne de collines : bosses jointes en une seule forme jusqu'à `baseY`. */
function drawHills(
  ctx: SKRSContext2D,
  width: number,
  baseY: number,
  amplitude: number,
  color: string,
  profile: Array<{ peak: number; dip: number }>,
): void {
  const count = profile.length - 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-10, baseY);
  const step = (width + 20) / count;
  profile.forEach((hill, index) => {
    const cx = -10 + step * index;
    ctx.quadraticCurveTo(cx - step / 2, baseY - amplitude * hill.peak, cx, baseY - amplitude * hill.dip);
  });
  ctx.lineTo(width + 10, baseY);
  ctx.closePath();
  ctx.fill();
}

/** Touffe de roseaux au premier plan : tiges hautes et massettes brunes. */
function drawReeds(ctx: SKRSContext2D, x: number, bottom: number, count: number, color: string, random: () => number): void {
  for (let index = 0; index < count; index += 1) {
    const rx = x + index * 14 + (random() - 0.5) * 8;
    const height = 70 + random() * 70;
    const lean = (random() - 0.5) * 24;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rx, bottom + 4);
    ctx.quadraticCurveTo(rx + lean * 0.4, bottom - height * 0.55, rx + lean, bottom - height);
    ctx.stroke();
    if (random() > 0.35) {
      ctx.fillStyle = '#6b4a2b';
      ctx.beginPath();
      ctx.ellipse(rx + lean, bottom - height + 8, 3.5, 12, lean / 60, 0, Math.PI * 2);
      ctx.fill();
    }
    // Feuille, en trait plus fin.
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rx + lean * 0.3, bottom - height * 0.45);
    ctx.quadraticCurveTo(rx + lean * 0.3 + 14, bottom - height * 0.55, rx + lean * 0.3 + 22, bottom - height * 0.8);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

/**
 * Texte alternatif de l'étang : la scène est décorative, seuls la saison et
 * la météo y portent une information — ce sont elles qu'on annonce d'abord.
 * Même repli que le bandeau dessiné pour une météo inconnue du catalogue.
 */
export function describeFishing(input: FishingRenderInput): string {
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const weatherKey = `world.weather.${input.weather}`;
  const weatherLabel = t(weatherKey);

  return clampAltText(
    t('render_alt.fishing.scene', {
      season: t(`world.season.${input.season}`),
      weather: weatherLabel === weatherKey ? input.weather : weatherLabel,
    }),
  );
}
