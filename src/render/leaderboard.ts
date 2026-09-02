import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { formatCompact, formatNumber } from '../utils/format';
import { clampAltText, joinSentences } from './alt-text';
import {
  PALETTE,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  font,
  newCanvas,
  roundRect,
  verticalGradient,
  withDropShadow,
  withEmoji,
} from './canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';

/** Carte de classement : podium illustré + liste des suivants. */

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  extra: string;
  avatarUrl?: string | null;
  isViewer?: boolean;
}

export interface LeaderboardRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  title: string;
  emoji: string;
  unit: string;
  scopeLabel: string;
  entries: LeaderboardEntry[];
  viewer?: { rank: number; score: number } | undefined;
}

const PODIUM_COLORS = ['#ffd700', '#c0c0c0', '#cd7f32'];

export async function renderLeaderboard(input: LeaderboardRenderInput): Promise<Buffer> {
  const dims = getBalance().render.leaderboard;
  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const locale = input.locale;

  ctx.fillStyle = verticalGradient(ctx, 0, 0, dims.height, '#232a3a', PALETTE.card);
  ctx.fillRect(0, 0, dims.width, dims.height);

  // L'emoji n'est écrit que si la police couleur est installée : l'image Docker
  // l'embarque, une machine de développement pas forcément.
  ctx.font = font(30, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(
    withEmoji(input.emoji, translate(locale, 'render.leaderboard.title', { title: input.title })),
    32,
    24,
  );
  ctx.font = font(15);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(input.scopeLabel, 32, 62);

  // --- Podium (3 premiers) ---------------------------------------------
  // La géométrie est calée sur ce qui doit tenir AU-DESSUS du bloc : l'avatar
  // puis le nom. Le titre occupe les 80 premiers pixels ; le podium commence
  // assez bas pour que l'avatar du premier ne vienne pas s'y superposer.
  const podium = input.entries.slice(0, 3);
  const podiumY = 156;
  const podiumBaseline = 144;
  const podiumAvatar = 60;
  const podiumHeights = [126, 100, 84];
  const podiumOrder = [1, 0, 2]; // 2e, 1er, 3e — disposition visuelle classique
  const columnWidth = 180;
  const startX = (dims.width - columnWidth * 3 - 24) / 2;

  for (const [position, entryIndex] of podiumOrder.entries()) {
    const entry = podium[entryIndex];
    if (!entry) continue;

    const x = startX + position * (columnWidth + 12);
    const barHeight = podiumHeights[entryIndex] ?? 84;
    const barY = podiumY + podiumBaseline - barHeight;

    // Le nom s'écrit AU-DESSUS du bloc, et il lui faut sa place : avatar, puis
    // ligne de nom, puis bloc. Le tracé précédent posait le nom 12 px au-dessus
    // du bloc alors qu'il en fait 16 de haut — il passait dessous.
    const nameBaseline = barY - 24;
    await drawAvatar(
      ctx,
      entry.avatarUrl ?? null,
      x + columnWidth / 2 - podiumAvatar / 2,
      nameBaseline - podiumAvatar - 8,
      podiumAvatar,
    );

    withDropShadow(ctx, () =>
      fillRoundRect(ctx, x, barY, columnWidth, barHeight, 12, PODIUM_COLORS[entryIndex] ?? '#555'),
    );
    // Une vraie médaille, ruban compris, plutôt qu'un « #1 » en gros : c'est
    // l'objet qu'on associe à un podium, et il se lit sans chiffre. Le rang
    // reste gravé au centre pour les daltoniens, à qui or et bronze se
    // ressemblent.
    drawMedal(ctx, x + columnWidth / 2, barY + 36, 20, entryIndex, entry.rank);

    ctx.textAlign = 'center';
    ctx.font = font(16, 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(clipText(ctx, entry.name, columnWidth - 16), x + columnWidth / 2, nameBaseline);

    ctx.font = font(15, 'bold');
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(formatCompact(entry.score, locale), x + columnWidth / 2, barY + 60);
    ctx.textAlign = 'left';
  }

  // --- Liste 4 à 10 ------------------------------------------------------
  let rowY = podiumY + podiumBaseline + 14;
  for (const entry of input.entries.slice(3, 10)) {
    fillRoundRect(
      ctx,
      32,
      rowY,
      dims.width - 64,
      38,
      10,
      entry.isViewer ? 'rgba(126,200,80,0.22)' : PALETTE.cardAlt,
    );
    // La ligne du spectateur se distingue aussi par sa bordure : un fond
    // légèrement plus vert ne suffisait pas à la retrouver d'un coup d'œil.
    if (entry.isViewer) {
      roundRect(ctx, 32, rowY, dims.width - 64, 38, 10);
      ctx.strokeStyle = PALETTE.grass;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.font = font(16, 'bold');
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(`#${entry.rank}`, 46, rowY + 10);

    ctx.fillStyle = PALETTE.text;
    ctx.fillText(clipText(ctx, entry.name, 380), 100, rowY + 10);

    ctx.font = font(14);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(clipText(ctx, entry.extra, 200), 500, rowY + 12);

    ctx.font = font(16, 'bold');
    ctx.fillStyle = PALETTE.gold;
    ctx.textAlign = 'right';
    ctx.fillText(formatCompact(entry.score, locale), dims.width - 48, rowY + 10);
    ctx.textAlign = 'left';

    rowY += 44;
  }

  // --- Rang du spectateur ------------------------------------------------
  // Positionné APRÈS la dernière ligne, jamais à une hauteur fixe : sinon il
  // recouvrirait la liste quand celle-ci est complète.
  if (input.viewer) {
    const bandY = Math.max(rowY + 8, dims.height - 62);
    fillRoundRect(ctx, 32, bandY, dims.width - 64, 42, 10, 'rgba(126,200,80,0.18)');
    roundRect(ctx, 32, bandY, dims.width - 64, 42, 10);
    ctx.strokeStyle = PALETTE.grass;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = font(16, 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(
      translate(locale, 'render.leaderboard.your_rank', {
        rank: input.viewer.rank,
        score: formatCompact(input.viewer.score, locale),
        unit: input.unit,
      }),
      48,
      bandY + 12,
    );
  }

  return encode(canvas);
}

/** Métal de chaque marche : teinte claire, teinte sombre, couleur du ruban. */
const MEDAL_METALS: Array<{ light: string; dark: string; ribbon: string }> = [
  { light: '#fff1a8', dark: '#d9a400', ribbon: '#d33f49' },
  { light: '#f4f6f8', dark: '#8f9aa5', ribbon: '#3457d5' },
  { light: '#f0b98a', dark: '#8c4f1f', ribbon: '#2e8b57' },
];

/**
 * Médaille vectorielle : ruban en V derrière un disque métallique bombé, le
 * rang gravé au centre. Tout est tracé, rien ne dépend d'une police.
 */
function drawMedal(ctx: SKRSContext2D, cx: number, cy: number, radius: number, tier: number, rank: number): void {
  const metal = MEDAL_METALS[tier] ?? MEDAL_METALS[2]!;

  // Ruban : deux pans partant du haut du disque, bord sombre pour le relief.
  const ribbonTop = cy - radius - 14;
  const pan = (direction: -1 | 1): void => {
    ctx.beginPath();
    ctx.moveTo(cx + direction * 2, cy - radius * 0.55);
    ctx.lineTo(cx + direction * 10, ribbonTop);
    ctx.lineTo(cx + direction * 22, ribbonTop);
    ctx.lineTo(cx + direction * 13, cy - radius * 0.35);
    ctx.closePath();
    ctx.fillStyle = metal.ribbon;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  pan(-1);
  pan(1);

  // Disque : dégradé radial décentré, lumière en haut à gauche.
  const shine = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.1, cx, cy, radius);
  shine.addColorStop(0, metal.light);
  shine.addColorStop(1, metal.dark);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = shine;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Cercle intérieur gravé.
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.74, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = font(Math.round(radius * 0.95), 'bold');
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.textAlign = 'center';
  ctx.fillText(String(rank), cx, cy - radius * 0.55);
  ctx.textAlign = 'left';
}

/**
 * Texte alternatif du classement : le titre et sa portée, puis les dix
 * classés dessinés (podium compris), enfin le rang du spectateur — les scores
 * en entier, là où l'image les abrège.
 */
export function describeLeaderboard(input: LeaderboardRenderInput): string {
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  const entries = input.entries.slice(0, 10).map((entry) =>
    t(entry.extra ? 'render_alt.leaderboard.entry_extra' : 'render_alt.leaderboard.entry', {
      rank: entry.rank,
      name: entry.name,
      score: formatNumber(entry.score, locale),
      unit: input.unit,
      extra: entry.extra,
    }),
  );

  return clampAltText(
    joinSentences([
      t('render_alt.leaderboard.header', { title: input.title, scope: input.scopeLabel }),
      // Point-virgule entre les classés : chaque entrée contient déjà une virgule.
      entries.length > 0
        ? t('render_alt.leaderboard.entries', { entries: entries.join('; ') })
        : t('render_alt.leaderboard.empty'),
      input.viewer
        ? t('render_alt.leaderboard.viewer', {
            rank: input.viewer.rank,
            score: formatNumber(input.viewer.score, locale),
            unit: input.unit,
          })
        : null,
    ]),
  );
}
