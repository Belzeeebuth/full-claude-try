import { balance as getBalance } from '../config';
import { formatCompact, formatPercent } from '../utils/format';
import { PALETTE, encode, fillRoundRect, font, newCanvas } from './canvas';

/**
 * Graphique de prix du marché.
 *
 * Implémentation canvas native (voir la note dans render/canvas.ts) : axe,
 * grille, courbe lissée, aire dégradée sous la courbe, coloration selon la
 * tendance, et annotations min/max/actuel.
 */

export interface ChartPoint {
  price: number;
  recordedAt: Date;
}

export interface ChartInput {
  title: string;
  emoji: string;
  points: ChartPoint[];
  basePrice: number;
  currentPrice: number;
  trend: number;
  demandIndex: number;
}

export async function renderMarketChart(input: ChartInput): Promise<Buffer> {
  const dims = getBalance().render.chart;
  const { canvas, ctx } = newCanvas(dims.width, dims.height);

  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, dims.width, dims.height);

  // --- Titre ------------------------------------------------------------
  ctx.font = font(26, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(`${input.emoji} ${input.title}`, 32, 24);

  const rising = input.trend >= 0;
  const accent = rising ? PALETTE.success : PALETTE.danger;
  ctx.font = font(18, 'bold');
  ctx.fillStyle = accent;
  ctx.fillText(
    `${formatCompact(input.currentPrice)} 🪙  ${rising ? '▲' : '▼'} ${formatPercent(input.trend)}`,
    32,
    58,
  );

  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `Prix de référence : ${formatCompact(input.basePrice)} 🪙   •   Indice de demande : ${input.demandIndex.toFixed(2)}`,
    32,
    84,
  );

  // --- Zone de tracé ----------------------------------------------------
  const plot = { x: 72, y: 120, width: dims.width - 104, height: dims.height - 190 };
  fillRoundRect(ctx, plot.x - 12, plot.y - 12, plot.width + 24, plot.height + 24, 12, PALETTE.cardAlt);

  const points = input.points.length > 0 ? input.points : [
    { price: input.currentPrice, recordedAt: new Date() },
  ];
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices, input.basePrice);
  const max = Math.max(...prices, input.basePrice);
  const span = Math.max(1, max - min);
  // 8 % de marge en haut et en bas : la courbe ne colle jamais aux bords.
  const padded = { min: min - span * 0.08, max: max + span * 0.08 };
  const range = Math.max(1, padded.max - padded.min);

  const toX = (index: number): number =>
    plot.x + (points.length <= 1 ? plot.width / 2 : (plot.width * index) / (points.length - 1));
  const toY = (price: number): number =>
    plot.y + plot.height - ((price - padded.min) / range) * plot.height;

  // Grille horizontale + étiquettes d'axe
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.font = font(12);
  for (let step = 0; step <= 4; step += 1) {
    const value = padded.min + (range * step) / 4;
    const y = toY(value);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.width, y);
    ctx.stroke();
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'right';
    ctx.fillText(formatCompact(Math.round(value)), plot.x - 10, y - 6);
    ctx.textAlign = 'left';
  }

  // Ligne du prix de référence : repère immédiat pour juger cher / bon marché.
  const baseY = toY(input.basePrice);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath();
  ctx.moveTo(plot.x, baseY);
  ctx.lineTo(plot.x + plot.width, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = font(11);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText('référence', plot.x + plot.width - 62, baseY - 16);

  // --- Aire sous la courbe ---------------------------------------------
  const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
  gradient.addColorStop(0, rising ? 'rgba(92,184,92,0.35)' : 'rgba(224,90,79,0.35)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.beginPath();
  ctx.moveTo(toX(0), plot.y + plot.height);
  points.forEach((point, index) => ctx.lineTo(toX(index), toY(point.price)));
  ctx.lineTo(toX(points.length - 1), plot.y + plot.height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // --- Courbe -----------------------------------------------------------
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = toX(index);
    const y = toY(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Dernier point mis en évidence
  const lastX = toX(points.length - 1);
  const lastY = toY(points[points.length - 1]!.price);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = PALETTE.text;
  ctx.lineWidth = 2;
  ctx.stroke();

  // --- Axe temporel -----------------------------------------------------
  ctx.font = font(12);
  ctx.fillStyle = PALETTE.textMuted;
  const labelCount = Math.min(6, points.length);
  for (let index = 0; index < labelCount; index += 1) {
    const pointIndex = Math.round((index * (points.length - 1)) / Math.max(1, labelCount - 1));
    const point = points[pointIndex];
    if (!point) continue;
    const label = point.recordedAt.toLocaleString('fr-FR', {
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    ctx.textAlign = 'center';
    ctx.fillText(label, toX(pointIndex), plot.y + plot.height + 18);
    ctx.textAlign = 'left';
  }

  // --- Légende min / max ------------------------------------------------
  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `Min ${formatCompact(min)} 🪙   •   Max ${formatCompact(max)} 🪙   •   ${points.length} point(s) d'historique`,
    32,
    dims.height - 28,
  );

  return encode(canvas);
}
