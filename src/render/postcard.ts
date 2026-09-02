import { balance as getBalance, getConfig, type GameConfig } from '../config';
import type { AnimalForm, AnimalPalette } from '../config/gameplay/schemas';
import { translate } from '../i18n';
import { formatCompact, formatNumber } from '../utils/format';
import { clampAltText, joinSentences } from './alt-text';
import {
  clipText,
  drawableText,
  encode,
  font,
  fontFamily,
  newCanvas,
  verticalGradient,
  withDropShadow,
  type Canvas,
  type SKRSContext2D,
} from './canvas';
import {
  drawBuilding,
  drawGrass,
  drawSky,
  drawWeatherOverlay,
  seasonPalette,
  seedFrom,
  seededRandom,
} from './scenery';
import {
  animalSkin,
  cropSkin,
  drawAnimal,
  drawAnimalForm,
  drawBed,
  drawCrop,
  drawWeatherIcon,
} from './sprites';

/**
 * Carte postale de la ferme (`/postcard`) : une image faite pour être MONTRÉE,
 * pas pour être lue.
 *
 * `/farm` est un tableau de bord — compteurs, pastilles, compte à rebours —
 * et c'est très bien pour jouer. Mais rien ne permettait de partager sa ferme
 * dans un salon sans y coller ces chiffres. La carte postale prend la même
 * scène et en retire tout ce qui est fonctionnel : il reste le champ, les
 * bêtes, les bâtiments, le ciel du jour, dans un tirage photo à bord blanc
 * posé sur un papier chaud, avec un timbre, un cachet et une légende écrite
 * à la main.
 *
 * Trois partis pris :
 *  1. LA SCÈNE EST REDESSINÉE, pas recadrée depuis `renderFarm`. Recycler le
 *     PNG de `/farm` aurait laissé les panneaux, les badges et les numéros de
 *     parcelles dans la « photo » ; les retirer par recadrage aurait coupé le
 *     décor. Le décor commun (`scenery.ts`) et les silhouettes (`sprites.ts`)
 *     sont partagés, donc la carte montre la MÊME ferme que `/farm`.
 *  2. LE FORMAT EST FIXE (`balance.render.postcard`). Une 3×3 et une 8×8
 *     donnent la même carte : la scène s'adapte au tirage, jamais l'inverse.
 *  3. TOUT EST DÉTERMINISTE. Bord déchiqueté, fibres du papier, inclinaison
 *     du tirage, position des bêtes : tout est semé sur l'identifiant de
 *     ferme. Même entrée, même PNG — le cache d'images en dépend.
 *
 * L'entrée est un objet SIMPLE (chaînes, nombres, booléens, `Date`) : elle
 * traverse `postMessage` vers le worker de rendu sans rien perdre.
 */

/** Longueur maximale d'une légende, en points de code, APRÈS nettoyage. */
export const CAPTION_MAX_LENGTH = 60;

export interface PostcardPlot {
  slot: number;
  x: number;
  y: number;
  /** Une parcelle verrouillée n'est pas dessinée : l'herbe la remplace. */
  locked: boolean;
  fertility: number;
  crop: {
    key: string;
    /** 1 à 5, comme les cinq stades du moteur (voir `growthStageIndex`). */
    stage: number;
    ready: boolean;
    withered: boolean;
  } | null;
}

export interface PostcardAnimal {
  animalKey: string;
  emoji: string;
  /** Silhouette et palette de `animals.json` ; `null` → silhouette générique. */
  form: AnimalForm | null;
  palette: AnimalPalette | null;
}

/** Sujet du timbre : la culture ou l'animal préféré du fermier. */
export interface PostcardStamp {
  kind: 'crop' | 'animal';
  key: string;
}

export interface PostcardRenderInput {
  /** Langue du spectateur. Toute chaîne dessinée en dépend. */
  locale: string;
  farmId: string;
  farmName: string;
  farmer: {
    name: string;
    level: number;
    prestige: number;
    /** `null` quand le joueur a une ferme privée : la carte ne montre pas les pièces. */
    coins: number | null;
  };
  /** Légende déjà nettoyée par `sanitizeCaption` ; vide → salutation par défaut. */
  caption: string;
  /** Jour du cachet postal. */
  date: Date;
  /** Fuseau du fermier, pour que le cachet porte SA date et non celle du serveur. */
  timezone: string;
  season: string;
  weather: { weather: string; label: string; temperature: number };
  grid: { width: number; height: number };
  plots: PostcardPlot[];
  animals: PostcardAnimal[];
  buildings: Array<{ key: string; tier: number }>;
  /** `null` → une culture de saison prise dans le catalogue. */
  stamp: PostcardStamp | null;
}

// ---------------------------------------------------------------------------
// FONCTIONS PURES — testables sans canvas
// ---------------------------------------------------------------------------

/**
 * Nettoie une légende saisie par le joueur.
 *
 * La légende est dessinée dans l'image et reprise dans le texte alternatif :
 * un lien ou une mention n'y sert donc à rien — mais une carte est PUBLIQUE,
 * et une capture d'écran d'un `@everyone` ou d'un lien d'invitation en
 * pleine image ferait un joli support de spam. On retire donc, dans l'ordre :
 * les retours à la ligne (une légende tient sur une ligne écrite à la main),
 * les caractères invisibles, les mentions, les liens, le markdown, puis on
 * borne la longueur en points de code pour ne jamais couper un emoji en deux.
 */
