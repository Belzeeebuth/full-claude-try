import { balance as getBalance } from '../config';
import { translate } from '../i18n';
import { formatCompact, formatNumber } from '../utils/format';
import {
  PALETTE,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  font,
  newCanvas,
  progressBar,
  verticalGradient,
  withDropShadow,
} from './canvas';
import { drawCoin, drawGem, rarityColor } from './sprites';

/** Carte de profil : avatar, bannière, niveau, XP, statistiques clés, badges. */

export interface ProfileRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  title: string | null;
  badges: string[];
  level: number;
  prestige: number;
  xp: { current: number; needed: number };
  coins: number;
  gems: number;
  bank: number;
  energy: { current: number; max: number };
  stats: {
    harvests: number;
    animals: number;
    crafts: number;
    plots: number;
    streak: number;
    achievements: number;
    bestHarvest: number;
    coinsEarned: number;
  };
  coop: { name: string; tag: string; level: number; role: string } | null;
  themeColor: string;
  bannerStyle?: string;
  farmName: string;
  createdAt: Date;
}

const BANNERS: Record<string, [string, string]> = {
  default: ['#2b3a55', '#1f2430'],
  sunset: ['#ff7e5f', '#feb47b'],
  starry: ['#0f1b3d', '#3a2a6d'],
  autumn: ['#8b4513', '#d2691e'],
  winter: ['#4a6fa5', '#a8c8e8'],
  neon: ['#3a0ca3', '#f72585'],
};

