import { balance as getBalance, getConfig } from '../config';
import { translate } from '../i18n';
import type { FarmView } from '../services/farm.service';
import { formatCompact, formatDuration } from '../utils/format';
import {
  PALETTE,
  THEME_PALETTES,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  fitFont,
  font,
  newCanvas,
  progressBar,
  verticalGradient,
} from './canvas';
import {
  cropSkin,
  drawAnimal,
  drawBadge,
  drawBed,
  drawCoin,
  drawCrop,
  drawGem,
  drawLockedTile,
  drawWeatherIcon,
  sprite,
} from './sprites';
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Vue de ferme en PNG : un champ clôturé, vu de dessus, sous le ciel de la
 * saison et de la météo du jour.
 *
 * Le rendu est ENTIÈREMENT dérivé de `FarmView`, ce qui a deux conséquences
 * utiles : on peut prévisualiser une ferme sans base de données
 * (`npm run render:preview`), et la fonction est testable en comparant des
 * dimensions ou des sommes de contrôle.
 *
 * Trois principes de lecture, dans cet ordre :
 *  1. LA PLANTE PORTE L'INFORMATION. Sa silhouette dit l'espèce, sa taille dit
 *     le stade. C'est ce qui permet de n'afficher qu'UN seul compte à rebours
 *     dans toute l'image au lieu d'un par parcelle.
 *  2. ON NE SIGNALE QUE L'ACTIONNABLE. Une pastille veut dire « fais quelque
 *     chose » : récolter, arroser, traiter. Le reste se lit sans badge.
 *  3. LE DÉCOR EST DÉTERMINISTE. Sa disposition est semée sur `farmId` : deux
 *     fermes ne se ressemblent pas, et la même ferme est identique d'un
 *     affichage à l'autre — condition nécessaire pour que le cache d'images
 *     reste valide.
 */

export interface FarmRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  view: FarmView;
  player: { username: string; level: number; coins: number; gems: number; avatarUrl: string | null };
  xp: { current: number; needed: number };
  theme?: string;
  animalsPreview?: Array<{ emoji: string; animalKey: string }>;
  /** Bâtiments possédés, dessinés autour du champ. */
  buildingsPreview?: Array<{ key: string; tier: number }>;
}

/**
 * Palette de SAISON : la couche de base du décor.
 *
 * À distinguer de `THEME_PALETTES`, qui est un choix cosmétique du joueur. La
 * saison vient du monde, le thème vient de la boutique ; quand le joueur a posé
 * un thème, il l'emporte.
 */
const SEASON_PALETTES: Record<
  string,
  { skyTop: string; skyBottom: string; grass: string; grassDark: string }
> = {
  spring: { skyTop: '#8fd3f4', skyBottom: '#d8f0d2', grass: '#7ec850', grassDark: '#5da13c' },
  summer: { skyTop: '#5cb8e8', skyBottom: '#bfe9c6', grass: '#6fb844', grassDark: '#4e8f33' },
  autumn: { skyTop: '#e8a95c', skyBottom: '#f6d9a8', grass: '#b08b3e', grassDark: '#8a6b2c' },
  winter: { skyTop: '#b9d8ee', skyBottom: '#eef6fb', grass: '#c8d8d2', grassDark: '#a4b8b2' },
};

/** Générateur déterministe : même graine, même décor, à chaque rendu. */
function seededRandom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 0x7fffffff;
}

