import { describe, expect, it } from 'vitest';
import { estimateFps, estimateFpsCatalog, softMin, uncapReference, DEFAULT_PERF_MODEL, type EstimateOptions } from '../src/performance/fps-estimator.js';
import { BENCHMARKS, GAMES, game } from '../src/fixtures/games.js';
import { DESKTOP_AMD, LEGION_5, MACBOOK_AIR_M3, MINI_N100 } from '../src/fixtures/pcs.js';
import type { PcConfiguration } from '../src/types.js';

const opts = (over: Partial<EstimateOptions> = {}): EstimateOptions => ({
  resolution: '1080p',
  preset: 'ultra',
  benchmarks: BENCHMARKS,
  ...over,
});

describe('briques du modèle', () => {
  it('le min lissé se rapproche du min strict quand k grandit', () => {
    expect(softMin(100, 1000, 4)).toBeGreaterThan(95);
    expect(softMin(100, 1000, 4)).toBeLessThanOrEqual(100);
    expect(softMin(100, 100, 4)).toBeCloseTo(84.1, 0);
  });

  it('le débridage retrouve une charge GPU supérieure à une mesure plafonnée par le CPU', () => {
    const bench = BENCHMARKS.find((b) => b.gameId === 'counter-strike-2' && b.gpuName === 'Radeon RX 7800 XT' && b.os === 'windows')!;
    const gpuBound = uncapReference(bench, game('counter-strike-2'), DEFAULT_PERF_MODEL);
    expect(gpuBound).toBeGreaterThan(bench.avgFps);
    expect(gpuBound).toBeLessThan(bench.avgFps * 1.2);
  });
});

describe('Windows', () => {
  it('reprend une mesure exacte (même GPU, même résolution, même preset)', () => {
    const r = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p' }));
    expect(r.windows.basedOn).toBe('measured');
    expect(r.windows.avg).toBeGreaterThan(78);
    expect(r.windows.avg).toBeLessThan(90);
    expect(r.windows.playability).toBe('smooth');
    expect(r.windows.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('portable RTX 4060 140 W : projection depuis la RTX 4060 de bureau', () => {
    const r = estimateFps(LEGION_5, game('cyberpunk-2077'), opts());
    expect(r.gpu?.tgpAssumed).toBe(false);
    expect(r.windows.avg).toBeGreaterThan(58);
    expect(r.windows.avg).toBeLessThan(70);
    expect(r.windows.notes.join(' ')).toMatch(/GeForce RTX 4060/);
  });

  it('les FPS décroissent avec la résolution', () => {
    const at = (resolution: EstimateOptions['resolution']) => estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution })).windows.avg ?? 0;
    expect(at('1080p')).toBeGreaterThan(at('1440p'));
    expect(at('1440p')).toBeGreaterThan(at('2160p'));
  });

  it('le TGP d\'un portable change le résultat, et un TGP inconnu baisse la confiance', () => {
    const at140 = estimateFps(LEGION_5, game('cyberpunk-2077'), opts());
    const pc60: PcConfiguration = { ...LEGION_5, components: LEGION_5.components.map((c) => (c.role === 'gpu_discrete' ? { ...c, tgpW: 60 } : c)) };
    const at60 = estimateFps(pc60, game('cyberpunk-2077'), opts());
    expect(at60.windows.avg!).toBeLessThan(at140.windows.avg!);
    expect(at60.windows.avg!).toBeGreaterThan(at140.windows.avg! * 0.7);
    const unknownTgp: PcConfiguration = { ...LEGION_5, components: LEGION_5.components.map((c) => (c.role === 'gpu_discrete' ? { role: c.role, component: c.component } : c)) };
    const r = estimateFps(unknownTgp, game('cyberpunk-2077'), opts());
    expect(r.gpu?.tgpAssumed).toBe(true);
    expect(r.windows.confidence).toBeLessThan(at140.windows.confidence);
  });

  it('VRAM insuffisante : pénalité, avertissement et goulot « vram »', () => {
    const r = estimateFps(LEGION_5, game('hogwarts-legacy'), opts({ resolution: '1440p' }));
    expect(r.bottleneck).toBe('vram');
    expect(r.warnings.join(' ')).toMatch(/VRAM insuffisante/);
    const comfortable = estimateFps(DESKTOP_AMD, game('hogwarts-legacy'), opts({ resolution: '1440p' }));
    expect(comfortable.bottleneck).not.toBe('vram');
  });

  it('iGPU en simple canal : avertissement et perte nette', () => {
    const single = estimateFps(MINI_N100, game('minecraft-java'), opts({ preset: 'medium' }));
    expect(single.warnings.join(' ')).toMatch(/simple canal/);
    const dual: PcConfiguration = { ...MINI_N100, ram: { ...MINI_N100.ram, channels: 2 } };
    const dualResult = estimateFps(dual, game('minecraft-java'), opts({ preset: 'medium' }));
    expect(single.windows.avg!).toBeLessThan(dualResult.windows.avg! * 0.8);
  });

  it('plafond moteur : Elden Ring ne dépasse pas 60', () => {
    const r = estimateFps(DESKTOP_AMD, game('elden-ring'), opts());
    expect(r.windows.avg).toBe(60);
    expect(r.bottleneck).toBe('fps_cap');
  });

  it('upscaling : technologie choisie selon le vendeur, gain positif', () => {
    const amd = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p', upscaling: 'quality' }));
    expect(amd.upscaling.technology).toBe('fsr');
    const nvidia = estimateFps(LEGION_5, game('cyberpunk-2077'), opts({ resolution: '1440p', upscaling: 'quality' }));
    expect(nvidia.upscaling.technology).toBe('dlss');
    const none = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p' }));
    expect(amd.windows.avg!).toBeGreaterThan(none.windows.avg!);
  });

  it('ray tracing : coût appliqué, ignoré si le jeu ne le propose pas', () => {
    const rt = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p', rayTracing: true }));
    const noRt = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p' }));
    expect(rt.rayTracing).toBe(true);
    expect(rt.windows.avg!).toBeLessThan(noRt.windows.avg! * 0.6);
    const cs2 = estimateFps(DESKTOP_AMD, game('counter-strike-2'), opts({ rayTracing: true }));
    expect(cs2.rayTracing).toBe(false);
    expect(cs2.warnings.join(' ')).toMatch(/ray tracing/i);
  });

  it('sans GPU identifié : résultat vide mais structuré', () => {
    const noGpu: PcConfiguration = { ...MINI_N100, components: MINI_N100.components.filter((c) => !c.role.startsWith('gpu')) };
    const r = estimateFps(noGpu, game('minecraft-java'), opts());
    expect(r.gpu).toBeNull();
    expect(r.windows.avg).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/GPU non identifié/);
  });
});

