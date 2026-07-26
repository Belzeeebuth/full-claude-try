import { balance as getBalance } from '../config';
import type { FarmView } from '../services/farm.service';
import { formatCompact, formatDuration } from '../utils/format';
import {
  PALETTE,
  THEME_PALETTES,
  clipText,
  drawAvatar,
  encode,
  fillRoundRect,
  font,
  newCanvas,
  progressBar,
  verticalGradient,
} from './canvas';
import {
  cropColors,
  drawAnimal,
  drawBadge,
  drawLockedTile,
  drawPlant,
  drawCoin,
  drawGem,
  drawSoil,
  drawWeatherIcon,
  sprite,
} from './sprites';

/**
 * Vue de ferme en PNG : grille vue de dessus, bandeau d'en-tête avec le joueur,
 * la saison et la météo, et un pied de page récapitulatif.
 *
 * Le rendu est ENTIÈREMENT dérivé de `FarmView`, ce qui a deux conséquences
 * utiles : on peut prévisualiser une ferme sans base de données
 * (`npm run render:preview`), et la fonction est testable en comparant des
 * dimensions ou des sommes de contrôle.
 */

export interface FarmRenderInput {
  view: FarmView;
  player: { username: string; level: number; coins: number; gems: number; avatarUrl: string | null };
  xp: { current: number; needed: number };
  theme?: string;
  animalsPreview?: Array<{ emoji: string; animalKey: string }>;
}

