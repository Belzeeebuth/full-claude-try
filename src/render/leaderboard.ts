import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { formatCompact } from '../utils/format';
import {
  PALETTE,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  font,
  newCanvas,
  verticalGradient,
  withEmoji,
} from './canvas';

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

    fillRoundRect(ctx, x, barY, columnWidth, barHeight, 12, PODIUM_COLORS[entryIndex] ?? '#555');
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.font = font(34, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(`#${entry.rank}`, x + columnWidth / 2, barY + 12);

    ctx.font = font(16, 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(clipText(ctx, entry.name, columnWidth - 16), x + columnWidth / 2, nameBaseline);

    ctx.font = font(15, 'bold');
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(formatCompact(entry.score, locale), x + columnWidth / 2, barY + 54);
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