describe('Linux', () => {
  it('Proton (modèle) : DX12 sur NVIDIA perd nettement face à Windows, notes explicites', () => {
    const r = estimateFps(LEGION_5, game('cyberpunk-2077'), opts());
    expect(r.linuxProton.basedOn).toBe('model');
    expect(r.linuxProton.avg!).toBeLessThan(r.windows.avg!);
    expect(r.linuxProton.avg!).toBeGreaterThan(r.windows.avg! * 0.7);
    expect(r.linuxProton.notes.join(' ')).toMatch(/VKD3D-Proton/);
    expect(r.linuxProton.notes.join(' ')).toMatch(/ProtonDB : gold/);
    expect(r.linux.notes.join(' ')).toMatch(/propriétaire NVIDIA/);
    expect(r.linux.recommendedPath).toBe('proton');
    expect(r.linux.protonTier).toBe('gold');
  });

  it('Proton (mesuré) : une mesure Proton existante prime sur le modèle', () => {
    const r = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ resolution: '1440p' }));
    expect(r.linuxProton.basedOn).toBe('measured');
    expect(r.linuxProton.avg!).toBeGreaterThan(70);
    expect(r.linuxProton.avg!).toBeLessThan(r.windows.avg!);
  });

  it('natif : Counter-Strike 2 utilise la mesure Linux native et recommande le natif', () => {
    const r = estimateFps(DESKTOP_AMD, game('counter-strike-2'), opts({ resolution: '1440p', preset: 'high' }));
    expect(r.linuxNative?.basedOn).toBe('measured');
    expect(r.linuxNative?.avg!).toBeLessThan(r.windows.avg!);
    expect(r.linux.recommendedPath).toBe('native');
  });

  it('natif (modèle) : Minecraft à 100 % des performances Windows', () => {
    const r = estimateFps(DESKTOP_AMD, game('minecraft-java'), opts({ preset: 'high' }));
    expect(r.linuxNative?.basedOn).toBe('model');
    expect(r.linuxNative?.avg).toBeCloseTo(r.windows.avg!, 0);
  });

  it('anti-cheat bloqué : incompatible quelle que soit la machine', () => {
    for (const id of ['fortnite', 'valorant']) {
      const r = estimateFps(DESKTOP_AMD, game(id), opts({ preset: 'high' }));
      expect(r.windows.avg!).toBeGreaterThan(100);
      expect(r.linuxProton.avg).toBeNull();
      expect(r.linuxProton.playability).toBe('incompatible');
      expect(r.linuxProton.notes.join(' ')).toMatch(/Anti-cheat/);
      expect(r.linux.recommendedPath).toBe('none');
    }
  });

  it('ray tracing sous Proton : facteur vendeur appliqué et signalé', () => {
    const r = estimateFps(DESKTOP_AMD, game('cyberpunk-2077'), opts({ rayTracing: true }));
    expect(r.linuxProton.notes.join(' ')).toMatch(/Ray tracing/);
    expect(r.linuxProton.avg!).toBeLessThan(r.windows.avg! * 0.8);
  });

  it('GPU sans pilote Linux : Linux incompatible', () => {
    const r = estimateFps(MACBOOK_AIR_M3, game('minecraft-java'), opts({ preset: 'medium' }));
    expect(r.linuxProton.playability).toBe('incompatible');
    expect(r.linuxNative?.playability).toBe('incompatible');
    expect(r.linux.notes.join(' ')).toMatch(/aucun pilote Linux/);
  });

  it('le catalogue renvoie une estimation par jeu', () => {
    const all = estimateFpsCatalog(LEGION_5, GAMES, opts());
    expect(all).toHaveLength(GAMES.length);
    expect(all.every((e) => e.windows.avg !== null)).toBe(true);
  });
});
