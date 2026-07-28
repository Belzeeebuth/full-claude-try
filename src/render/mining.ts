import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { PALETTE, encode, fillRoundRect, font, newCanvas, verticalGradient } from './canvas';

/**
 * Coupe verticale du puits de mine. La règle de profondeur couvre TOUJOURS
 * `balance.mining.maxDepth` paliers (le maximum théorique du jeu), pas
 * seulement ceux débloqués par ce joueur : les paliers hors de portée
 * apparaissent assombris, comme les articles verrouillés de `/shop` — de quoi
 * donner un objectif visible, pas seulement un chiffre.
 */

export interface MiningRenderInput {
  locale: string;
  depth: number;
  maxDepth: number;
  deepestReached: number;
}

const ROCK_TOP = '#8a7864';
const ROCK_BOTTOM = '#241b14';

export async function renderMining(input: MiningRenderInput): Promise<Buffer> {
  const balance = getBalance();
  const dims = balance.render.mining;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(input.locale, key, params);
  const totalDepth = Math.max(1, balance.mining.maxDepth);

  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const headerHeight = 70;
  const surfaceHeight = 26;
  const shaftTop = headerHeight + surfaceHeight;
  const shaftBottom = dims.height - 16;
  const shaftHeight = shaftBottom - shaftTop;
  const shaftX = dims.width * 0.32;
  const shaftWidth = dims.width * 0.4;

  // --- Fond -----------------------------------------------------------------
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, dims.width, dims.height);

  // --- Surface, juste sous l'en-tête -----------------------------------------
  ctx.fillStyle = '#5da13c';
  ctx.fillRect(0, headerHeight, dims.width, surfaceHeight);

  // --- Puits : dégradé clair en surface, sombre en profondeur ----------------
  ctx.fillStyle = verticalGradient(ctx, 0, shaftTop, shaftHeight, ROCK_TOP, ROCK_BOTTOM);
  ctx.fillRect(shaftX, shaftTop, shaftWidth, shaftHeight);

  const depthToY = (depth: number): number => shaftTop + ((depth - 1) / (totalDepth - 1 || 1)) * shaftHeight;

  // Paliers hors de portée du joueur : voile sombre, pour montrer le potentiel
  // sans le rendre accessible visuellement.
  if (input.maxDepth < totalDepth) {
    const lockedY = depthToY(input.maxDepth + 1);
    fillRoundRect(ctx, shaftX, lockedY, shaftWidth, shaftBottom - lockedY, 0, 'rgba(0,0,0,0.55)');
  }

  // Étais de bois tous les 5 paliers, pour donner une échelle visuelle au puits.
  for (let depth = 1; depth <= totalDepth; depth += 5) {
    const y = depthToY(depth);
    ctx.fillStyle = 'rgba(122,82,48,0.8)';
    ctx.fillRect(shaftX - 6, y, shaftWidth + 12, 6);
  }

  // Filons : petites touches de couleur, plus denses en profondeur.
  const veinColors = ['#c9a24b', '#8fd3f4', '#e05a4f'];
  let seed = 17;
  const pseudoRandom = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < 26; i += 1) {
    const depth = 1 + pseudoRandom() * (totalDepth - 1);
    if (depth > input.maxDepth + 0.5) continue;
    const x = shaftX + 10 + pseudoRandom() * (shaftWidth - 20);
    const y = depthToY(depth);
    ctx.fillStyle = veinColors[Math.floor(pseudoRandom() * veinColors.length)]!;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Règle de profondeur, à gauche du puits.
  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.textAlign = 'right';
  const tickStep = totalDepth > 12 ? 5 : 2;
  for (let depth = 1; depth <= totalDepth; depth += tickStep) {
    const y = depthToY(depth);
    ctx.fillText(String(depth), shaftX - 14, y - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(shaftX - 8, y);
    ctx.lineTo(shaftX, y);
    ctx.stroke();
  }
  ctx.textAlign = 'left';

  // Marqueur du joueur : une lanterne à sa profondeur courante.
  const playerY = depthToY(Math.max(1, Math.min(input.depth, totalDepth)));
  const playerX = shaftX + shaftWidth / 2;
  const glow = ctx.createRadialGradient(playerX, playerY, 2, playerX, playerY, 26);
  glow.addColorStop(0, 'rgba(255,201,60,0.85)');
  glow.addColorStop(1, 'rgba(255,201,60,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(playerX, playerY, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.gold;
  ctx.beginPath();
  ctx.arc(playerX, playerY, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PALETTE.text;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Meilleure profondeur atteinte : petit repère discret, si différent de l'actuelle.
  if (input.deepestReached > input.depth) {
    const bestY = depthToY(Math.min(input.deepestReached, totalDepth));
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(shaftX, bestY);
    ctx.lineTo(shaftX + shaftWidth, bestY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // --- Bandeau d'en-tête ------------------------------------------------------
  fillRoundRect(ctx, 16, 12, dims.width - 32, headerHeight - 22, 14, 'rgba(20,24,33,0.82)');
  ctx.font = font(22, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(
    t('mining.depth_field') + ` — ${input.depth} / ${input.maxDepth}`,
    32,
    22,
  );
  if (input.deepestReached > input.depth) {
    ctx.font = font(14);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'right';
    ctx.fillText(t('mining.best_depth_field', { depth: input.deepestReached }), dims.width - 32, 26);
    ctx.textAlign = 'left';
  }

  return encode(canvas);
}
