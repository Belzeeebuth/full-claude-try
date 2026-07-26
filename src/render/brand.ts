import { encode, font, newCanvas, roundRect, type SKRSContext2D } from './canvas';

/**
 * Identité visuelle de Harvester : avatar et bannière.
 *
 * Tout est dessiné en vectoriel, sans aucun asset externe. Deux raisons :
 *  - aucune question de licence, l'image est produite par ce dépôt ;
 *  - régénérable à n'importe quelle taille sans perte, ce qui compte parce que
 *    Discord affiche l'avatar de 32 px (liste des membres) à 512 px (profil).
 *
 * Contrainte de composition : Discord **rogne l'avatar en cercle**. Rien
 * d'important ne doit donc sortir du disque inscrit, et les angles du carré
 * sont considérés comme perdus.
 */

const BRAND = {
  skyTop: '#3aa0dd',
  skyMid: '#9ad9f2',
  skyLow: '#d8f2c9',
  sun: '#ffc93c',
  sunCore: '#ffe89a',
  hillBack: '#4f9138',
  hillFront: '#7ec850',
  hillShade: '#68b043',
  stem: '#6f9c31',
  grain: '#f0b429',
  grainDark: '#c98b1e',
  grainLight: '#ffd96b',
  ink: '#16202e',
  card: '#1b2331',
  text: '#f5f7fa',
  textMuted: '#9fb0c4',
} as const;