export async function renderProfile(input: ProfileRenderInput): Promise<Buffer> {
  const dims = getBalance().render.profile;
  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  // --- Bannière et fond -------------------------------------------------
  // La bannière ne porte AUCUN texte : sa couleur est choisie par le joueur, on
  // ne peut donc pas garantir le contraste. Tout le texte vit sur la carte
  // sombre, dont le contraste est maîtrisé.
  const bannerHeight = 118;
  const banner = BANNERS[input.bannerStyle ?? 'default'] ?? BANNERS.default!;
  ctx.fillStyle = verticalGradient(ctx, 0, 0, bannerHeight, banner[0], banner[1]);
  ctx.fillRect(0, 0, dims.width, bannerHeight);
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, bannerHeight, dims.width, dims.height - bannerHeight);

  // Accent coloré du joueur, en bas de la bannière
  ctx.fillStyle = input.themeColor;
  ctx.fillRect(0, bannerHeight - 4, dims.width, 5);

  // --- Identité ---------------------------------------------------------
  // L'avatar chevauche la bannière et la carte : repère visuel classique.
  await drawAvatar(ctx, input.avatarUrl, 36, bannerHeight - 56, 112, input.themeColor);

  const nameX = 172;
  ctx.fillStyle = PALETTE.text;
  ctx.font = font(32, 'bold');
  ctx.fillText(clipText(ctx, input.displayName, 400), nameX, bannerHeight + 12);

  ctx.font = font(16);
  ctx.fillStyle = PALETTE.textMuted;
  const subtitle = [
    input.title ?? t('render.profile.default_title'),
    input.prestige > 0 ? t('render.profile.prestige', { rank: input.prestige }) : null,
    input.coop ? `[${input.coop.tag}] ${input.coop.name}` : null,
  ]
    .filter(Boolean)
    .join(' • ');
  ctx.fillText(clipText(ctx, subtitle, 420), nameX, bannerHeight + 52);

  // --- Niveau et XP -----------------------------------------------------
  ctx.font = font(20, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(t('render.profile.level', { level: input.level }), nameX, bannerHeight + 82);

  // Les libellés sont dessinés DANS les barres : à droite, ils empiéteraient
  // sur le bloc des monnaies.
  progressBar(ctx, {
    x: nameX,
    y: bannerHeight + 112,
    width: 400,
    height: 22,
    ratio: input.xp.needed > 0 ? input.xp.current / input.xp.needed : 1,
    fill: PALETTE.xp,
    label:
      input.xp.needed > 0
        ? t('render.profile.xp', {
            current: formatCompact(input.xp.current, locale),
            needed: formatCompact(input.xp.needed, locale),
          })
        : t('render.profile.max_level'),
  });

  progressBar(ctx, {
    x: nameX,
    y: bannerHeight + 144,
    width: 400,
    height: 18,
    ratio: input.energy.max > 0 ? input.energy.current / input.energy.max : 1,
    fill: '#f7c948',
    label: t('render.profile.energy', {
      current: input.energy.current,
      max: input.energy.max,
    }),
  });

  // --- Monnaies ---------------------------------------------------------
  const walletX = dims.width - 288;
  withDropShadow(ctx, () => fillRoundRect(ctx, walletX, bannerHeight + 26, 252, 116, 14, PALETTE.cardAlt));
  drawCoin(ctx, walletX + 26, bannerHeight + 56, 11);
  ctx.font = font(20, 'bold');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(formatNumber(input.coins, locale), walletX + 46, bannerHeight + 46);
  drawGem(ctx, walletX + 26, bannerHeight + 92, 11);
  ctx.fillStyle = '#7fd8ff';
  ctx.fillText(formatNumber(input.gems, locale), walletX + 46, bannerHeight + 82);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    t('render.profile.in_bank', { amount: formatCompact(input.bank, locale) }),
    walletX + 20,
    bannerHeight + 116,
  );

  // --- Statistiques en grille ------------------------------------------
  const statsY = bannerHeight + 176;
  const cells: Array<{ label: string; value: string; color: string }> = [
    { label: t('render.profile.stat.harvests'), value: formatCompact(input.stats.harvests, locale), color: PALETTE.grass },
    { label: t('render.profile.stat.animals'), value: formatCompact(input.stats.animals, locale), color: '#e8b04b' },
    { label: t('render.profile.stat.crafts'), value: formatCompact(input.stats.crafts, locale), color: '#7fd8ff' },
    { label: t('render.profile.stat.plots'), value: `${input.stats.plots}/64`, color: PALETTE.soil },
    { label: t('render.profile.stat.streak'), value: t('render.profile.streak_unit', { days: input.stats.streak }), color: '#ff7043' },
    { label: t('render.profile.stat.achievements'), value: String(input.stats.achievements), color: PALETTE.gold },
    { label: t('render.profile.stat.best_harvest'), value: formatCompact(input.stats.bestHarvest, locale), color: rarityColor('epic') },
    { label: t('render.profile.stat.coins_earned'), value: formatCompact(input.stats.coinsEarned, locale), color: rarityColor('legendary') },
  ];

  const columns = 4;
  const cellWidth = (dims.width - 72 - (columns - 1) * 12) / columns;
  const cellHeight = 62;

  cells.forEach((cell, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = 36 + column * (cellWidth + 12);
    const y = statsY + row * (cellHeight + 12);

    withDropShadow(ctx, () => fillRoundRect(ctx, x, y, cellWidth, cellHeight, 12, PALETTE.cardAlt), {
      blur: 8,
      offsetY: 3,
    });
    ctx.fillStyle = cell.color;
    ctx.fillRect(x, y + 12, 4, cellHeight - 24);
    ctx.font = font(20, 'bold');
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(clipText(ctx, cell.value, cellWidth - 24), x + 16, y + 10);
    ctx.font = font(13);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(clipText(ctx, cell.label, cellWidth - 24), x + 16, y + 38);
  });

  // --- Pied de carte : badges à gauche, ferme et ancienneté à droite -----
  // Les badges sont des emoji : sans police couleur installée, ils
  // s'afficheraient en carrés. On les représente donc par des pastilles, et
  // l'embed Discord affiche les emoji réels à côté de l'image.
  const footerY = dims.height - 34;
  if (input.badges.length > 0) {
    for (const [index, _badge] of input.badges.slice(0, 10).entries()) {
      const x = 42 + index * 22;
      ctx.beginPath();
      ctx.arc(x, footerY + 8, 8, 0, Math.PI * 2);
      ctx.fillStyle = index % 2 === 0 ? PALETTE.gold : rarityColor('epic');
      ctx.fill();
    }
    ctx.font = font(13);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(
      t('render.profile.badges', { count: input.badges.length }),
      42 + Math.min(10, input.badges.length) * 22 + 6,
      footerY + 2,
    );
  }

  ctx.font = font(13);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.textAlign = 'right';
  ctx.fillText(
    clipText(
      ctx,
      t('render.profile.since', {
        farm: input.farmName,
        date: input.createdAt.toLocaleDateString(locale.startsWith('en') ? 'en-US' : 'fr-FR'),
      }),
      480,
    ),
    dims.width - 36,
    footerY + 4,
  );
  ctx.textAlign = 'left';

  return encode(canvas);
}
