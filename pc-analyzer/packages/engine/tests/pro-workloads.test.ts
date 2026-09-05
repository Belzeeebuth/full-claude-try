import { describe, expect, it } from 'vitest';
import { estimateProWorkloads } from '../src/performance/pro-workloads.js';
import { DESKTOP_AMD, LEGION_5, MINI_N100 } from '../src/fixtures/pcs.js';

const pick = (pc: Parameters<typeof estimateProWorkloads>[0], workload: string) => {
  const found = estimateProWorkloads(pc).find((w) => w.workload === workload);
  if (!found) throw new Error(workload);
  return found;
};

describe('charges de travail pro', () => {
  it('Radeon dans la liste ROCm : le rendu 3D et l\'IA locale sont meilleurs sous Linux', () => {
    const render = pick(DESKTOP_AMD, 'rendering_3d');
    expect(render.linuxScore).toBeGreaterThan(render.windowsScore);
    expect(render.linuxTools.join(' ')).toMatch(/ROCm/);
    const ai = pick(DESKTOP_AMD, 'local_ai');
    expect(ai.linuxScore).toBeGreaterThanOrEqual(ai.windowsScore);
    expect(ai.notes.join(' ')).toMatch(/ROCm/);
  });

  it('NVIDIA : CUDA identique sur les deux OS', () => {
    const render = pick(LEGION_5, 'rendering_3d');
    expect(render.linuxScore).toBe(render.windowsScore);
    expect(render.linuxTools.join(' ')).toMatch(/CUDA/);
  });

  it('développement : conteneurs natifs → léger avantage Linux', () => {
    const dev = pick(DESKTOP_AMD, 'software_dev');
    expect(dev.linuxScore).toBeGreaterThanOrEqual(dev.windowsScore);
    expect(dev.notes.join(' ')).toMatch(/Docker/);
  });

  it('mini PC N100 : scores faibles, facteur limitant identifié', () => {
    const all = estimateProWorkloads(MINI_N100);
    expect(all.every((w) => w.windowsScore < 45 && w.linuxScore < 45)).toBe(true);
    expect(pick(MINI_N100, 'software_dev').limitingFactor).toBe('CPU');
  });
});