export async function renderFarm(input: FarmRenderInput): Promise<Buffer> {
  const balance = getBalance();
  const config = balance.render.farm;
  const catalog = getConfig(input.locale);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  const weather = input.view.world.weather.weather;
  const season = input.view.world.season.season;
  // Le thème acheté prime sur la saison ; sans thème, la saison décide.
  const themed = input.theme && input.theme !== 'classic' ? THEME_PALETTES[input.theme] : undefined;
  const palette = themed ?? SEASON_PALETTES[season] ?? SEASON_PALETTES.summer!;

  const { width: gridWidth, height: gridHeight } = input.view.grid;

  // --- Géométrie ---------------------------------------------------------
  // La marge d'herbe n'est pas décorative : c'est elle qui porte la clôture et
  // les bâtiments, et qui fait qu'un champ ressemble à un champ.
  const FENCE_MARGIN = 20;
  const GRASS_MARGIN = 96;
  const tileSize = Math.min(
    config.tileSize,
    Math.floor(
      (config.maxWidth - (FENCE_MARGIN + GRASS_MARGIN) * 2) / Math.max(1, gridWidth),
    ),
  );
  const boardWidth = gridWidth * tileSize;
  const boardHeight = gridHeight * tileSize;
  const footerHeight = 84;
  const width = Math.max(880, boardWidth + (FENCE_MARGIN + GRASS_MARGIN) * 2);
  const boardX = Math.round((width - boardWidth) / 2);
  const boardY = config.headerHeight + FENCE_MARGIN + 12;
  const height = boardY + boardHeight + FENCE_MARGIN + 26 + footerHeight;

  const { canvas, ctx } = newCanvas(width, height);
  const horizon = config.headerHeight - 10;
  const random = seededRandom(seedFrom(input.view.farmId));

  drawSky(ctx, width, horizon, palette, weather);
  drawGrass(ctx, width, horizon, height, palette);
  drawPath(ctx, width, boardY + boardHeight + FENCE_MARGIN + 14);
  drawBuildings(ctx, {
    buildings: input.buildingsPreview ?? [],
    width,
    boardX,
    boardY,
    boardWidth,
    boardHeight,
    fenceMargin: FENCE_MARGIN,
    random,
  });
  drawFence(ctx, boardX, boardY, boardWidth, boardHeight, FENCE_MARGIN);

  // --- Parcelles ---------------------------------------------------------
  const soilSprite = await sprite('tiles', 'soil');
  // Un seul compte à rebours : celui qui arrive. Les vingt-quatre autres
  // n'apprenaient rien à personne et écrasaient l'image de pastilles noires.
  let nextSlot = -1;
  let soonest = Number.POSITIVE_INFINITY;
  for (const plot of input.view.plots) {
    const growth = plot.crop?.growth;
    if (!growth || growth.ready || growth.withered) continue;
    if (growth.msRemaining < soonest) {
      soonest = growth.msRemaining;
      nextSlot = plot.slot;
    }
  }

  for (const plot of input.view.plots) {
    if (plot.x >= gridWidth || plot.y >= gridHeight) continue;
    const x = boardX + plot.x * tileSize + 3;
    const y = boardY + plot.y * tileSize + 3;
    const size = tileSize - 6;

    if (plot.state === 'locked') {
      drawLockedTile(ctx, x, y, size);
      continue;
    }

    if (soilSprite) {
      ctx.drawImage(soilSprite, x, y, size, size);
    } else {
      drawBed(ctx, x, y, size, {
        fertility: plot.fertility,
        wet: weather === 'rainy' || weather === 'storm',
      });
    }

    if (plot.crop) {
      const stageIndex = STAGE_INDEX[plot.crop.growth.stage] ?? 1;
      const cropSprite = await sprite('crops', `${plot.crop.key}_${stageIndex}`);
      if (cropSprite) {
        ctx.drawImage(cropSprite, x, y, size, size);
      } else {
        // Une plante peut dépasser vers le HAUT — c'est naturel — mais jamais
        // sur les parcelles voisines : sans ce clip, un caféier mûr en mange trois.
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - 1, y - size * 0.3, size + 2, size * 1.3);
        ctx.clip();
        drawCrop(ctx, {
          x,
          y,
          size,
          stage: stageIndex,
          skin: cropSkin(catalog.crops.get(plot.crop.key)),
          ready: plot.crop.growth.ready,
          withered: plot.crop.growth.withered,
          seed: plot.slot,
        });
        ctx.restore();
      }

      // Badges : uniquement ce sur quoi le joueur peut agir.
      if (plot.crop.growth.ready) {
        drawBadge(ctx, x + size * 0.82, y + size * 0.18, size * 0.28, 'ready', PALETTE.success);
      } else if (!plot.crop.growth.withered) {
        // La silhouette porte déjà le stade : l'anneau ne sert qu'à signaler
        // l'imminence, au moment où l'information devient actionnable.
        if (plot.crop.growth.progress > 0.62) {
          drawProgressRing(ctx, x, y, size, plot.crop.growth.progress);
        }
        if (plot.crop.growth.needsWater) {
          drawBadge(ctx, x + size * 0.18, y + size * 0.18, size * 0.28, 'water', PALETTE.water);
        }
      }
      if (plot.pestType) {
        drawBadge(ctx, x + size * 0.18, y + size * 0.5, size * 0.28, 'pest', PALETTE.danger);
      }
      if (plot.crop.mutation !== 'none') {
        drawBadge(ctx, x + size * 0.82, y + size * 0.5, size * 0.26, 'mutation', '#8e7cff');
      }

      if (plot.slot === nextSlot) {
        drawCountdown(ctx, x, y, size, formatDuration(plot.crop.growth.msRemaining, locale));
      }
    } else {
      // Une parcelle libre doit se lire comme une INVITATION, pas comme un trou.
      drawEmptyPlot(ctx, x, y, size, plot.weedLevel > 30);
    }

    ctx.font = font(Math.max(9, Math.round(tileSize * 0.12)), 'bold');
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(String(plot.slot), x + 6, y + 5);
  }

  // La météo passe au-dessus du champ, mais DERRIÈRE les panneaux : du texte
  // strié de pluie serait illisible.
  drawWeatherOverlay(ctx, width, height, weather);

  // --- En-tête -----------------------------------------------------------
  fillRoundRect(ctx, config.padding, 14, width - config.padding * 2, config.headerHeight - 34, 18, 'rgba(20,24,33,0.82)');

  const avatarSize = 68;
  await drawAvatar(ctx, input.player.avatarUrl, config.padding + 16, 26, avatarSize);

  const textX = config.padding + 16 + avatarSize + 18;
  const infoX = width - config.padding - 262;
  ctx.fillStyle = PALETTE.text;
  // Le nom n'est plus tronqué : la taille s'adapte, et le clip ne sert que de
  // dernier recours. Un joueur qui prend la peine de nommer sa ferme doit la
  // voir en entier.
  const nameWidth = infoX - textX - 24;
  ctx.font = fitFont(ctx, input.view.name, nameWidth, [30, 27, 24, 21, 18, 16]);
  ctx.fillText(clipText(ctx, input.view.name, nameWidth), textX, 30);

  ctx.font = font(18);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${input.player.username} • ${t('render.farm.level', { level: input.player.level })}`,
    textX,
    66,
  );

  progressBar(ctx, {
    x: textX,
    y: 92,
    width: 240,
    height: 14,
    ratio: input.xp.needed > 0 ? input.xp.current / input.xp.needed : 1,
    fill: PALETTE.xp,
  });
  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    input.xp.needed > 0
      ? t('render.profile.xp', {
          current: formatCompact(input.xp.current, locale),
          needed: formatCompact(input.xp.needed, locale),
        })
      : t('render.farm.max_level'),
    textX + 252,
    92,
  );

  // Bloc météo / saison / monnaies, aligné à droite
  drawWeatherIcon(ctx, infoX, 22, 40, weather);
  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  // Le libellé de `balance.json` est français : on passe par la clé i18n, et on
  // ne retombe sur la config que si la clé n'existe pas.
  const weatherKey = `world.weather.${weather}`;
  const weatherLabel = t(weatherKey);
  ctx.fillText(weatherLabel === weatherKey ? input.view.world.weather.label : weatherLabel, infoX + 46, 30);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${t(`world.season.${season}`)} • ${input.view.world.weather.temperature} °C`,
    infoX + 46,
    52,
  );
  // Monnaies : pièce et gemme dessinées, pour ne dépendre d'aucune police emoji.
  drawCoin(ctx, infoX + 8, 92, 9);
  ctx.font = font(17, 'bold');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(formatCompact(input.player.coins, locale), infoX + 24, 84);
  drawGem(ctx, infoX + 138, 92, 9);
  ctx.fillStyle = '#7fd8ff';
  ctx.fillText(formatCompact(input.player.gems, locale), infoX + 154, 84);

  // --- Pied de page ------------------------------------------------------
  const footerY = height - footerHeight + 6;
  fillRoundRect(ctx, config.padding, footerY, width - config.padding * 2, footerHeight - 24, 14, 'rgba(20,24,33,0.82)');

  const counts = input.view.counts;
  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  const summary = t('render.farm.summary', {
    ready: counts.ready,
    growing: counts.growing,
    empty: counts.empty,
    locked: counts.locked,
  });
  ctx.fillText(
    clipText(ctx, summary, width - config.padding * 2 - 32 - (input.animalsPreview?.length ?? 0) * 34),
    config.padding + 16,
    footerY + 12,
  );

  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  const nextLabel = input.view.nextReadyAt
    ? t('render.farm.next_harvest', {
        duration: formatDuration(input.view.nextReadyAt.getTime() - Date.now(), locale),
      })
    : counts.ready > 0
      ? t('render.farm.harvest_waiting')
      : t('render.farm.nothing_planted');
  ctx.fillText(nextLabel, config.padding + 16, footerY + 36);

  // Aperçu du cheptel, à droite du pied de page
  if (input.animalsPreview && input.animalsPreview.length > 0) {
    const previewX = width - config.padding - 16 - input.animalsPreview.length * 34;
    for (const [index, animal] of input.animalsPreview.slice(0, 6).entries()) {
      const animalSprite = await sprite('animals', animal.animalKey);
      const ax = previewX + index * 34;
      if (animalSprite) {
        ctx.drawImage(animalSprite, ax, footerY + 12, 30, 30);
      } else {
        drawAnimal(ctx, { x: ax, y: footerY + 6, size: 34, color: '#e8d8b7', emoji: animal.emoji });
      }
    }
  }

  return encode(canvas);
}

