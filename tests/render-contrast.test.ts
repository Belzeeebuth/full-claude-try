import { describe, expect, it } from 'vitest';
import { PALETTE } from '../src/render/canvas';

/**
 * Contraste des textes dessinés dans les images (constat C-03 de l'audit).
 *
 * Les libellés d'une image ne bénéficient d'aucun réglage côté client — ni
 * thème, ni taille de police, ni mode contraste élevé. La palette est donc le
 * seul levier, et ce test la tient au niveau WCAG 2.x : 4,5:1 pour le texte
 * courant, 3:1 pour les grands titres et chiffres (≥ 24 px, ou ≥ 18,66 px en
 * gras). Les couples viennent des usages réels de `PALETTE` dans `src/render`,
 * relevés à la main : un couple absent d'ici n'est pas garanti.
 */

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`couleur inattendue : ${hex}`);
  const value = match[1]!;
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as unknown as Rgb;
}

/** Luminance relative (WCAG 2.x, sRGB linéarisé). */
function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Ratio de contraste (L1 + 0,05) / (L2 + 0,05), toujours ≥ 1. */
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Couleur résultante d'un aplat semi-transparent posé sur un fond opaque.
 * Les panneaux de la ferme sont des `rgba(...)` : leur teinte réelle dépend
 * de ce qu'il y a dessous, on la calcule donc au lieu de la deviner.
 */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((index) => fg[index]! * alpha + bg[index]! * (1 - alpha)) as unknown as Rgb;
}

const BODY_TEXT = 4.5;
const LARGE_TEXT = 3;

// Panneaux translucides de la ferme, de l'étang et de la mine (`rgba(20,24,33,0.82)`),
// et du compte à rebours (`rgba(20,24,33,0.86)`). Ils flottent sur le ciel ou
// l'herbe, dont la teinte varie avec la saison et le thème : on les compose sur
// du BLANC, plus clair que n'importe quel ciel d'hiver — si le contraste tient
// là, il tient partout.
const WHITE = rgb('#ffffff');
const PANEL_ON_WHITE = over(rgb('#141821'), 0.82, WHITE);
const COUNTDOWN_ON_WHITE = over(rgb('#141821'), 0.86, WHITE);
// Haut du dégradé de fond du classement (`#232a3a` → carte).
const LEADERBOARD_TOP = rgb('#232a3a');
// Ligne du spectateur dans le classement : `rgba(126,200,80,0.22)` sur la carte.
const VIEWER_ROW = over(rgb('#7ec850'), 0.22, rgb(PALETTE.card));
// Barre de progression : fond `rgba(255,255,255,0.12)` sur la carte, et encre
// sombre `rgba(18,22,30,0.92)` sur la partie remplie (voir `progressBar`).
const BAR_BACKGROUND = over(WHITE, 0.12, rgb(PALETTE.card));
const BAR_INK_ON_XP = over(rgb('#12161e'), 0.92, rgb(PALETTE.xp));

interface Pair {
  label: string;
  fg: Rgb;
  bg: Rgb;
  min: number;
}

const PAIRS: Pair[] = [
  // --- Texte courant : libellés, sous-titres, légendes, listes -----------------
  { label: 'texte sur carte', fg: rgb(PALETTE.text), bg: rgb(PALETTE.card), min: BODY_TEXT },
  { label: 'texte atténué sur carte', fg: rgb(PALETTE.textMuted), bg: rgb(PALETTE.card), min: BODY_TEXT },
  { label: 'texte sur carte secondaire', fg: rgb(PALETTE.text), bg: rgb(PALETTE.cardAlt), min: BODY_TEXT },
  { label: 'texte atténué sur carte secondaire', fg: rgb(PALETTE.textMuted), bg: rgb(PALETTE.cardAlt), min: BODY_TEXT },
  { label: 'texte sur panneau translucide (pire cas)', fg: rgb(PALETTE.text), bg: PANEL_ON_WHITE, min: BODY_TEXT },
  { label: 'texte atténué sur panneau translucide (pire cas)', fg: rgb(PALETTE.textMuted), bg: PANEL_ON_WHITE, min: BODY_TEXT },
  { label: 'texte sur haut du classement', fg: rgb(PALETTE.text), bg: LEADERBOARD_TOP, min: BODY_TEXT },
  { label: 'texte atténué sur haut du classement', fg: rgb(PALETTE.textMuted), bg: LEADERBOARD_TOP, min: BODY_TEXT },
  { label: 'texte sur ligne du spectateur', fg: rgb(PALETTE.text), bg: VIEWER_ROW, min: BODY_TEXT },
  { label: 'texte atténué sur ligne du spectateur', fg: rgb(PALETTE.textMuted), bg: VIEWER_ROW, min: BODY_TEXT },
  { label: 'libellé de barre sur fond de barre', fg: rgb(PALETTE.text), bg: BAR_BACKGROUND, min: BODY_TEXT },
  { label: 'libellé de barre sur remplissage XP', fg: BAR_INK_ON_XP, bg: rgb(PALETTE.xp), min: BODY_TEXT },
  // --- Or : monnaies, scores et compte à rebours, en gras de 16 à 20 px ------
  // Trop petit pour la tolérance « grand texte » : on exige le seuil courant.
  { label: 'or sur carte', fg: rgb(PALETTE.gold), bg: rgb(PALETTE.card), min: BODY_TEXT },
  { label: 'or sur carte secondaire', fg: rgb(PALETTE.gold), bg: rgb(PALETTE.cardAlt), min: BODY_TEXT },
  { label: 'or sur panneau translucide (pire cas)', fg: rgb(PALETTE.gold), bg: PANEL_ON_WHITE, min: BODY_TEXT },
  { label: 'or sur compte à rebours (pire cas)', fg: rgb(PALETTE.gold), bg: COUNTDOWN_ON_WHITE, min: BODY_TEXT },
  // --- Couleurs de tendance : prix et variation du graphique, 18 px gras -----
  // Un chiffre, mis en évidence par sa couleur ET par la flèche ▲/▼ : la
  // tolérance « grand texte » s'applique.
  { label: 'hausse sur carte (prix du graphique)', fg: rgb(PALETTE.success), bg: rgb(PALETTE.card), min: LARGE_TEXT },
  { label: 'baisse sur carte (prix du graphique)', fg: rgb(PALETTE.danger), bg: rgb(PALETTE.card), min: LARGE_TEXT },
];

describe('contraste WCAG de la palette de rendu', () => {
  it('calcule le ratio de référence (auto-contrôle)', () => {
    // Sans ce contrôle, une formule fausse rendrait tous les couples verts.
    expect(contrast(rgb('#000000'), rgb('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(rgb('#777777'), rgb('#777777'))).toBe(1);
    // Exemple canonique de WCAG : le gris #767676 sur blanc passe tout juste 4,5:1.
    expect(contrast(rgb('#767676'), WHITE)).toBeGreaterThan(4.5);
    expect(contrast(rgb('#777777'), WHITE)).toBeLessThan(4.5);
  });

  it.each(PAIRS)('$label ≥ $min:1', ({ fg, bg, min }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
