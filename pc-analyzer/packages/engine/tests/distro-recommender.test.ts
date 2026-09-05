import { describe, expect, it } from 'vitest';
import { recommendDistros } from '../src/linux/distro-recommender.js';
import { DISTROS } from '../src/fixtures/distros.js';
import { LEGION_5, ZENBOOK_S16 } from '../src/fixtures/pcs.js';

describe('recommandation de distributions', () => {
  it('portable NVIDIA, joueur débutant : une distribution avec pilote intégré en tête, Arch loin derrière', () => {
    const ranked = recommendDistros(LEGION_5, DISTROS, { usage: 'gaming', experience: 'beginner' }, 10);
    const ids = ranked.map((r) => r.distro.id);
    expect(['pop-24.04', 'bazzite']).toContain(ids[0]);
    expect(ids.indexOf('arch')).toBeGreaterThan(ids.indexOf('pop-24.04'));
    const arch = ranked.find((r) => r.distro.id === 'arch');
    expect(arch?.warnings.join(' ')).toMatch(/Rolling/);
  });

  it('Secure Boot exigé : Pop!_OS recule derrière Fedora et Ubuntu', () => {
    const ranked = recommendDistros(ZENBOOK_S16, DISTROS, { usage: 'general', experience: 'intermediate', keepSecureBoot: true }, 10);
    const rank = (id: string) => ranked.findIndex((r) => r.distro.id === id);
    expect(rank('pop-24.04')).toBeGreaterThan(rank('fedora-43'));
    expect(rank('pop-24.04')).toBeGreaterThan(rank('ubuntu-24.04'));
    expect(ranked[rank('pop-24.04')]?.warnings.join(' ')).toMatch(/Secure Boot/);
  });

  it('matériel récent : le noyau récent de Fedora bat le noyau GA d\'Ubuntu, qui signale le HWE', () => {
    const ranked = recommendDistros(ZENBOOK_S16, DISTROS, { usage: 'developer', experience: 'intermediate' }, 10);
    const fedora = ranked.find((r) => r.distro.id === 'fedora-43');
    const ubuntu = ranked.find((r) => r.distro.id === 'ubuntu-24.04');
    expect(fedora?.hardwareScore).toBeGreaterThan(ubuntu?.hardwareScore ?? 0);
    expect(ubuntu?.warnings.join(' ')).toMatch(/HWE/);
  });

  it('respecte la limite et trie par score décroissant', () => {
    const ranked = recommendDistros(ZENBOOK_S16, DISTROS, undefined, 3);
    expect(ranked).toHaveLength(3);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });
});