export function sanitizeCaption(raw: string | null | undefined): string {
  if (!raw) return '';
  let text = raw.normalize('NFC');

  // Retours à la ligne et tabulations : une seule ligne, sans exception.
  text = text.replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ');
  // Caractères de contrôle, espaces de largeur nulle, marques bidi et BOM :
  // invisibles à l'écran, mais capables de retourner un texte ou de contourner
  // les filtres qui suivent.
  // eslint-disable-next-line no-control-regex -- ce sont précisément ces caractères que l'on retire
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '');
  // Mentions Discord : <@id>, <@!id>, <@&id>, <#id>, @everyone, @here.
  text = text.replace(/<[@#][!&]?\d+>/g, '');
  text = text.replace(/@(?:everyone|here)\b/gi, '');
  // Liens : schéma explicite, www., puis tout ce qui ressemble à domaine.tld.
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '');
  text = text.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/\S*)?/gi, '');
  // Markdown : gras, italique, barré, code, spoiler, échappements, puis
  // citations et titres en début de ligne.
  text = text.replace(/[*_~`|\\]/g, '');
  text = text.replace(/^[\s>#]+/, '');
  // Les « @ » restants n'ont plus de cible ; on les retire pour qu'aucune
  // capture d'écran ne ressemble à une mention.
  text = text.replace(/@/g, '');

  text = text.replace(/\s+/g, ' ').trim();

  const chars = Array.from(text);
  if (chars.length > CAPTION_MAX_LENGTH) {
    text = chars.slice(0, CAPTION_MAX_LENGTH).join('').trimEnd();
  }
  return text;
}

/** Index de stade (1 à 5) d'un `GrowthStage` du moteur, pour `drawCrop`. */
export function growthStageIndex(stage: string): number {
  return STAGE_INDEX[stage] ?? 1;
}

const STAGE_INDEX: Record<string, number> = {
  planted: 1,
  sprouting: 2,
  growing: 3,
  maturing: 4,
  ready: 5,
  withered: 5,
};

/**
 * Choisit le sujet du timbre : la culture la plus plantée, sinon l'espèce la
 * plus nombreuse. Ex æquo départagés par l'ordre d'apparition, donc stable.
 * `null` si la ferme est vide — le rendu prend alors une culture de saison.
 */
export function pickStampSubject(
  plots: ReadonlyArray<Pick<PostcardPlot, 'locked' | 'crop'>>,
  animals: ReadonlyArray<Pick<PostcardAnimal, 'animalKey'>>,
): PostcardStamp | null {
  const crop = mostFrequent(
    plots
      .filter((plot) => !plot.locked && plot.crop && !plot.crop.withered)
      .map((plot) => plot.crop!.key),
  );
  if (crop) return { kind: 'crop', key: crop };
  const animal = mostFrequent(animals.map((entry) => entry.animalKey));
  return animal ? { kind: 'animal', key: animal } : null;
}

function mostFrequent(keys: string[]): string | null {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Date du cachet, dans la langue et le fuseau du fermier : « 2 sept. 2026 »
 * en français, « Sep 2, 2026 » en anglais. Un fuseau inconnu retombe sur
 * l'heure du serveur plutôt que de faire échouer toute la carte.
 */
export function postmarkDate(date: Date, locale: string, timezone: string): string {
  const tag = locale.startsWith('en') ? 'en-US' : 'fr-FR';
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    return date.toLocaleDateString(tag, { ...options, timeZone: timezone });
  } catch {
    return date.toLocaleDateString(tag, options);
  }
}

// ---------------------------------------------------------------------------
// RENDU
// ---------------------------------------------------------------------------

/** Encre du cachet, de la légende et des lignes : un bleu-noir de stylo. */
const INK = '#2f3a5c';
const INK_SOFT = 'rgba(47,58,92,0.78)';
const INK_FAINT = 'rgba(47,58,92,0.30)';
const PAPER_TOP = '#f8eed8';
const PAPER_BOTTOM = '#eddcb7';
const PRINT_WHITE = '#fcf9f1';

/** Police du projet en italique : l'« écriture manuscrite » de la carte. */
function scriptFont(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `italic ${weight} ${size}px ${fontFamily()}`;
}

interface StampSubject {
  kind: 'crop' | 'animal';
  key: string;
  name: string;
}

/**
 * Résout le sujet du timbre dans le catalogue. Un sujet absent (culture
 * retirée du jeu) ou `null` retombe sur la première culture de la saison :
 * un timbre doit toujours porter quelque chose.
 */
function resolveStamp(input: PostcardRenderInput, catalog: GameConfig): StampSubject | null {
  if (input.stamp?.kind === 'crop') {
    const crop = catalog.crops.get(input.stamp.key);
    if (crop) return { kind: 'crop', key: crop.key, name: crop.name };
  }
  if (input.stamp?.kind === 'animal') {
    const animal = catalog.animals.get(input.stamp.key);
    if (animal) return { kind: 'animal', key: animal.key, name: animal.name };
  }
  const seasonal =
    catalog.cropList.find((crop) => crop.enabled && crop.seasons.includes(input.season as never)) ??
    catalog.cropList[0];
  return seasonal ? { kind: 'crop', key: seasonal.key, name: seasonal.name } : null;
}

export async function renderPostcard(input: PostcardRenderInput): Promise<Buffer> {
  const dims = getBalance().render.postcard;
  const catalog = getConfig(input.locale);
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
  const random = seededRandom(seedFrom(input.farmId));

  const { canvas, ctx } = newCanvas(dims.width, dims.height);
  const width = dims.width;
  const height = dims.height;

  drawPaper(ctx, width, height, random);

  // --- Le tirage photo, à gauche ------------------------------------------
  // La moitié gauche de la carte pour la photo : c'est elle qu'on partage.
  // Le tirage est presque carré (10 × 9) : la grille de parcelles l'est, et
  // un format 3:2 laissait un champ minuscule entre deux bandes d'herbe vide
  // dès qu'on dépassait 5 × 5 — la hauteur est la ressource rare, on la prend.
  const sceneWidth = Math.round(width * 0.52);
  const sceneHeight = Math.round(sceneWidth * 0.9);
  const scene = drawScene(input, catalog, sceneWidth, sceneHeight);
  const printCenterX = Math.round(width * 0.33);
  const printCenterY = Math.round(height * 0.485);
  // Inclinaison légère et semée : entre −2,6° et −1,4°, comme une photo
  // glissée sous un coin de ruban.
  const tilt = -(0.024 + random() * 0.021);
  drawPrint(ctx, scene, printCenterX, printCenterY, sceneWidth, sceneHeight, 14, tilt, random);

  // --- Le côté « écrit », à droite ----------------------------------------
  const columnX = Math.round(width * 0.655);
  const columnRight = width - 44;
  const columnWidth = columnRight - columnX;

  // Séparateur vertical d'une carte postale classique.
  ctx.strokeStyle = INK_FAINT;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(columnX - 22, 64);
  ctx.lineTo(columnX - 22, height - 60);
  ctx.stroke();

  // Timbre en haut à droite, puis cachet PAR-DESSUS, comme à la poste.
  const stampWidth = 104;
  const stampHeight = 124;
  const stampX = columnRight - stampWidth + 4;
  const stampY = 44;
  const stamp = resolveStamp(input, catalog);
  drawStamp(ctx, {
    x: stampX,
    y: stampY,
    width: stampWidth,
    height: stampHeight,
    tilt: 0.04 + random() * 0.03,
    season: input.season,
    seasonLabel: drawableText(t(`world.season.${input.season}`)),
    brand: t('render.postcard.brand'),
    level: input.farmer.level,
    subject: stamp,
    catalog,
  });
  drawPostmark(ctx, {
    cx: stampX - 46,
    cy: stampY + 72,
    radius: 56,
    brand: t('render.postcard.brand'),
    farmName: input.farmName,
    date: postmarkDate(input.date, locale, input.timezone),
    // Les ondulations barrent le timbre et s'arrêtent AVANT le filet du
    // bord : une oblitération qui sort de la carte trahit le dessin.
    cancelEndX: width - 34,
  });

  // Légende manuscrite : au plus trois lignes, la taille se réduit avant de
  // couper — une légende de 60 caractères doit toujours tenir entière.
  // Sans police d'emoji, une légende faite uniquement d'emoji se vide au
  // dessin : on retombe alors sur la salutation plutôt que sur un blanc.
  const drawnCaption = drawableText(input.caption);
  const caption = drawnCaption.length > 0 ? drawnCaption : drawableText(t('render.postcard.greeting'));
  const captionTop = stampY + stampHeight + 68;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  let captionLines: string[] = [caption];
  for (const size of [29, 27, 25, 23, 21, 19, 17]) {
    ctx.font = scriptFont(size);
    captionLines = wrapWords(ctx, caption, columnWidth);
    if (captionLines.length <= 3) break;
  }
  const captionLineHeight = Math.round(Number.parseInt(ctx.font.match(/(\d+)px/)?.[1] ?? '21', 10) * 1.32);
  let cursorY = captionTop;
  for (const line of captionLines.slice(0, 3)) {
    ctx.fillText(clipText(ctx, line, columnWidth), columnX, cursorY);
    cursorY += captionLineHeight;
  }

  // Signature, alignée à droite comme au bas d'une lettre. Un pseudo Discord
  // peut faire 32 caractères : on réduit la plume avant de couper le nom.
  const signature = drawableText(t('render.postcard.signature', { name: input.farmer.name }));
  for (const size of [24, 22, 20, 18]) {
    ctx.font = scriptFont(size, 'bold');
    if (ctx.measureText(signature).width <= columnWidth) break;
  }
  ctx.fillStyle = INK;
  ctx.textAlign = 'right';
  ctx.fillText(clipText(ctx, signature, columnWidth), columnRight, cursorY + 10);
  ctx.textAlign = 'left';

  // « Adresse » : trois lignes réglées en bas à droite, comme sur le dos
  // d'une vraie carte. On y écrit le niveau, la météo et — si la ferme n'est
  // pas privée — les pièces.
  const lines: Array<{ text: string; icon?: string; bold?: boolean }> = [
    {
      text: [
        t('render.postcard.level', { level: input.farmer.level }),
        input.farmer.prestige > 0 ? t('render.postcard.prestige', { rank: input.farmer.prestige }) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      bold: true,
    },
    {
      text: t('render.postcard.weather', {
        weather: weatherLabel(input, t),
        temperature: input.weather.temperature,
        season: t(`world.season.${input.season}`),
      }),
      icon: input.weather.weather,
    },
  ];
  if (input.farmer.coins !== null) {
    lines.push({ text: t('render.postcard.coins', { coins: formatCompact(input.farmer.coins, locale) }) });
  }
  const addressBottom = height - 78;
  const addressGap = 40;
  let lineY = addressBottom - addressGap * (lines.length - 1);
  for (const line of lines) {
    ctx.strokeStyle = INK_FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(columnX, lineY + 26);
    ctx.lineTo(columnRight, lineY + 26);
    ctx.stroke();

    let textX = columnX + 4;
    if (line.icon) {
      drawWeatherIcon(ctx, columnX, lineY - 4, 30, line.icon);
      textX = columnX + 38;
    }
    ctx.font = line.bold ? font(19, 'bold') : font(17);
    ctx.fillStyle = INK_SOFT;
    ctx.fillText(clipText(ctx, drawableText(line.text), columnRight - textX), textX, lineY);
    lineY += addressGap;
  }

  // Mention imprimée en pied de carte : l'éditeur, le lieu, la date.
  ctx.font = font(12);
  ctx.fillStyle = INK_FAINT;
  ctx.textAlign = 'center';
  const imprint = t('render.postcard.imprint', {
    farm: input.farmName,
    date: postmarkDate(input.date, locale, input.timezone),
  });
  ctx.fillText(clipText(ctx, drawableText(imprint).toUpperCase(), width - 160), width / 2, height - 36);
  ctx.textAlign = 'left';

  return encode(canvas);
}

/** Libellé météo traduit ; le libellé (français) de la configuration en repli. */
function weatherLabel(
  input: PostcardRenderInput,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const key = `world.weather.${input.weather.weather}`;
  const label = t(key);
  return label === key ? input.weather.label : label;
}

/** Découpe en lignes sur les espaces ; un mot trop long reste entier (clip à l'appel). */
function wrapWords(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// PAPIER
// ---------------------------------------------------------------------------

/**
 * Papier chaud, légèrement texturé : un dégradé diagonal, un voile plus sombre
 * vers les bords, et des fibres semées — jamais de bruit non semé, l'image
 * doit être identique d'un rendu à l'autre. Deux filets d'encre encadrent la
 * carte, comme sur les cartes imprimées d'autrefois.
 */
function drawPaper(ctx: SKRSContext2D, width: number, height: number, random: () => number): void {
  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, PAPER_TOP);
  base.addColorStop(1, PAPER_BOTTOM);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Fibres : traits courts et pâles, dans deux directions dominantes.
  for (let index = 0; index < 900; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const length = 6 + random() * 18;
    const angle = (random() < 0.5 ? 0.15 : 1.35) + (random() - 0.5) * 0.5;
    ctx.strokeStyle = random() < 0.5 ? 'rgba(120,90,50,0.055)' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  // Voile de bord : le centre reste clair, les coins se patinent.
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.3,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(120,80,30,0)');
  vignette.addColorStop(1, 'rgba(120,80,30,0.16)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(90,60,30,0.30)';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(18.5, 18.5, width - 37, height - 37);
  ctx.strokeStyle = 'rgba(90,60,30,0.16)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(23.5, 23.5, width - 47, height - 47);
}

// ---------------------------------------------------------------------------
// SCÈNE — la ferme sans son tableau de bord
// ---------------------------------------------------------------------------

function drawScene(
  input: PostcardRenderInput,
  catalog: GameConfig,
  width: number,
  height: number,
): Canvas {
  const { canvas, ctx } = newCanvas(width, height);
  const palette = seasonPalette(input.season);
  const weather = input.weather.weather;
  const random = seededRandom(seedFrom(`${input.farmId}:scene`));
  const wet = weather === 'rainy' || weather === 'storm';

  const horizon = Math.round(height * 0.19);
  drawSky(ctx, width, horizon, palette, weather);
  drawGrass(ctx, width, horizon, height, palette);

  // --- Géométrie : la grille s'adapte au tirage ---------------------------
  // La hauteur est la ressource rare : le tirage est en paysage et la grille
  // carrée. Les bâtiments chevauchent donc l'horizon (toit sur le ciel, base
  // sur l'herbe) et les bêtes passent DEVANT la lisse basse de la clôture,
  // pour que les bandes qu'ils occupent restent minces.
  const FENCE = 14;
  const buildings = input.buildings.slice(0, 6);
  const animals = input.animals.slice(0, 6);
  const buildingSize = 54;
  const topBand = buildings.length > 0 ? Math.round(buildingSize * 0.4) + 6 : 12;
  const bottomBand = animals.length > 0 ? 38 : 22;
  const boardTop = horizon + topBand + FENCE;
  const boardBottom = height - bottomBand - FENCE;
  const gridWidth = Math.max(1, input.grid.width);
  const gridHeight = Math.max(1, input.grid.height);
  const tile = Math.max(
    16,
    Math.min(72, Math.floor((width - (FENCE + 18) * 2) / gridWidth), Math.floor((boardBottom - boardTop) / gridHeight)),
  );
  const boardWidth = tile * gridWidth;
  const boardHeight = tile * gridHeight;
  const boardX = Math.round((width - boardWidth) / 2);
  // Centré dans l'espace libre : une petite grille collée à l'horizon
  // laissait toute la moitié basse de la photo en herbe nue.
  const boardY = boardTop + Math.floor((boardBottom - boardTop - boardHeight) / 2);

  // --- Bâtiments à cheval sur l'horizon, derrière la clôture ----------------
  if (buildings.length > 0) {
    const span = width - 70;
    const step = span / buildings.length;
    for (const [index, building] of buildings.entries()) {
      const jitter = (random() - 0.5) * Math.min(24, step * 0.3);
      const x = 35 + step * index + step / 2 - buildingSize / 2 + jitter;
      const y = horizon - buildingSize * 0.6 + (random() - 0.5) * 4;
      drawBuilding(ctx, building.key, x, y, buildingSize);
    }
  }

  // --- Marges : arbres et fleurs, pour qu'une petite ferme ne flotte pas -----
  // Une 3×3 laisse 150 px d'herbe nue de chaque côté du champ ; sur une
  // photo à partager, c'est un vide qui saute aux yeux. Les arbres sont
  // semés (position, taille, forme) et suivent la saison : nus en hiver,
  // roux en automne.
  drawSceneMargins(ctx, {
    width,
    horizon,
    groundBottom: height - bottomBand,
    boardX,
    boardWidth,
    fence: FENCE,
    season: input.season,
    palette,
    random,
  });

  drawSceneFence(ctx, boardX, boardY, boardWidth, boardHeight, FENCE);

  // --- Parcelles : terre et plantes, rien d'autre ---------------------------
  for (const plot of input.plots) {
    if (plot.locked || plot.x >= gridWidth || plot.y >= gridHeight) continue;
    const inset = Math.max(1, Math.round(tile * 0.04));
    const x = boardX + plot.x * tile + inset;
    const y = boardY + plot.y * tile + inset;
    const size = tile - inset * 2;
    drawBed(ctx, x, y, size, { fertility: plot.fertility, wet });
    if (!plot.crop) continue;

    // Une plante peut dépasser vers le haut, jamais sur ses voisines.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 1, y - size * 0.3, size + 2, size * 1.3);
    ctx.clip();
    drawCrop(ctx, {
      x,
      y,
      size,
      stage: Math.min(5, Math.max(1, Math.round(plot.crop.stage))),
      skin: cropSkin(catalog.crops.get(plot.crop.key)),
      ready: plot.crop.ready,
      withered: plot.crop.withered,
      seed: plot.slot,
    });
    ctx.restore();
  }

  // --- Chemin et bêtes au premier plan --------------------------------------
  const pathY = boardY + boardHeight + FENCE + 4;
  ctx.fillStyle = 'rgba(150,120,84,0.42)';
  ctx.fillRect(0, pathY, width, 12);
  ctx.fillStyle = 'rgba(120,95,64,0.28)';
  ctx.fillRect(0, pathY, width, 3);

  if (animals.length > 0) {
    const size = 44;
    const span = width - 60;
    const step = span / animals.length;
    for (const [index, animal] of animals.entries()) {
      const jitter = (random() - 0.5) * Math.min(20, step * 0.3);
      const x = 30 + step * index + step / 2 - size / 2 + jitter;
      // Pieds à 86 % de la boîte : ils se posent à ~12 px du bord bas.
      const y = height - 50 + (random() - 0.5) * 6;
      const skin = animalSkin(animal);
      if (skin) {
        drawAnimalForm(ctx, {
          x,
          y,
          size,
          form: skin.form,
          palette: skin.palette,
          facing: random() < 0.5 ? 1 : -1,
          seed: seedFrom(animal.animalKey) + index,
        });
      } else {
        drawAnimal(ctx, { x, y, size, color: '#e8d8b7', emoji: animal.emoji });
      }
    }
  }

  drawWeatherOverlay(ctx, width, height, weather);

  // Vignettage photographique : les coins du tirage s'assombrissent à peine.
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.35,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.7,
  );
  vignette.addColorStop(0, 'rgba(50,30,10,0)');
  vignette.addColorStop(1, 'rgba(50,30,10,0.22)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}

/** Clôture compacte : deux lisses et des poteaux, sans le relief de `/farm`. */
function drawSceneFence(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  boardWidth: number,
  boardHeight: number,
  margin: number,
): void {
  const left = x - margin;
  const right = x + boardWidth + margin;
  const top = y - margin;
  const bottom = y + boardHeight + margin;
  const rail = '#b08e63';
  const post = '#8a6a45';

  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(left - 4, top - 4, right - left + 8, 4);
  ctx.fillRect(left - 4, bottom, right - left + 8, 4);
  ctx.fillStyle = rail;
  ctx.fillRect(left - 4, top - 7, right - left + 8, 4);
  ctx.fillRect(left - 4, top + 1, right - left + 8, 3);
  ctx.fillRect(left - 4, bottom - 7, right - left + 8, 4);
  ctx.fillRect(left - 4, bottom + 1, right - left + 8, 3);
  ctx.fillRect(left - 3, top - 4, 3, bottom - top + 8);
  ctx.fillRect(right, top - 4, 3, bottom - top + 8);

  ctx.fillStyle = post;
  for (let px = left - 6; px <= right + 2; px += 46) {
    ctx.fillRect(px, top - 12, 6, 20);
    ctx.fillRect(px, bottom - 10, 6, 20);
  }
  for (let py = top + 18; py < bottom - 12; py += 48) {
    ctx.fillRect(left - 6, py, 6, 16);
    ctx.fillRect(right, py, 6, 16);
  }
}

interface MarginOptions {
  width: number;
  horizon: number;
  /** Bas de la zone plantable : au-dessus de la bande des bêtes. */
  groundBottom: number;
  boardX: number;
  boardWidth: number;
  fence: number;
  season: string;
  palette: { grass: string; grassDark: string };
  random: () => number;
}

/**
 * Garnit l'herbe de part et d'autre du champ : un ou deux arbres par côté
 * quand la marge est assez large, et quelques fleurs. Tout est semé : la
 * même ferme a toujours les mêmes arbres au même endroit.
 */
function drawSceneMargins(ctx: SKRSContext2D, options: MarginOptions): void {
  const { random } = options;
  const leftMargin = options.boardX - options.fence - 8;
  const rightStart = options.boardX + options.boardWidth + options.fence + 8;
  const rightMargin = options.width - rightStart;
  const top = options.horizon + 16;
  const bottom = options.groundBottom - 6;

  for (const side of [
    { start: 6, span: leftMargin - 6 },
    { start: rightStart, span: rightMargin - 6 },
  ]) {
    if (side.span < 44) continue;
    // Fleurs d'abord, derrière les arbres.
    const flowers = Math.round((side.span / 18) * (options.season === 'winter' ? 0.3 : 1));
    for (let index = 0; index < flowers; index += 1) {
      const fx = side.start + random() * side.span;
      const fy = top + random() * (bottom - top);
      drawFlower(ctx, fx, fy, options.season, random);
    }
    const trees = side.span >= 110 ? 2 : 1;
    const slot = side.span / trees;
    for (let index = 0; index < trees; index += 1) {
      const size = Math.min(slot - 6, 46 + random() * 26);
      const tx = side.start + slot * index + (slot - size) / 2 + (random() - 0.5) * Math.max(0, slot - size - 6);
      const ty = top + 10 + random() * Math.max(0, bottom - top - size * 1.5 - 10);
      drawTree(ctx, tx, ty, size, options.season, options.palette, random);
    }
  }
}

/** Arbre stylisé : tronc, puis trois masses de feuillage ; nu en hiver, roux en automne. */
function drawTree(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  size: number,
  season: string,
  palette: { grass: string; grassDark: string },
  random: () => number,
): void {
  const trunkWidth = size * 0.16;
  const trunkHeight = size * 0.55;
  const canopyRadius = size * 0.34;
  const cx = x + size / 2;
  const canopyY = y + canopyRadius;

  // Ombre portée au sol, légère.
  ctx.fillStyle = 'rgba(30,40,20,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx + size * 0.08, y + canopyRadius * 2 + trunkHeight * 0.85, size * 0.42, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#6b4a2e';
  ctx.fillRect(cx - trunkWidth / 2, canopyY + canopyRadius * 0.6, trunkWidth, trunkHeight);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(cx + trunkWidth * 0.15, canopyY + canopyRadius * 0.6, trunkWidth * 0.35, trunkHeight);

  if (season === 'winter') {
    // Branches nues : trois traits qui s'ouvrent depuis le tronc.
    ctx.strokeStyle = '#6b4a2e';
    ctx.lineWidth = Math.max(1.5, trunkWidth * 0.4);
    ctx.lineCap = 'round';
    for (const angle of [-0.9, -0.2, 0.55]) {
      ctx.beginPath();
      ctx.moveTo(cx, canopyY + canopyRadius * 0.9);
      ctx.lineTo(cx + Math.sin(angle) * canopyRadius * 1.4, canopyY - Math.cos(angle) * canopyRadius * 1.2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    return;
  }

  const [leaf, leafDark] =
    season === 'autumn'
      ? (['#d98a3a', '#a85f22'] as const)
      : ([palette.grassDark, mixShade(palette.grassDark)] as const);
  const blobs = [
    { dx: -canopyRadius * 0.55, dy: canopyRadius * 0.25, r: canopyRadius * 0.85 },
    { dx: canopyRadius * 0.55, dy: canopyRadius * 0.25, r: canopyRadius * 0.85 },
    { dx: 0, dy: -canopyRadius * 0.2, r: canopyRadius },
  ];
  for (const blob of blobs) {
    const jitter = (random() - 0.5) * canopyRadius * 0.15;
    ctx.fillStyle = leafDark;
    ctx.beginPath();
    ctx.arc(cx + blob.dx + jitter, canopyY + blob.dy + 3, blob.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = leaf;
    ctx.beginPath();
    ctx.arc(cx + blob.dx + jitter, canopyY + blob.dy, blob.r * 0.92, 0, Math.PI * 2);
    ctx.fill();
  }
  // Reflet en haut à gauche : donne le volume.
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.arc(cx - canopyRadius * 0.3, canopyY - canopyRadius * 0.45, canopyRadius * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

/** Assombrit une couleur `#rrggbb` d'un quart, pour l'ombre du feuillage. */
function mixShade(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  const channel = (part: string): string =>
    Math.round(Number.parseInt(part, 16) * 0.72)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(match[1]!)}${channel(match[2]!)}${channel(match[3]!)}`;
}

/** Fleur ou touffe : un point de couleur et deux pétales, selon la saison. */
function drawFlower(ctx: SKRSContext2D, x: number, y: number, season: string, random: () => number): void {
  const colors =
    season === 'winter'
      ? ['#e6eef2', '#d0dde4']
      : season === 'autumn'
        ? ['#e0b04a', '#c96f3c', '#f2e3b4']
        : ['#f6e05e', '#f28cb1', '#ffffff', '#f4a261'];
  const color = colors[Math.floor(random() * colors.length)]!;
  const radius = 1.6 + random() * 1.4;
  ctx.fillStyle = 'rgba(40,80,30,0.35)';
  ctx.fillRect(x - 0.6, y, 1.2, radius * 2.2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// TIRAGE PHOTO À BORD BLANC
// ---------------------------------------------------------------------------

/** Contour rectangulaire dont chaque bord ondule légèrement : un bord déchiqueté de tirage argentique. */
function deckledRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  random: () => number,
): void {
  const step = 16;
  const amplitude = 2.4;
  const wobble = (): number => (random() - 0.5) * amplitude * 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (let px = x + step; px < x + width; px += step) ctx.lineTo(px, y + wobble());
  ctx.lineTo(x + width, y);
  for (let py = y + step; py < y + height; py += step) ctx.lineTo(x + width + wobble(), py);
  ctx.lineTo(x + width, y + height);
  for (let px = x + width - step; px > x; px -= step) ctx.lineTo(px, y + height + wobble());
  ctx.lineTo(x, y + height);
  for (let py = y + height - step; py > y; py -= step) ctx.lineTo(x + wobble(), py);
  ctx.closePath();
}

function drawPrint(
  ctx: SKRSContext2D,
  scene: Canvas,
  cx: number,
  cy: number,
  sceneWidth: number,
  sceneHeight: number,
  border: number,
  tilt: number,
  random: () => number,
): void {
  const width = sceneWidth + border * 2;
  const height = sceneHeight + border * 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);

  withDropShadow(
    ctx,
    () => {
      deckledRect(ctx, -width / 2, -height / 2, width, height, random);
      ctx.fillStyle = PRINT_WHITE;
      ctx.fill();
    },
    { color: 'rgba(60,40,20,0.40)', blur: 22, offsetY: 10 },
  );

  ctx.drawImage(scene, -sceneWidth / 2, -sceneHeight / 2, sceneWidth, sceneHeight);
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(-sceneWidth / 2 + 0.5, -sceneHeight / 2 + 0.5, sceneWidth - 1, sceneHeight - 1);

  // Deux bouts de ruban adhésif, aux coins opposés.
  drawTape(ctx, -width / 2 + 26, -height / 2 + 4, -Math.PI / 4);
  drawTape(ctx, width / 2 - 26, height / 2 - 4, -Math.PI / 4);
  ctx.restore();
}

function drawTape(ctx: SKRSContext2D, x: number, y: number, angle: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(232,214,170,0.70)';
  ctx.fillRect(-34, -11, 68, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-34, -11, 68, 3);
  ctx.strokeStyle = 'rgba(120,90,50,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(-34, -11, 68, 22);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// TIMBRE
// ---------------------------------------------------------------------------

interface StampOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  tilt: number;
  season: string;
  seasonLabel: string;
  brand: string;
  level: number;
  subject: StampSubject | null;
  catalog: GameConfig;
}

/**
 * Timbre dentelé. Il est dessiné sur une toile à part pour que les dents
 * soient de vrais trous (composition `destination-out`) : le papier texturé
 * apparaît au travers, ce qu'un disque de couleur unie n'aurait pas imité.
 */
function drawStamp(ctx: SKRSContext2D, options: StampOptions): void {
  const pad = 6;
  const { canvas: layer, ctx: sctx } = newCanvas(options.width + pad * 2, options.height + pad * 2);
  const x = pad;
  const y = pad;
  const { width, height } = options;

  sctx.fillStyle = '#fbfaf4';
  sctx.fillRect(x, y, width, height);

  // Vignette intérieure : ciel de la saison, bande d'herbe, sujet au centre.
  const inset = 8;
  const innerX = x + inset;
  const innerY = y + inset;
  const innerWidth = width - inset * 2;
  const innerHeight = height - inset * 2;
  const palette = seasonPalette(options.season);
  sctx.fillStyle = verticalGradient(sctx, innerX, innerY, innerHeight, palette.skyTop, palette.skyBottom);
  sctx.fillRect(innerX, innerY, innerWidth, innerHeight);
  const groundY = innerY + innerHeight * 0.72;
  sctx.fillStyle = verticalGradient(sctx, innerX, groundY, innerY + innerHeight - groundY, palette.grass, palette.grassDark);
  sctx.fillRect(innerX, groundY, innerWidth, innerY + innerHeight - groundY);

  const subject = options.subject;
  if (subject) {
    const size = Math.round(innerWidth * 0.66);
    const sx = innerX + (innerWidth - size) / 2;
    if (subject.kind === 'crop') {
      // `drawCrop` pose la base de la plante à 80 % de sa boîte.
      drawCrop(sctx, {
        x: sx,
        y: groundY - size * 0.8,
        size,
        stage: 5,
        skin: cropSkin(options.catalog.crops.get(subject.key)),
        ready: true,
        withered: false,
        seed: 3,
      });
    } else {
      const skin = animalSkin(options.catalog.animals.get(subject.key));
      // `drawAnimalForm` pose les pieds à 86 % de sa boîte.
      const sy = groundY - size * 0.86;
      if (skin) {
        drawAnimalForm(sctx, { x: sx, y: sy, size, form: skin.form, palette: skin.palette, seed: 5 });
      } else {
        drawAnimal(sctx, { x: sx, y: sy, size, color: '#e8d8b7', emoji: '' });
      }
    }
  }

  // Cadre, marque en haut, saison en bas, valeur faciale = niveau.
  sctx.strokeStyle = 'rgba(40,40,60,0.55)';
  sctx.lineWidth = 1.2;
  sctx.strokeRect(innerX + 0.5, innerY + 0.5, innerWidth - 1, innerHeight - 1);

  // Marque en haut à gauche et valeur faciale (le niveau) en haut à droite,
  // comme sur un vrai timbre ; la saison seule en bas, centrée. Les trois
  // sur la même ligne se chevauchaient dès que la saison s'appelait
  // « PRINTEMPS ».
  sctx.textAlign = 'left';
  sctx.fillStyle = 'rgba(30,30,50,0.85)';
  sctx.font = font(8, 'bold');
  sctx.fillText(clipText(sctx, options.brand, innerWidth - 28), innerX + 5, innerY + 4);
  sctx.textAlign = 'right';
  sctx.font = font(13, 'bold');
  sctx.fillStyle = '#fbfaf4';
  sctx.strokeStyle = 'rgba(30,30,50,0.6)';
  sctx.lineWidth = 2;
  sctx.strokeText(String(options.level), innerX + innerWidth - 5, innerY + 3);
  sctx.fillText(String(options.level), innerX + innerWidth - 5, innerY + 3);
  sctx.textAlign = 'center';
  sctx.font = font(9, 'bold');
  sctx.fillStyle = '#fbfaf4';
  sctx.fillText(
    clipText(sctx, options.seasonLabel.toUpperCase(), innerWidth - 10),
    innerX + innerWidth / 2,
    innerY + innerHeight - 14,
  );
  sctx.textAlign = 'left';

  // Dentelure : des trous ronds à cheval sur le bord.
  sctx.globalCompositeOperation = 'destination-out';
  const holeRadius = 2.8;
  const pitch = 7.5;
  const countX = Math.round(width / pitch);
  const countY = Math.round(height / pitch);
  for (let index = 0; index <= countX; index += 1) {
    const hx = x + (width / countX) * index;
    sctx.beginPath();
    sctx.arc(hx, y, holeRadius, 0, Math.PI * 2);
    sctx.arc(hx, y + height, holeRadius, 0, Math.PI * 2);
    sctx.fill();
  }
  for (let index = 0; index <= countY; index += 1) {
    const hy = y + (height / countY) * index;
    sctx.beginPath();
    sctx.arc(x, hy, holeRadius, 0, Math.PI * 2);
    sctx.arc(x + width, hy, holeRadius, 0, Math.PI * 2);
    sctx.fill();
  }
  sctx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.translate(options.x + width / 2, options.y + height / 2);
  ctx.rotate(options.tilt);
  withDropShadow(
    ctx,
    () => ctx.drawImage(layer, -width / 2 - pad, -height / 2 - pad),
    { color: 'rgba(60,40,20,0.30)', blur: 8, offsetY: 3 },
  );
  ctx.restore();
}

// ---------------------------------------------------------------------------
// CACHET POSTAL
// ---------------------------------------------------------------------------

interface PostmarkOptions {
  cx: number;
  cy: number;
  radius: number;
  brand: string;
  farmName: string;
  date: string;
  /** Abscisse où s'arrêtent les lignes d'oblitération, qui partent du cachet vers la droite. */
  cancelEndX: number;
}

/**
 * Cachet rond à l'encre : la marque en arc supérieur, le nom de la ferme en
 * arc inférieur, la date au centre, et les ondulations d'oblitération qui
 * barrent le timbre. L'encre est semi-transparente : un cachet est toujours
 * un peu pâle, et le timbre doit rester lisible dessous.
 */
function drawPostmark(ctx: SKRSContext2D, options: PostmarkOptions): void {
  const { cx, cy, radius } = options;
  const ink = 'rgba(52,64,104,0.82)';

  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 13, 0, Math.PI * 2);
  ctx.stroke();

  // Ondulations : trois lignes qui partent du cachet et traversent le timbre.
  ctx.lineWidth = 2;
  for (const offset of [-14, 0, 14]) {
    ctx.beginPath();
    const startX = cx + Math.sqrt(Math.max(0, radius * radius - offset * offset));
    const length = Math.max(0, options.cancelEndX - startX);
    for (let dx = 0; dx <= length; dx += 2) {
      const px = startX + dx;
      const py = cy + offset + Math.sin(dx / 9) * 3.2;
      if (dx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Textes en arc.
  ctx.fillStyle = ink;
  ctx.font = font(11, 'bold');
  drawArcText(ctx, spaced(options.brand), cx, cy, radius - 6.5, -Math.PI / 2, 'outside');
  ctx.font = font(9, 'bold');
  const arcBudget = (radius - 6.5) * Math.PI * 0.9;
  drawArcText(ctx, clipText(ctx, options.farmName.toUpperCase(), arcBudget), cx, cy, radius - 6.5, Math.PI / 2, 'inside');

  // Date au centre, sur deux lignes : jour et mois, puis année.
  const parts = options.date.split(' ');
  const year = parts.length > 1 ? parts[parts.length - 1]! : '';
  const dayMonth = parts.length > 1 ? parts.slice(0, -1).join(' ') : options.date;
  ctx.textAlign = 'center';
  ctx.font = font(13, 'bold');
  ctx.fillText(clipText(ctx, dayMonth.toUpperCase().replace(/,$/, ''), (radius - 14) * 2), cx, cy - 15);
  ctx.font = font(12, 'bold');
  ctx.fillText(year, cx, cy + 2);
  ctx.textAlign = 'left';
  ctx.restore();
}

/** Espace les lettres d'une marque, faute de `letterSpacing` portable. */
function spaced(text: string): string {
  return Array.from(text).join(' ');
}

/**
 * Écrit un texte le long d'un arc, centré sur `centerAngle`.
 * `outside` : les lettres ont le pied vers le centre (arc supérieur) ;
 * `inside` : le pied vers l'extérieur (arc inférieur), pour se lire à
 * l'endroit dans les deux cas.
 */
function drawArcText(
  ctx: SKRSContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  centerAngle: number,
  side: 'outside' | 'inside',
): void {
  const chars = Array.from(text);
  const widths = chars.map((char) => ctx.measureText(char).width);
  const total = widths.reduce((sum, width) => sum + width, 0);
  const direction = side === 'outside' ? 1 : -1;
  let angle = centerAngle - (direction * (total / radius)) / 2;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [index, char] of chars.entries()) {
    const half = widths[index]! / 2;
    angle += (direction * half) / radius;
    ctx.save();
    ctx.translate(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.rotate(angle + (side === 'outside' ? Math.PI / 2 : -Math.PI / 2));
    ctx.fillText(char, 0, 0);
    ctx.restore();
    angle += (direction * half) / radius;
  }
  ctx.restore();
  ctx.textBaseline = 'top';
}

// ---------------------------------------------------------------------------
// TEXTE ALTERNATIF
// ---------------------------------------------------------------------------

/**
 * Description de la carte pour les lecteurs d'écran : qui l'envoie, ce que
 * dit la légende, le temps qu'il fait, ce que montre la photo, le timbre et
 * la date du cachet. Même entrée que le dessin, aucune horloge : la date est
 * celle de l'entrée, donc la description accompagne aussi une image servie
 * depuis le cache.
 */
export function describePostcard(input: PostcardRenderInput): string {
  const locale = input.locale;
  const t = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);
  const catalog = getConfig(locale);

  const planted = input.plots.filter((plot) => !plot.locked && plot.crop && !plot.crop.withered).length;
  const animals = input.animals.length;
  const buildings = input.buildings.length;
  const stamp = resolveStamp(input, catalog);
  const date = postmarkDate(input.date, locale, input.timezone);

  return clampAltText(
    joinSentences([
      t('render_alt.postcard.header', {
        farm: input.farmName,
        name: input.farmer.name,
        level: input.farmer.level,
      }),
      input.farmer.prestige > 0 ? t('render_alt.postcard.prestige', { rank: input.farmer.prestige }) : null,
      t('render_alt.postcard.caption', {
        caption: input.caption.length > 0 ? input.caption : t('render.postcard.greeting'),
      }),
      t('render_alt.postcard.world', {
        season: t(`world.season.${input.season}`),
        weather: weatherLabel(input, t),
        temperature: input.weather.temperature,
      }),
      planted + animals + buildings > 0
        ? t('render_alt.postcard.scene', { planted, animals, buildings })
        : t('render_alt.postcard.scene_empty'),
      stamp ? t(`render_alt.postcard.stamp_${stamp.kind}`, { subject: stamp.name }) : null,
      t('render_alt.postcard.postmark', { date }),
      input.farmer.coins !== null
        ? t('render_alt.postcard.coins', { coins: formatNumber(input.farmer.coins, locale) })
        : null,
    ]),
  );
}
