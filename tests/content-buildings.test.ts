import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';

/**
 * Contrat de CONTENU des descriptions de bâtiments.
 *
 * La description d'un bâtiment est la seule phrase que le joueur lit avant de
 * dépenser des centaines de milliers de pièces : elle est affichée par
 * `/encyclopedia` (src/commands/world.ts) et par l'autocomplétion de
 * `/buildings build` (src/commands/craft.ts). Elle n'est vérifiée par aucun
 * schéma : rien n'empêche qu'un ajout d'espèce la laisse mentir.
 *
 * Ces tests existent parce que l'Antre (`mythic_pen`) a précisément menti sur
 * les deux points ci-dessous après l'ajout de la licorne (légendaire, 24 000
 * pièces) et du phénix (300 gemmes), tous deux achetables en permanence.
 */
const locales = ['fr', 'en'] as const;

describe('descriptions des bâtiments', () => {
  it('ne promet aucune construction réservée à un événement', () => {
    // `buildOrUpgrade` (src/services/craft.service.ts) ne vérifie que l'état
    // `enabled`, le palier, le niveau, les pièces et les matériaux : aucune
    // garde d'évènement n'existe côté BÂTIMENT (`eventOnly` n'est lu que sur
    // l'animal, dans animal.service.ts). Une description qui invoque un
    // évènement enverrait donc le joueur attendre une condition que rien
    // n'implémente — d'autant que `getActiveEvents` ne retourne aujourd'hui
    // aucun évènement actif (cahier des charges § 1.1).
    const problems: string[] = [];
    for (const locale of locales) {
      for (const building of getConfig(locale).buildingList) {
        if (/événement|event/i.test(building.description ?? '')) {
          problems.push(`${locale}/${building.key} : ${building.description}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("n'annonce « mythique » que si tous ses pensionnaires le sont", () => {
    // L'Antre annonçait « les créatures mythiques » alors qu'il héberge la
    // licorne, de rareté `legendary` : le joueur qui l'achète la cherche dans
    // un bâtiment dont la description prétend ne pas pouvoir l'accueillir.
    const problems: string[] = [];
    for (const locale of locales) {
      const config = getConfig(locale);
      for (const building of config.buildingList) {
        if (!/mythiq|mythic/i.test(building.description ?? '')) continue;
        const intruders = config.animalList
          .filter((animal) => animal.buildingKey === building.key && animal.rarity !== 'mythic')
          .map((animal) => `${animal.key} (${animal.rarity})`);
        if (intruders.length > 0) problems.push(`${locale}/${building.key} : ${intruders.join(', ')}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('nomme les pensionnaires de l\'Antre dans les deux langues', () => {
    // Le même diff a bien réénuméré les espèces du poulailler, de l'enclos et
    // de l'étable, mais a oublié l'Antre : cette vérification, pilotée par les
    // données, échouerait à la prochaine créature ajoutée sans mise à jour du
    // texte, dans l'une ou l'autre langue.
    const missing: string[] = [];
    for (const locale of locales) {
      const config = getConfig(locale);
      const building = config.buildings.get('mythic_pen');
      expect(building, `Antre absent en ${locale}`).toBeDefined();
      const description = (building?.description ?? '').toLowerCase();
      for (const animal of config.animalList.filter((entry) => entry.buildingKey === 'mythic_pen')) {
        if (!description.includes(animal.name.toLowerCase())) {
          missing.push(`${locale} : ${animal.name} absent de « ${building?.description} »`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
