import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { clampAltText } from './alt-text';
import { PALETTE, encode, fillRoundRect, font, newCanvas, verticalGradient } from './canvas';
import { drawWeatherIcon } from './sprites';

/**
 * Scène d'étang, volontairement statique : elle ne change qu'avec la météo et
 * la saison, jamais avec l'état du ferrage (ça, c'est le texte de l'embed qui
 * le porte). Résultat : un très petit espace d'états possibles, donc un taux de
 * cache Redis proche de 100 % — la même image sert à tous les joueurs qui
 * pêchent le même jour sous le même ciel.
 */

const SEASON_WATER: Record<string, { skyTop: string; skyBottom: string; water: string; waterDeep: string }> = {
  spring: { skyTop: '#8fd3f4', skyBottom: '#c9f0d2', water: '#4aa3df', waterDeep: '#2f6f9e' },
  summer: { skyTop: '#6fc6f0', skyBottom: '#bfe8c9', water: '#2f97c9', waterDeep: '#1d5f80' },
  autumn: { skyTop: '#f6b26b', skyBottom: '#ffe0b2', water: '#3f7fa0', waterDeep: '#284f63' },
  winter: { skyTop: '#cfe8ff', skyBottom: '#f4faff', water: '#6fa8c9', waterDeep: '#3d637a' },
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

  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const shoreHeight = Math.round(dims.height * 0.24);

  // --- Ciel ---------------------------------------------------------------
  ctx.fillStyle = verticalGradient(ctx, 0, 0, shoreHeight, palette.skyTop, palette.skyBottom);
  ctx.fillRect(0, 0, dims.width, shoreHeight);

  // --- Rive ----------------------------------------------------------------
  ctx.fillStyle = '#5da13c';
  ctx.fillRect(0, shoreHeight - 10, dims.width, 18);

  // --- Étang -----------------------------------------------------------------
  const waterY = shoreHeight + 8;
  ctx.fillStyle = verticalGradient(ctx, 0, waterY, dims.height - waterY, palette.water, palette.waterDeep);
  ctx.fillRect(0, waterY, dims.width, dims.height - waterY);

  // Ondulations discrètes, pour ne pas laisser un aplat mort.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
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

  // Petit ponton de bois, ancré sur la rive gauche.
  const dockX = dims.width * 0.06;
  const dockWidth = dims.width * 0.16;
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(dockX, shoreHeight - 6, dockWidth, 14);
  for (let leg = 0; leg < 3; leg += 1) {
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
  ctx.fillStyle = PALETTE.danger;
  ctx.beginPath();
  ctx.arc(dockX + dockWidth + 30, waterY + 20, 5, 0, Math.PI * 2);
  ctx.fill();

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