const STAGE_INDEX: Record<string, number> = {
  planted: 1,
  sprouting: 2,
  growing: 3,
  maturing: 4,
  ready: 5,
  withered: 5,
};

// ---------------------------------------------------------------------------
// DÉCOR
// ---------------------------------------------------------------------------

function drawSky(
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

function drawGrass(
  ctx: SKRSContext2D,
  width: number,
  horizon: number,
  height: number,
  palette: { grass: string; grassDark: string },
): void {
  ctx.fillStyle = palette.grassDark;
  ctx.fillRect(0, horizon - 10, width, height - horizon + 10);
  ctx.fillStyle = palette.grass;
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

function drawPath(ctx: SKRSContext2D, width: number, y: number): void {
  ctx.fillStyle = 'rgba(150,120,84,0.5)';
  ctx.fillRect(0, y, width, 22);
  ctx.fillStyle = 'rgba(120,95,64,0.32)';
  ctx.fillRect(0, y, width, 4);
}

/** Clôture en bois : c'est elle qui dit « ferme » d'un coup d'œil. */
function drawFence(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  boardWidth: number,
  boardHeight: number,
  margin: number,
): void {
  const post = '#a5825a';
  const postDark = '#7a5c3c';
  const rail = '#b08e63';
  const left = x - margin;
  const right = x + boardWidth + margin;
  const top = y - margin;
  const bottom = y + boardHeight + margin;

  const horizontalRail = (py: number): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(left - 6, py + 4, right - left + 12, 5);
    ctx.fillStyle = rail;
    ctx.fillRect(left - 6, py, right - left + 12, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(left - 6, py, right - left + 12, 1.5);
  };
  const verticalRail = (px: number): void => {
    ctx.fillStyle = rail;
    ctx.fillRect(px, top - 6, 5, bottom - top + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(px, top - 6, 1.5, bottom - top + 12);
  };

  horizontalRail(top - 10);
  horizontalRail(top + 2);
  horizontalRail(bottom - 10);
  horizontalRail(bottom + 2);
  verticalRail(left - 4);
  verticalRail(left + 8);
  verticalRail(right - 4);
  verticalRail(right + 8);

  const drawPost = (px: number, py: number): void => {
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(px + 2, py + 3, 9, 32);
    ctx.fillStyle = postDark;
    ctx.fillRect(px, py, 9, 32);
    ctx.fillStyle = post;
    ctx.fillRect(px, py, 5, 32);
  };
  for (let px = left - 6; px <= right + 6; px += 58) {
    drawPost(px, top - 18);
    drawPost(px, bottom - 14);
  }
  for (let py = top + 22; py < bottom - 20; py += 62) {
    drawPost(left - 8, py);
    drawPost(right - 2, py);
  }
}

function drawWeatherOverlay(ctx: SKRSContext2D, width: number, height: number, weather: string): void {
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

function drawBuildings(
  ctx: SKRSContext2D,
  options: {
    buildings: Array<{ key: string; tier: number }>;
    width: number;
    boardX: number;
    boardY: number;
    boardWidth: number;
    boardHeight: number;
    fenceMargin: number;
    random: () => number;
  },
): void {
  if (options.buildings.length === 0) return;

  // Largeur d'herbe réellement disponible de chaque côté de la clôture. Une
  // grille 8×8 la réduit fortement : mieux vaut un bâtiment plus petit qu'un
  // bâtiment coupé par le bord de l'image.
  const EDGE = 12;
  const leftSpace = options.boardX - options.fenceMargin - EDGE * 2;
  const rightSpace =
    options.width - (options.boardX + options.boardWidth + options.fenceMargin) - EDGE * 2;
  const space = Math.min(leftSpace, rightSpace);
  if (space < 44) return;

  const rows = Math.max(2, Math.floor(options.boardHeight / 150));
  const slots: Array<{ center: number; y: number }> = [];
  const leftCenter = EDGE + leftSpace / 2;
  const rightCenter = options.width - EDGE - rightSpace / 2;
  for (let row = 0; row < rows; row += 1) {
    const y = options.boardY + 40 + (options.boardHeight / rows) * row;
    slots.push({ center: leftCenter, y });
    slots.push({ center: rightCenter, y });
  }

  for (const [index, building] of options.buildings.slice(0, slots.length).entries()) {
    const slot = slots[index]!;
    const size = Math.min(space, 52 + Math.min(3, building.tier) * 6);
    // Décalage semé, borné pour que le bâtiment reste entièrement visible.
    const room = Math.max(0, (space - size) / 2);
    const jitter = (options.random() - 0.5) * Math.min(20, room * 2);
    const jitterY = (options.random() - 0.5) * 18;
    drawBuilding(ctx, building.key, slot.center - size / 2 + jitter, slot.y + jitterY, size);
  }
}

function drawBuilding(ctx: SKRSContext2D, key: string, x: number, y: number, size: number): void {
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

// ---------------------------------------------------------------------------
// INDICATEURS DE TUILE
// ---------------------------------------------------------------------------

/** Anneau de progression : un seul geste de lecture, pas une ligne de texte. */
function drawProgressRing(ctx: SKRSContext2D, x: number, y: number, size: number, ratio: number): void {
  const radius = size * 0.11;
  const cx = x + size - radius - size * 0.06;
  const cy = y + radius + size * 0.06;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, Math.max(0, ratio)));
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function drawCountdown(ctx: SKRSContext2D, x: number, y: number, size: number, label: string): void {
  ctx.font = font(Math.max(11, Math.round(size * 0.14)), 'bold');
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 16;
  const boxHeight = size * 0.2;
  fillRoundRect(ctx, x + (size - boxWidth) / 2, y + size * 0.72, boxWidth, boxHeight, boxHeight / 2, 'rgba(20,24,33,0.86)');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(label, x + (size - textWidth) / 2, y + size * 0.72 + boxHeight * 0.16);
}

function drawEmptyPlot(ctx: SKRSContext2D, x: number, y: number, size: number, weedy: boolean): void {
  if (weedy) {
    drawBadge(ctx, x + size * 0.5, y + size * 0.46, size * 0.32, 'weeds', PALETTE.grassDark);
    return;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = Math.max(1.5, size / 48);
  ctx.setLineDash([size / 16, size / 16]);
  const inset = size * 0.26;
  ctx.strokeRect(x + inset, y + inset * 0.8, size - inset * 2, size * 0.9 - inset * 1.6);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = font(Math.round(size * 0.2), 'bold');
  const plus = '+';
  ctx.fillText(plus, x + size / 2 - ctx.measureText(plus).width / 2, y + size * 0.34);
}
