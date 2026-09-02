import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { rarities, seasonNames } from '../src/config/gameplay/schemas';

const config = getConfig();
const crops = config.cropList;

/**
 * Contrat de CONTENU du catalogue de cultures — le complément des tests
 * d'équilibrage chiffré (`config-and-balance.test.ts`).
 *
 * Les invariants chiffrés garantissent qu'aucune culture ne casse l'économie ;
 * ceux-ci garantissent que le catalogue reste LISIBLE et COMPLET pour le
 * joueur : une rareté qui annonce le palier, un hiver jouable dès le début,
 * une nouvelle culture à chaque tranche de niveaux. Ils ont été écrits avec
 * l'extension à 41 espèces, pour qu'une extension suivante ne défasse pas ce
 * qui a été comblé.
 */
describe('catalogue des cultures', () => {
  it('donne à chaque culture un emoji qui n\'appartient qu\'à elle', () => {
    // Le menu de plantation et la grille rendue identifient la culture par
    // son emoji : deux cultures au même emoji seraient indiscernables.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const crop of crops) {
      const other = seen.get(crop.emoji);
      if (other) clashes.push(`${crop.key} et ${other} partagent ${crop.emoji}`);
      seen.set(crop.emoji, crop.key);
    }
    expect(clashes).toEqual([]);
  });

  it('ne fait jamais coïncider deux cultures sur le même sortOrder', () => {
    // Le catalogue est trié par sortOrder ; une égalité rendrait l'ordre
    // d'affichage dépendant de l'ordre du fichier, donc fragile.
    const orders = crops.map((crop) => crop.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('fait de la rareté une annonce fiable du palier de niveau', () => {
    // Un joueur lit « rare » comme « plus tard qu'uncommon ». Si une culture
    // rare se débloquait avant une uncommon, l'étiquette mentirait.
    const bands = rarities.map((rarity) => {
      const levels = crops.filter((crop) => crop.rarity === rarity).map((crop) => crop.requiredLevel);
      return { rarity, min: Math.min(...levels), max: Math.max(...levels), count: levels.length };
    });
    for (const band of bands) {
      expect(band.count, `aucune culture ${band.rarity}`).toBeGreaterThan(0);
    }
    for (let index = 1; index < bands.length; index += 1) {
      const lower = bands[index - 1];
      const upper = bands[index];
      if (!lower || !upper) continue;
      expect(
        upper.min,
        `${upper.rarity} (niv. ${upper.min}) se débloque avant la fin de ${lower.rarity} (niv. ${lower.max})`,
      ).toBeGreaterThan(lower.max);
    }
  });

  it('déclare une durée de repousse si et seulement si la culture repousse', () => {
    // `regrowCycles > 0` sans `regrowSeconds` : le moteur retombe sur la durée
    // initiale et la « repousse » n'en est plus une ; l'inverse est une donnée
    // morte qui trompe le lecteur du fichier.
    const inconsistent = crops
      .filter((crop) => (crop.regrowCycles > 0) !== (crop.regrowSeconds > 0))
      .map((crop) => crop.key);
    expect(inconsistent).toEqual([]);
  });

  it('propose dans chaque saison des cultures de début et de milieu de partie', () => {
    // Une saison n'est jouable que si le joueur y trouve quelque chose à
    // planter à SON niveau. L'hiver était le cas limite : hormis la pomme de
    // terre, rien avant le niveau 28.
    const problems: string[] = [];
    for (const season of seasonNames) {
      const inSeason = crops.filter((crop) => crop.seasons.includes(season));
      const early = inSeason.filter((crop) => crop.requiredLevel <= 10).length;
      const mid = inSeason.filter((crop) => crop.requiredLevel > 10 && crop.requiredLevel <= 30).length;
      if (early < 3) problems.push(`${season} : ${early} culture(s) jusqu'au niveau 10`);
      if (mid < 3) problems.push(`${season} : ${mid} culture(s) entre les niveaux 11 et 30`);
    }
    expect(problems).toEqual([]);
  });

  it('offre une repousseuse dans chaque saison', () => {
    // Les cultures à récoltes multiples récompensent la planification ; une
    // saison qui n'en aurait aucune se jouerait uniquement en cycles courts.
    const missing = seasonNames.filter(
      (season) => !crops.some((crop) => crop.seasons.includes(season) && crop.regrowCycles > 0),
    );
    expect(missing).toEqual([]);
  });

  it('ne laisse jamais plus de sept niveaux sans nouvelle culture', () => {
    // Le pilier « aucun mur » : entre deux déblocages, le joueur doit sentir
    // que monter en niveau sert à quelque chose. Sept niveaux est la plus
    // longue attente du catalogue (48 → 55), assumée pour la fin de partie.
    const levels = [...new Set(crops.map((crop) => crop.requiredLevel))].sort((a, b) => a - b);
    const gaps: string[] = [];
    for (let index = 1; index < levels.length; index += 1) {
      const previous = levels[index - 1];
      const current = levels[index];
      if (previous === undefined || current === undefined) continue;
      if (current - previous > 7) gaps.push(`${previous} → ${current}`);
    }
    expect(levels[0]).toBe(1);
    expect(gaps).toEqual([]);
  });

  it('distingue les cultures d\'un même niveau par leur temps de pousse', () => {
    // Deux cultures de même niveau et même durée n'offriraient pas de vrai
    // choix : chacune doit occuper sa propre niche temporelle.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const crop of crops) {
      const signature = `${crop.requiredLevel}:${crop.growthSeconds}`;
      const other = seen.get(signature);
      if (other) duplicates.push(`${crop.key} et ${other}`);
      seen.set(signature, crop.key);
    }
    expect(duplicates).toEqual([]);
  });
});