/** Soleil : noyau clair, disque doré, halo dégradé. */
function drawSun(ctx: SKRSContext2D, cx: number, cy: number, radius: number): void {
  const halo = ctx.createRadialGradient(cx, cy, radius * 0.6, cx, cy, radius * 2.6);
  halo.addColorStop(0, 'rgba(255,201,60,0.55)');
  halo.addColorStop(1, 'rgba(255,201,60,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 2.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = BRAND.sun;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = BRAND.sunCore;
  ctx.beginPath();
  ctx.arc(cx - radius * 0.18, cy - radius * 0.2, radius * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

/** Deux collines superposées + sillons, pour poser l'horizon. */
function drawHills(ctx: SKRSContext2D, width: number, horizon: number, bottom: number): void {
  ctx.fillStyle = BRAND.hillBack;
  ctx.beginPath();
  ctx.moveTo(-width, bottom);
  ctx.quadraticCurveTo(width * 0.28, horizon - width * 0.1, width * 1.2, horizon + width * 0.04);
  ctx.lineTo(width * 1.2, bottom);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = BRAND.hillFront;
  ctx.beginPath();
  ctx.moveTo(-width, bottom);
  ctx.quadraticCurveTo(width * 0.55, horizon + width * 0.02, width * 1.2, horizon + width * 0.16);
  ctx.lineTo(width * 1.2, bottom);
  ctx.closePath();
  ctx.fill();

  // Sillons : de simples arcs qui suivent la courbure, de plus en plus serrés
  // vers le bas — c'est ce qui donne la lecture « champ labouré » à petite taille.
  ctx.strokeStyle = BRAND.hillShade;
  ctx.lineWidth = Math.max(1.5, width * 0.006);
  for (let i = 1; i <= 5; i += 1) {
    const y = horizon + width * (0.06 + i * 0.052);
    ctx.beginPath();
    ctx.moveTo(-width * 0.1, y + width * 0.05);
    ctx.quadraticCurveTo(width * 0.5, y - width * 0.03, width * 1.1, y + width * 0.06);
    ctx.stroke();
  }
}

/** Un grain de blé : ellipse inclinée, avec une arête plus claire. */
function drawGrain(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  angle: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  ctx.fillStyle = BRAND.grain;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = BRAND.grainDark;
  ctx.lineWidth = Math.max(1, rx * 0.16);
  ctx.stroke();

  ctx.fillStyle = BRAND.grainLight;
  ctx.beginPath();
  ctx.ellipse(-rx * 0.22, -ry * 0.2, rx * 0.42, ry * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Feuille : lame courbe partant de la tige, dessinée en deux quadratiques. */
function drawLeaf(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  length: number,
  lift: number,
  direction: -1 | 1,
): void {
  ctx.fillStyle = BRAND.stem;
  ctx.beginPath();
  ctx.moveTo(x, y);
  // Aller : bord supérieur, qui monte franchement jusqu'à la pointe.
  ctx.quadraticCurveTo(
    x + direction * length * 0.45,
    y - lift * 1.35,
    x + direction * length,
    y - lift * 0.95,
  );
  // Retour : bord inférieur, plus creux — c'est cet écart qui donne l'épaisseur.
  ctx.quadraticCurveTo(x + direction * length * 0.45, y - lift * 0.3, x, y + length * 0.06);
  ctx.closePath();
  ctx.fill();
}

/**
 * Épi de blé complet.
 *
 * L'épi est construit en **fuseau** : l'écartement des grains suit une enveloppe
 * sinusoïdale (pointu en haut, large au milieu, resserré en bas), et le pas
 * vertical est plus petit que la hauteur d'un grain pour qu'ils se chevauchent.
 * C'est ce qui distingue un épi de deux colonnes de grains alignées — et c'est
 * ce qui reste lisible quand Discord affiche l'avatar à 32 px.
 *
 * `height` couvre l'ensemble tige + épi ; l'épi en occupe 55 %.
 */
function drawWheat(ctx: SKRSContext2D, baseX: number, baseY: number, height: number): void {
  const s = height / 300;
  const tipY = baseY - height;
  const earHeight = height * 0.55;
  const earBottom = tipY + earHeight;

  // Tige droite : les feuilles s'y rattachent alors exactement, et une verticale
  // franche tient mieux à très petite taille qu'une courbe.
  ctx.strokeStyle = BRAND.stem;
  ctx.lineWidth = 11 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(baseX, baseY);
  ctx.lineTo(baseX, earBottom);
  ctx.stroke();

  drawLeaf(ctx, baseX - 2 * s, baseY - height * 0.14, height * 0.26, height * 0.14, -1);
  drawLeaf(ctx, baseX + 2 * s, baseY - height * 0.27, height * 0.2, height * 0.11, 1);

  // Barbes, dessinées AVANT les grains pour passer dessous
  ctx.strokeStyle = BRAND.grainDark;
  ctx.lineWidth = 2.6 * s;
  ctx.lineCap = 'round';
  for (const angle of [-0.52, -0.28, 0, 0.28, 0.52]) {
    ctx.beginPath();
    ctx.moveTo(baseX, tipY + earHeight * 0.16);
    ctx.lineTo(
      baseX + Math.sin(angle) * height * 0.17,
      tipY - Math.cos(angle) * height * 0.11 + earHeight * 0.1,
    );
    ctx.stroke();
  }

  // Grains : trois colonnes. Les latérales portent le fuseau, la centrale —
  // décalée d'un demi-pas — comble le creux qui, sinon, fait lire l'épi comme
  // un anneau. Parcours du bas vers le haut : chaque étage recouvre le précédent.
  const levels = 9;
  const step = earHeight / (levels + 0.5);
  const maxSpread = height * 0.072;
  const top = tipY + earHeight * 0.1;

  for (let i = levels - 1; i >= 0; i -= 1) {
    const t = i / (levels - 1); // 0 = sommet, 1 = base
    const envelope = Math.sin(Math.PI * (0.2 + 0.66 * t)); // fuseau
    const y = top + step * i;
    const rx = 13 * s * (0.66 + 0.44 * envelope);
    const ry = step * 0.78;

    if (i < levels - 1) {
      drawGrain(ctx, baseX, y + step * 0.5, rx * 0.92, ry, 0);
    }
    drawGrain(ctx, baseX - maxSpread * envelope, y, rx, ry, -0.32);
    drawGrain(ctx, baseX + maxSpread * envelope, y, rx, ry, 0.32);
  }

  // Grain de tête, qui ferme la pointe
  drawGrain(ctx, baseX, tipY + earHeight * 0.035, 11 * s, step * 0.85, 0);
}

/** Avatar carré, composé pour un rognage circulaire par Discord. */
export async function renderBrandAvatar(size = 512): Promise<Buffer> {
  const { canvas, ctx } = newCanvas(size, size);
  const cx = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cx, size / 2, 0, Math.PI * 2);
  ctx.clip();

  const sky = ctx.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, BRAND.skyTop);
  sky.addColorStop(0.52, BRAND.skyMid);
  sky.addColorStop(0.72, BRAND.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, size, size);

  drawSun(ctx, size * 0.755, size * 0.25, size * 0.1);
  drawHills(ctx, size, size * 0.6, size);
  drawWheat(ctx, cx, size * 0.9, size * 0.74);

  // Vignette : recentre le regard et détache le disque d'un fond clair
  const vignette = ctx.createRadialGradient(cx, cx, size * 0.3, cx, cx, size * 0.52);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(10,20,35,0.28)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();

  // Anneau de contour, dessiné hors du clip pour rester net
  ctx.beginPath();
  ctx.arc(cx, cx, size / 2 - size * 0.014, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = size * 0.028;
  ctx.stroke();

  return encode(canvas);
}

/** Écrit un texte avec un interlettrage manuel (canvas n'expose pas letterSpacing). */
function drawTracked(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): number {
  let cursor = x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  }
  return cursor - tracking - x;
}

function measureTracked(ctx: SKRSContext2D, text: string, tracking: number): number {
  let width = 0;
  for (const char of text) width += ctx.measureText(char).width + tracking;
  return width - tracking;
}

/** Bannière de profil Discord (680 × 240 par défaut). */
export async function renderBrandBanner(
  width = 680,
  height = 240,
  options: { name?: string; tagline?: string } = {},
): Promise<Buffer> {
  const name = options.name ?? 'HARVESTER';
  const tagline = options.tagline ?? 'Sow · Harvest · Prosper';
  const { canvas, ctx } = newCanvas(width, height);

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, BRAND.ink);
  sky.addColorStop(0.55, '#24405e');
  sky.addColorStop(1, '#3c6b52');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Soleil calé en haut à droite, au-dessus de la ligne des épis : posé plus bas
  // il passait derrière l'épi central, et les deux formes rondes se mangeaient.
  drawSun(ctx, width * 0.955, height * 0.185, height * 0.085);

  // Collines sombres : la bannière sert de fond à du texte, elle doit rester
  // nettement plus sombre que l'avatar.
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#356647';
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.quadraticCurveTo(width * 0.4, height * 0.62, width, height * 0.78);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#48865a';
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.quadraticCurveTo(width * 0.55, height * 0.83, width, height * 0.92);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Épis décoratifs à droite, en retrait pour ne pas concurrencer le texte
  ctx.save();
  ctx.globalAlpha = 0.95;
  drawWheat(ctx, width * 0.8, height * 1.02, height * 0.62);
  ctx.globalAlpha = 0.5;
  drawWheat(ctx, width * 0.9, height * 1.06, height * 0.5);
  drawWheat(ctx, width * 0.71, height * 1.06, height * 0.44);
  ctx.restore();

  // Wordmark
  const titleSize = Math.round(height * 0.225);
  const tracking = titleSize * 0.09;
  ctx.font = font(titleSize, 'bold');
  ctx.fillStyle = BRAND.text;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = height * 0.05;
  const titleY = height * 0.3;
  drawTracked(ctx, name, width * 0.075, titleY, tracking);
  ctx.shadowBlur = 0;

  // Filet doré, calé sur la largeur exacte du wordmark
  const titleWidth = measureTracked(ctx, name, tracking);
  ctx.fillStyle = BRAND.sun;
  roundRect(ctx, width * 0.075, titleY + titleSize * 1.22, titleWidth, height * 0.022, height * 0.011);
  ctx.fill();

  ctx.font = font(Math.round(height * 0.082));
  ctx.fillStyle = BRAND.textMuted;
  ctx.fillText(tagline, width * 0.075, titleY + titleSize * 1.55);

  return encode(canvas);
}