export async function renderFarm(input: FarmRenderInput): Promise<Buffer> {
  const balance = getBalance();
  const config = balance.render.farm;
  const theme = THEME_PALETTES[input.theme ?? 'classic'] ?? THEME_PALETTES.classic!;

  const { width: gridWidth, height: gridHeight } = input.view.grid;
  // La taille des tuiles s'adapte pour qu'une ferme 8×8 tienne dans la largeur max.
  const tileSize = Math.min(
    config.tileSize,
    Math.floor((config.maxWidth - config.padding * 2) / Math.max(1, gridWidth)),
  );
  const boardWidth = gridWidth * tileSize;
  const boardHeight = gridHeight * tileSize;
  const footerHeight = 86;
  // Largeur minimale : l'en-tête (avatar + identité + météo + monnaies) a besoin
  // de ~760 px. Sans ce plancher, une ferme 3x3 produirait une image trop
  // étroite et le titre serait tronqué.
  const width = Math.max(760, boardWidth + config.padding * 2);
  const boardOffsetX = Math.round((width - boardWidth) / 2);
  const height = config.headerHeight + boardHeight + footerHeight + config.padding;

  const { canvas, ctx } = newCanvas(width, height);

  // --- Fond : ciel dégradé + bande d'herbe -------------------------------
  ctx.fillStyle = verticalGradient(ctx, 0, 0, height, theme.skyTop, theme.skyBottom);
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = theme.grassDark;
  ctx.fillRect(0, config.headerHeight - 12, width, height - config.headerHeight + 12);
  ctx.fillStyle = theme.grass;
  ctx.fillRect(0, config.headerHeight - 6, width, height - config.headerHeight + 6);

  // --- En-tête ----------------------------------------------------------
  fillRoundRect(ctx, config.padding, 14, width - config.padding * 2, config.headerHeight - 34, 18, 'rgba(20,24,33,0.82)');

  const avatarSize = 68;
  await drawAvatar(ctx, input.player.avatarUrl, config.padding + 16, 26, avatarSize);

  const textX = config.padding + 16 + avatarSize + 18;
  ctx.fillStyle = PALETTE.text;
  ctx.font = font(30, 'bold');
  ctx.fillText(clipText(ctx, input.view.name, width - textX - 268), textX, 30);

  ctx.font = font(18);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${input.player.username} • Niveau ${input.player.level}`,
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
      ? `${formatCompact(input.xp.current)} / ${formatCompact(input.xp.needed)} XP`
      : 'Niveau maximum',
    textX + 252,
    92,
  );

  // Bloc météo / saison / monnaies, aligné à droite
  const infoX = width - config.padding - 250;
  drawWeatherIcon(ctx, infoX, 22, 40, input.view.world.weather.weather);
  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  ctx.fillText(input.view.world.weather.label, infoX + 46, 30);
  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(
    `${input.view.world.season.season === 'spring' ? 'Printemps' : input.view.world.season.season === 'summer' ? 'Été' : input.view.world.season.season === 'autumn' ? 'Automne' : 'Hiver'} • ${input.view.world.weather.temperature} °C`,
    infoX + 46,
    52,
  );
  // Monnaies : pièce et gemme dessinées, pour ne dépendre d'aucune police emoji.
  drawCoin(ctx, infoX + 8, 92, 9);
  ctx.font = font(17, 'bold');
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(formatCompact(input.player.coins), infoX + 24, 84);
  drawGem(ctx, infoX + 138, 92, 9);
  ctx.fillStyle = '#7fd8ff';
  ctx.fillText(formatCompact(input.player.gems), infoX + 154, 84);

  // --- Grille de parcelles ----------------------------------------------
  const boardX = boardOffsetX;
  const boardY = config.headerHeight;
  const soilSprite = await sprite('tiles', 'soil');

  for (const plot of input.view.plots) {
    if (plot.x >= gridWidth || plot.y >= gridHeight) continue;
    const x = boardX + plot.x * tileSize;
    const y = boardY + plot.y * tileSize;

    if (plot.state === 'locked') {
      drawLockedTile(ctx, x + 2, y + 2, tileSize - 4);
      continue;
    }

    if (soilSprite) {
      ctx.drawImage(soilSprite, x + 2, y + 2, tileSize - 4, tileSize - 4);
    } else {
      drawSoil(ctx, x + 2, y + 2, tileSize - 4, plot.fertility);
    }

    // Culture
    if (plot.crop) {
      const stageIndex =
        plot.crop.growth.stage === 'withered'
          ? 5
          : plot.crop.growth.stage === 'ready'
            ? 5
            : plot.crop.growth.stage === 'maturing'
              ? 4
              : plot.crop.growth.stage === 'growing'
                ? 3
                : plot.crop.growth.stage === 'sprouting'
                  ? 2
                  : 1;

      const cropSprite = await sprite('crops', `${plot.crop.key}_${stageIndex}`);
      if (cropSprite) {
        ctx.drawImage(cropSprite, x + 2, y + 2, tileSize - 4, tileSize - 4);
      } else {
        const colors = cropColors(plot.crop.key);
        drawPlant(ctx, {
          x: x + 2,
          y: y + 2,
          size: tileSize - 4,
          stage: stageIndex,
          color: colors.stem,
          fruitColor: colors.fruit,
          ready: plot.crop.growth.ready,
          withered: plot.crop.growth.withered,
        });
      }

      // Badges d'état, en haut à droite de la tuile
      let badgeY = y + tileSize * 0.2;
      if (plot.crop.growth.ready) {
        drawBadge(ctx, x + tileSize - tileSize * 0.2, badgeY, tileSize * 0.3, 'ready', PALETTE.success);
        badgeY += tileSize * 0.3;
      } else if (plot.crop.growth.needsWater) {
        drawBadge(ctx, x + tileSize - tileSize * 0.2, badgeY, tileSize * 0.3, 'water', PALETTE.water);
        badgeY += tileSize * 0.3;
      }
      if (plot.pestType) {
        drawBadge(ctx, x + tileSize - tileSize * 0.2, badgeY, tileSize * 0.3, 'pest', PALETTE.danger);
      }
      if (plot.crop.mutation !== 'none') {
        drawBadge(ctx, x + tileSize * 0.22, y + tileSize * 0.2, tileSize * 0.28, 'mutation', '#8e7cff');
      }

      // Minuterie sous la tuile
      if (!plot.crop.growth.ready && !plot.crop.growth.withered) {
        ctx.font = font(Math.max(10, Math.round(tileSize * 0.14)), 'bold');
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        const label = formatDuration(plot.crop.growth.msRemaining);
        const labelWidth = ctx.measureText(label).width + 10;
        fillRoundRect(
          ctx,
          x + (tileSize - labelWidth) / 2,
          y + tileSize - tileSize * 0.24,
          labelWidth,
          tileSize * 0.18,
          6,
          'rgba(0,0,0,0.55)',
        );
        ctx.fillStyle = PALETTE.text;
        ctx.textAlign = 'center';
        ctx.fillText(label, x + tileSize / 2, y + tileSize - tileSize * 0.215);
        ctx.textAlign = 'left';
      }
    } else if (plot.weedLevel > 30) {
      // Parcelle vide envahie : signal visuel discret
      drawBadge(ctx, x + tileSize * 0.5, y + tileSize * 0.5, tileSize * 0.34, 'weeds', PALETTE.grassDark);
    }

    // Numéro de parcelle, coin haut-gauche
    ctx.font = font(Math.max(10, Math.round(tileSize * 0.15)), 'bold');
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(String(plot.slot), x + 8, y + 8);
  }

  // Cadre de la grille
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(boardX, boardY, boardWidth, boardHeight);

  // --- Pied de page -----------------------------------------------------
  const footerY = boardY + boardHeight + 12;
  fillRoundRect(ctx, config.padding, footerY, width - config.padding * 2, footerHeight - 24, 14, 'rgba(20,24,33,0.82)');

  ctx.font = font(16, 'bold');
  ctx.fillStyle = PALETTE.text;
  const counts = input.view.counts;
  const summary = `${counts.ready} prête(s)  •  ${counts.growing} en croissance  •  ${counts.empty} vide(s)  •  ${counts.locked} verrouillée(s)`;
  ctx.fillText(
    clipText(ctx, summary, width - config.padding * 2 - 32 - (input.animalsPreview?.length ?? 0) * 34),
    config.padding + 16,
    footerY + 12,
  );

  ctx.font = font(14);
  ctx.fillStyle = PALETTE.textMuted;
  const nextLabel = input.view.nextReadyAt
    ? `Prochaine récolte dans ${formatDuration(input.view.nextReadyAt.getTime() - Date.now())}`
    : counts.ready > 0
      ? 'Des cultures vous attendent !'
      : 'Aucune culture en terre';
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
