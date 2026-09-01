import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { cropForms } from '../src/config/gameplay/schemas';
import { fitFont, newCanvas } from '../src/render/canvas';
import { cropSkin } from '../src/render/sprites';

/**
 * L'apparence des cultures est une DONNÉE, pas du code : ces tests empêchent
 * qu'une culture ajoutée plus tard retombe silencieusement sur la silhouette
 * générique — le défaut exact qu'on vient de corriger, où les 27 cultures se
 * ressemblaient toutes.
 */
describe('apparence des cultures', () => {
  const config = getConfig('fr');

  it('chaque culture déclare une forme connue et une palette complète', () => {
    const incomplete: string[] = [];
    for (const crop of config.cropList) {
      const palette = crop.palette;
      if (!palette) {
        incomplete.push(`${crop.key} : palette absente`);
        continue;
      }
      for (const [channel, value] of Object.entries(palette)) {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
          incomplete.push(`${crop.key}.${channel} = ${value}`);
        }
      }
      if (!cropForms.includes(crop.form)) incomplete.push(`${crop.key} : forme ${crop.form}`);
    }
    expect(incomplete).toEqual([]);
  });

  it('les fruits ne sont pas de la même couleur que le feuillage', () => {
    // Un fruit de la teinte exacte des feuilles serait invisible sur la plante.
    const invisible = config.cropList
      .filter((crop) => crop.palette && crop.palette.fruit === crop.palette.leaf)
      .map((crop) => crop.key);
    expect(invisible).toEqual([]);
  });

  it('toutes les formes prévues sont réellement utilisées', () => {
    const used = new Set(config.cropList.map((crop) => crop.form));
    // Une forme déclarée mais jamais employée est du code de dessin mort.
    expect([...cropForms].filter((form) => !used.has(form))).toEqual([]);
  });

  it('une culture sans palette retombe sur une apparence neutre valide', () => {
    const skin = cropSkin(undefined);
    expect(skin.form).toBe('bush');
    expect(skin.leaf).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(cropSkin({ form: 'vine' }).form).toBe('vine');
  });

  it('la palette de la configuration prime sur le repli', () => {
    const wheat = config.crops.get('wheat');
    expect(wheat).toBeDefined();
    const skin = cropSkin(wheat);
    expect(skin.form).toBe('stalk');
    expect(skin.fruit).toBe(wheat!.palette!.fruit);
  });
});

/**
 * Ces deux cas mesurent du texte : sans police installée, toute largeur vaut 0
 * et il n'y a rien à ajuster. C'est le cas de l'étape de build Docker, qui
 * compile et teste dans une image nue — `fonts-dejavu-core` n'est installée que
 * dans l'image finale. On saute plutôt que d'affirmer une propriété vide.
 */
function fontsAvailable(): boolean {
  const { ctx } = newCanvas(10, 10);
  ctx.font = 'bold 30px sans-serif';
  return ctx.measureText('Ferme').width > 0;
}

describe('ajustement du texte', () => {
  it.skipIf(!fontsAvailable())('réduit la taille plutôt que de tronquer un nom long', () => {
    const { ctx } = newCanvas(400, 100);
    const name = 'Ferme des Trois Chênes';
    ctx.font = 'bold 30px sans-serif';
    const atFullSize = ctx.measureText(name).width;
    // On choisit une largeur que la grande taille dépasse, mais qu'une taille
    // plus petite atteint : c'est exactement le cas que la fonction doit gérer.
    const budget = atFullSize * 0.8;
    const chosen = fitFont(ctx, name, budget, [30, 24, 18, 14]);
    ctx.font = chosen;
    expect(chosen).not.toContain('30px');
    expect(ctx.measureText(name).width).toBeLessThanOrEqual(budget);
  });

  it.skipIf(!fontsAvailable())('renvoie la plus petite taille quand aucune ne suffit — au clip de finir', () => {
    const { ctx } = newCanvas(400, 100);
    const chosen = fitFont(ctx, 'La Très Grande Ferme des Trois Chênes Centenaires', 40, [30, 18, 12]);
    expect(chosen).toContain('12px');
  });

  it('garde la plus grande taille quand le texte tient déjà', () => {
    const { ctx } = newCanvas(400, 100);
    expect(fitFont(ctx, 'Ferme', 300, [30, 24, 18])).toContain('30px');
  });
});
