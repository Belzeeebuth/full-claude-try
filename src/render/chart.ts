import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { formatCompact, formatNumber, formatPercent } from '../utils/format';
import { clampAltText, joinSentences } from './alt-text';
import {
  PALETTE,
  drawPill,
  drawableText,
  encode,
  fillRoundRect,
  font,
  hasEmojiFont,
  newCanvas,
  withDropShadow,
  withEmoji,
} from './canvas';
import { drawCoin, drawItemIcon } from './sprites';

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
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
}

export async function renderMarketChart(input: ChartInput): Promise<Buffer> {
  const dims = getBalance().render.chart;
  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, dims.width, dims.height);

  // --- Titre ------------------------------------------------------------
  // Icône dessinée, jamais l'emoji de l'objet en texte : sans police couleur,
  // ce serait un carré « tofu » (voir la note de drawBadge dans sprites.ts).
  drawItemIcon(ctx, 44, 34, 16, input.title);
  ctx.font = font(26, 'bold');
  ctx.fillStyle = PALETTE.text;
  // Deux replis pour le même problème : l'emoji du catalogue quand la police
  // couleur est installée (le conteneur l'embarque), et une pastille colorée
  // dérivée du nom sinon. Dans les deux cas, jamais de carré « tofu ».
  const emojiAvailable = hasEmojiFont();
  if (!emojiAvailable) drawItemIcon(ctx, 44, 34, 16, input.title);
  ctx.fillText(withEmoji(input.emoji, input.title), emojiAvailable ? 32 : 68, 24);

  const rising = input.trend >= 0;
  const accent = rising ? PALETTE.success : PALETTE.danger;
  ctx.font = font(18, 'bold');
  ctx.fillStyle = accent;
  const priceLabel = formatCompact(input.currentPrice, locale);
  ctx.fillText(priceLabel, 32, 58);
  const priceWidth = ctx.measureText(priceLabel).width;
  drawCoin(ctx, 32 + priceWidth + 16, 67, 9);
  // `drawCoin` laisse le doré dans le contexte : sans cette ligne, la variation
  // s'affiche en jaune au lieu du vert ou du rouge de tendance.
  ctx.fillStyle = accent;
  ctx.fillText(
    `${rising ? '▲' : '▼'} ${formatPercent(input.trend, 1, locale)}`,
    32 + priceWidth + 34,
    58,
  );

  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    drawableText(
      t('render.chart.subtitle', {
        base: formatCompact(input.basePrice, locale),
        demand: input.demandIndex.toFixed(2),
      }),
    ),
    32,
    84,
  );

  // --- Zone de tracé ----------------------------------------------------
  const plot = { x: 72, y: 120, width: dims.width - 104, height: dims.height - 190 };
  withDropShadow(ctx, () =>
    fillRoundRect(ctx, plot.x - 12, plot.y - 12, plot.width + 24, plot.height + 24, 12, PALETTE.cardAlt),
  );

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
    ctx.fillText(formatCompact(Math.round(value), locale), plot.x - 10, y - 6);
    ctx.textAlign = 'left';
  }

  // Ligne du prix de référence : repère immédiat pour juger cher / bon marché.
  // Plus contrastée qu'avant, et son libellé en pilule : sur un fond déjà
  // strié de grille, un pointillé gris et un mot gris se perdaient.
  const baseY = toY(input.basePrice);
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(plot.x, baseY);
  ctx.lineTo(plot.x + plot.width, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  drawPill(ctx, {
    x: plot.x + plot.width - 6,
    y: baseY - 11,
    text: `${t('render.chart.reference')} ${formatCompact(input.basePrice, locale)}`,
    fontSize: 11,
    color: PALETTE.text,
    background: 'rgba(61,70,87,0.92)',
    align: 'right',
  });

  // --- Aire sous la courbe ---------------------------------------------
  // Dégradé en trois paliers : franc sous la courbe, puis qui s'éteint vite.
  // Un dégradé linéaire sur toute la hauteur délavait la zone au lieu de la
  // détacher du fond.
  const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.height);
  gradient.addColorStop(0, rising ? 'rgba(92,184,92,0.55)' : 'rgba(224,90,79,0.55)');
  gradient.addColorStop(0.55, rising ? 'rgba(92,184,92,0.16)' : 'rgba(224,90,79,0.16)');
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

  // --- Repères min / max et dernier point --------------------------------
  // Les extrêmes de la SÉRIE (pas du prix de référence, déjà tracé) sont
  // pointés et étiquetés sur la courbe : la légende en bas donnait les
  // chiffres, mais pas où ni quand. Un extrême confondu avec le dernier point
  // n'est pas répété : l'étiquette du dernier point suffit.
  const lastIndex = points.length - 1;
  const lastX = toX(lastIndex);
  const lastY = toY(points[lastIndex]!.price);
  let minIndex = 0;
  let maxIndex = 0;
  points.forEach((point, index) => {
    if (point.price < points[minIndex]!.price) minIndex = index;
    if (point.price > points[maxIndex]!.price) maxIndex = index;
  });
  const marker = (index: number, kind: 'min' | 'max'): void => {
    const x = toX(index);
    const y = toY(points[index]!.price);
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.cardAlt;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    const text = t(`render.chart.marker_${kind}`, { value: formatCompact(points[index]!.price, locale) });
    ctx.font = font(11, 'bold');
    const pillWidth = ctx.measureText(text).width + 16;
    // La pilule reste dans la zone de tracé, même pour un extrême au bord.
    const pillX = Math.min(plot.x + plot.width - pillWidth / 2, Math.max(plot.x + pillWidth / 2, x));
    drawPill(ctx, {
      x: pillX,
      y: kind === 'max' ? y - 28 : y + 9,
      text,
      fontSize: 11,
      color: PALETTE.text,
      align: 'center',
    });
  };
  if (points.length > 1 && minIndex !== maxIndex) {
    if (maxIndex !== lastIndex) marker(maxIndex, 'max');
    if (minIndex !== lastIndex) marker(minIndex, 'min');
  }

  // Dernier point mis en évidence, avec son prix : c'est le chiffre que le
  // joueur cherche. L'étiquette se place du côté d'où la courbe ne vient pas.
  ctx.beginPath();
  ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = PALETTE.text;
  ctx.lineWidth = 2;
  ctx.stroke();
  const previousY = points.length > 1 ? toY(points[lastIndex - 1]!.price) : lastY;
  const labelAbove = previousY >= lastY;
  drawPill(ctx, {
    x: lastX - 10,
    y: Math.min(plot.y + plot.height - 24, Math.max(plot.y + 2, labelAbove ? lastY - 30 : lastY + 10)),
    text: formatCompact(points[lastIndex]!.price, locale),
    fontSize: 13,
    color: accent,
    align: 'right',
  });

  // --- Axe temporel -----------------------------------------------------
  ctx.font = font(12);
  ctx.fillStyle = PALETTE.textMuted;
  const labelCount = Math.min(6, points.length);
  for (let index = 0; index < labelCount; index += 1) {
    const pointIndex = Math.round((index * (points.length - 1)) / Math.max(1, labelCount - 1));
    const point = points[pointIndex];
    if (!point) continue;
    const label = point.recordedAt.toLocaleString(locale.startsWith('en') ? 'en-US' : 'fr-FR', {
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
    drawableText(
      t('render.chart.legend', {
        min: formatCompact(min, locale),
        max: formatCompact(max, locale),
        count: points.length,
      }),
    ),
    32,
    dims.height - 28,
  );

  return encode(canvas);
}

/**
 * Texte alternatif du graphique : l'objet, le prix et sa tendance, puis les
 * bornes de la courbe — calculées comme la légende dessinée (le prix de
 * référence compte dans min/max), pour que voyants et non-voyants lisent les
 * mêmes nombres. Sans historique, le dessin pose un point unique daté de
 * maintenant ; la description, elle, n'invente pas de date.
 */
export function describeChart(input: ChartInput): string {
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  const prices =
    input.points.length > 0 ? input.points.map((point) => point.price) : [input.currentPrice];
  const min = Math.min(...prices, input.basePrice);
  const max = Math.max(...prices, input.basePrice);
  const direction = input.trend > 0 ? 'up' : input.trend < 0 ? 'down' : 'flat';
  const intl = locale.startsWith('en') ? 'en-US' : 'fr-FR';
  const stamp = (date: Date): string =>
    date.toLocaleString(intl, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const first = input.points[0];
  const last = input.points[input.points.length - 1];

  return clampAltText(
    joinSentences([
      t('render_alt.chart.header', {
        item: input.title,
        price: formatNumber(input.currentPrice, locale),
        trend: formatPercent(input.trend, 1, locale),
        direction: t(`render_alt.chart.${direction}`),
      }),
      t('render_alt.chart.reference', {
        base: formatNumber(input.basePrice, locale),
        demand: input.demandIndex.toFixed(2),
      }),
      first && last
        ? t('render_alt.chart.range', {
            min: formatNumber(min, locale),
            max: formatNumber(max, locale),
            count: input.points.length,
            from: stamp(first.recordedAt),
            to: stamp(last.recordedAt),
          })
        : t('render_alt.chart.no_history'),
    ]),
  );
}
