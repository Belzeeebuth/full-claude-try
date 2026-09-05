// =============================================================================
//  Estimation de FPS — Windows, Linux natif, Linux via Proton
//
//  Modèle en cinq étapes, données mesurées d'abord :
//
//   1. Référence : le banc mesuré (table game_benchmarks) le plus proche du GPU
//      cible pour ce jeu et cet OS. Si la résolution ou le preset diffèrent, la
//      mesure est ramenée à la cible par des facteurs de charge GPU.
//   2. Débridage : une mesure à 1080p est souvent plafonnée par le CPU du banc ;
//      on retrouve la charge « GPU pure » en inversant la combinaison douce.
//   3. Projection : la charge GPU est mise à l'échelle de l'indice de perf du GPU
//      cible (TGP compris pour les portables), puis pénalisée (VRAM, RAM,
//      mono-canal) et bonifiée (upscaling), ray tracing inclus.
//   4. Plafond CPU : combinaison douce entre FPS « GPU » et FPS « CPU »
//      (min lissé, exposant k) — puis plafond moteur (Elden Ring : 60).
//   5. Linux : une mesure Linux existante l'emporte ; sinon le résultat Windows
//      est multiplié par des facteurs : couche de traduction (DXVK / VKD3D-Proton
//      selon l'API et le vendeur du GPU), palier ProtonDB, qualité du pilote,
//      ray tracing. Les anti-cheats bloqués et les titres « Borked » sortent
//      en « incompatible » quelle que soit la puissance de la machine.
//
//  Tous les coefficients vivent dans DEFAULT_PERF_MODEL : ils sont destinés à
//  être recalibrés par régression sur la table game_benchmarks, pas gravés.
// =============================================================================

import type {
  AntiCheatInfo,
  Game,
  GameBenchmark,
  GraphicsApi,
  PcConfiguration,
  Preset,
  ProtonConfidence,
  ProtonTier,
  Resolution,
  TargetOs,
  UpscalerKind,
  UpscalingMode,
  Vendor,
} from '../types.js';

// -----------------------------------------------------------------------------
//  Modèle (coefficients)
// -----------------------------------------------------------------------------

export type GpuVendorKey = 'amd' | 'nvidia' | 'intel' | 'other';

export interface PerfModel {
  /** Charge GPU relative à 1080p (FPS GPU-bound × facteur). */
  resolutionFactor: Record<Resolution, number>;
  /** Charge GPU relative au preset ultra. */
  presetFactor: Record<Preset, number>;
  /** Multiplicateur de VRAM nécessaire selon la résolution. */
  vramResolutionFactor: Record<Resolution, number>;
  vramRayTracingExtraGb: number;
  /** Gain d'upscaling selon le mode et la résolution de sortie. */
  upscalingGain: Record<Exclude<UpscalingMode, 'none'>, Record<Resolution, number>>;
  /** Exposant de la combinaison douce min(GPU, CPU) : plus k est grand, plus on approche le min strict. */
  softMinK: number;
  /** Portables : perf ∝ (TGP / TGP max)^exposant. */
  tgpExponent: number;
  /** Ratio 1 % low / moyenne par défaut. */
  low1pctRatio: number;
  /** iGPU : VRAM partagée plafonnée (Go). */
  sharedVramMaxGb: number;
  linux: {
    /** Rendement de la couche de traduction (DXVK / VKD3D-Proton) par API et vendeur. */
    translation: Record<GraphicsApi, Record<GpuVendorKey, number>>;
    protonTier: Record<ProtonTier, number>;
    /** Qualité du pilote sous Linux (RADV ≈ Windows ; NVIDIA propriétaire légèrement en retrait). */
    driver: Record<GpuVendorKey, number>;
    rayTracing: Record<GpuVendorKey, number>;
    /** Ratio par défaut d'un portage natif dont on n'a pas la mesure. */
    nativeDefaultRatio: number;
    /** Pénalité 1 % low sous Proton (compilation des shaders au premier lancement). */
    protonLow1pctPenalty: number;
  };
}

export const DEFAULT_PERF_MODEL: PerfModel = {
  resolutionFactor: { '1080p': 1, '1440p': 0.68, '2160p': 0.4 },
  presetFactor: { low: 1.65, medium: 1.4, high: 1.18, ultra: 1 },
  vramResolutionFactor: { '1080p': 1, '1440p': 1.25, '2160p': 1.6 },
  vramRayTracingExtraGb: 1.5,
  upscalingGain: {
    quality: { '1080p': 1.25, '1440p': 1.35, '2160p': 1.55 },
    balanced: { '1080p': 1.35, '1440p': 1.5, '2160p': 1.75 },
    performance: { '1080p': 1.5, '1440p': 1.7, '2160p': 2.1 },
  },
  softMinK: 4,
  tgpExponent: 0.3,
  low1pctRatio: 0.72,
  sharedVramMaxGb: 8,
  linux: {
    translation: {
      dx12: { amd: 0.92, nvidia: 0.85, intel: 0.85, other: 0.85 },
      dx11: { amd: 0.98, nvidia: 0.95, intel: 0.9, other: 0.9 },
      dx9: { amd: 1.0, nvidia: 0.97, intel: 0.95, other: 0.95 },
      vulkan: { amd: 1.0, nvidia: 0.98, intel: 0.97, other: 0.97 },
      opengl: { amd: 0.97, nvidia: 0.97, intel: 0.95, other: 0.95 },
    },
    protonTier: { platinum: 1, gold: 0.97, silver: 0.85, bronze: 0.6, borked: 0, pending: 0.9 },
    driver: { amd: 1.0, nvidia: 0.97, intel: 0.95, other: 0.9 },
    rayTracing: { amd: 0.8, nvidia: 0.95, intel: 0.85, other: 0.8 },
    nativeDefaultRatio: 0.9,
    protonLow1pctPenalty: 0.92,
  },
};

// -----------------------------------------------------------------------------
//  Types du résultat
// -----------------------------------------------------------------------------

export type Playability = 'excellent' | 'smooth' | 'playable' | 'limited' | 'unplayable' | 'incompatible';
export type Bottleneck = 'gpu' | 'cpu' | 'vram' | 'ram' | 'balanced' | 'fps_cap' | 'unknown';

export interface OsFpsResult {
  os: TargetOs;
  avg: number | null;
  low1pct: number | null;
  playability: Playability;
  /** 0..1 */
  confidence: number;
  /** measured : banc pour cet OS ; derived : banc d'un autre OS/résolution/preset ; model : facteurs seuls ; none : pas de donnée. */
  basedOn: 'measured' | 'derived' | 'model' | 'none';
  notes: string[];
}

export interface FpsEstimate {
  gameId: string;
  gameName: string;
  resolution: Resolution;
  preset: Preset;
  rayTracing: boolean;
  upscaling: { mode: UpscalingMode; technology: UpscalerKind | null };
  gpu: {
    name: string;
    effectiveIndex: number;
    tgpW?: number;
    tgpAssumed: boolean;
    vramGb: number;
    integrated: boolean;
  } | null;
  windows: OsFpsResult;
  linuxNative?: OsFpsResult;
  linuxProton: OsFpsResult;
  linux: {
    recommendedPath: 'native' | 'proton' | 'none';
    protonTier?: ProtonTier;
    protonConfidence?: ProtonConfidence;
    antiCheat: AntiCheatInfo;
    steamDeck?: NonNullable<Game['proton']>['steamDeck'];
    notes: string[];
  };
  bottleneck: Bottleneck;
  warnings: string[];
}

export interface EstimateOptions {
  resolution: Resolution;
  preset: Preset;
  rayTracing?: boolean;
  upscaling?: UpscalingMode;
  benchmarks: GameBenchmark[];
  model?: Partial<PerfModel>;
}

// -----------------------------------------------------------------------------
//  Résolution du matériel
// -----------------------------------------------------------------------------

interface ResolvedGpu {
  name: string;
  vendor: GpuVendorKey;
  effectiveIndex: number;
  vramGb: number;
  integrated: boolean;
  tgpW?: number;
  tgpAssumed: boolean;
  rtCapable: boolean;
  rtEfficiency: number;
  upscalers: UpscalerKind[];
  linuxUnsupported: boolean;
  linuxProprietaryDriver: boolean;
}

export function vendorKey(vendor: Vendor): GpuVendorKey {
  return vendor === 'amd' || vendor === 'nvidia' || vendor === 'intel' ? vendor : 'other';
}

function resolvePrimaryGpu(pc: PcConfiguration, model: PerfModel): ResolvedGpu | null {
  const chosen =
    pc.components.find((c) => c.role === 'gpu_discrete' && c.component.gpu) ??
    pc.components.find((c) => c.role === 'gpu_integrated' && c.component.gpu);
  const specs = chosen?.component.gpu;
  if (!chosen || !specs) return null;

  let effectiveIndex = specs.perfIndex;
  let tgpW: number | undefined;
  let tgpAssumed = false;
  if (!specs.integrated && specs.tgpMaxW) {
    // Un même GPU de portable existe de 35 W à 140 W : sans TGP annoncé par le
    // vendeur, on prend le milieu de la plage et on baisse la confiance.
    tgpAssumed = chosen.tgpW === undefined;
    tgpW = chosen.tgpW ?? (specs.tgpMinW ? (specs.tgpMinW + specs.tgpMaxW) / 2 : specs.tgpMaxW * 0.75);
    effectiveIndex = specs.perfIndex * Math.pow(Math.min(1, tgpW / specs.tgpMaxW), model.tgpExponent);
  }

  const vendor = vendorKey(chosen.component.vendor);
  return {
    name: chosen.component.name,
    vendor,
    effectiveIndex,
    vramGb: specs.integrated ? Math.min(pc.ram.totalGb / 2, model.sharedVramMaxGb) : specs.vramGb,
    integrated: specs.integrated,
    tgpW,
    tgpAssumed,
    rtCapable: specs.features.rayTracing === true,
    rtEfficiency: specs.features.rtEfficiency ?? (vendor === 'nvidia' ? 1 : 0.75),
    upscalers: specs.features.upscalers ?? ['fsr'],
    linuxUnsupported: chosen.component.linux.status === 'unsupported',
    linuxProprietaryDriver: chosen.component.linux.driver.type === 'proprietary',
  };
}

function resolveCpuIndex(pc: PcConfiguration): { gamingIndex: number; assumed: boolean } {
  const cpu = pc.components.find((c) => c.role === 'cpu')?.component.cpu;
  return cpu ? { gamingIndex: cpu.gamingIndex, assumed: false } : { gamingIndex: 50, assumed: true };
}

// -----------------------------------------------------------------------------
//  Référence mesurée
// -----------------------------------------------------------------------------

interface ReferencePick {
  benchmark: GameBenchmark;
  /** Facteur ramenant la mesure à la résolution/preset cibles (charge GPU). */
  scale: number;
  /** Pénalité de confiance due aux dérivations et à la distance au GPU cible. */
  penalty: number;
  derived: boolean;
}

export interface PickConstraints {
  /** Linux : la couche de traduction se comporte différemment selon le pilote — même vendeur exigé. */
  requireVendorMatch?: boolean;
  /** Distance maximale |ln(indice cible / indice mesuré)| ; 0.5 ≈ un rapport de 1,65. */
  maxGpuDistance?: number;
}

/** Mesures Linux : mêmes pilotes et GPU de puissance comparable, sinon le modèle prend le relais. */
export const LINUX_PICK_CONSTRAINTS: PickConstraints = { requireVendorMatch: true, maxGpuDistance: 0.5 };

export function pickReference(
  benchmarks: GameBenchmark[],
  gameId: string,
  os: TargetOs,
  resolution: Resolution,
  preset: Preset,
  gpu: ResolvedGpu,
  model: PerfModel,
  constraints: PickConstraints = {},
): ReferencePick | undefined {
  const candidates = benchmarks.filter(
    (b) => b.gameId === gameId && b.os === os && !b.rayTracing && b.upscaling === 'none',
  );
  let best: (ReferencePick & { cost: number }) | undefined;
  for (const b of candidates) {
    const sameRes = b.resolution === resolution;
    const samePreset = b.preset === preset;
    const scale =
      (model.resolutionFactor[resolution] / model.resolutionFactor[b.resolution]) *
      (model.presetFactor[preset] / model.presetFactor[b.preset]);
    const gpuDistance = Math.abs(Math.log(gpu.effectiveIndex / b.gpuPerfIndex));
    const vendorMatch = b.gpuVendor === gpu.vendor;
    if (constraints.requireVendorMatch && !vendorMatch) continue;
    if (constraints.maxGpuDistance !== undefined && gpuDistance > constraints.maxGpuDistance) continue;
    const cost = gpuDistance + (sameRes ? 0 : 0.35) + (samePreset ? 0 : 0.25) + (vendorMatch ? 0 : 0.1);
    const penalty = (sameRes ? 0 : 0.1) + (samePreset ? 0 : 0.08) + Math.min(0.25, gpuDistance * 0.3);
    if (!best || cost < best.cost) {
      best = { benchmark: b, scale, penalty, derived: !sameRes || !samePreset, cost };
    }
  }
  return best;
}

/**
 * Retrouve la charge GPU pure d'une mesure éventuellement plafonnée par le CPU
 * du banc, en inversant la combinaison douce : m^-k = g^-k + c^-k.
 */
export function uncapReference(benchmark: GameBenchmark, game: Game, model: PerfModel): number {
  const k = model.softMinK;
  const cap = (game.cpuBoundFpsRef * (benchmark.cpuGamingIndex ?? 100)) / 100;
  const measured = benchmark.avgFps;
  if (measured >= cap * 0.97) return measured * 1.1;
  const inv = Math.pow(measured, -k) - Math.pow(cap, -k);
  return inv <= 0 ? measured * 1.1 : Math.pow(inv, -1 / k);
}

export function softMin(a: number, b: number, k: number): number {
  return Math.pow(Math.pow(a, -k) + Math.pow(b, -k), -1 / k);
}

// -----------------------------------------------------------------------------
//  Estimation
// -----------------------------------------------------------------------------

export function estimateFps(pc: PcConfiguration, game: Game, options: EstimateOptions): FpsEstimate {
  const model: PerfModel = { ...DEFAULT_PERF_MODEL, ...options.model, linux: { ...DEFAULT_PERF_MODEL.linux, ...options.model?.linux } };
  const { resolution, preset } = options;
  const warnings: string[] = [];
  const gpu = resolvePrimaryGpu(pc, model);
  const cpu = resolveCpuIndex(pc);
  const antiCheat = game.antiCheat;

  const none = (os: TargetOs, note: string): OsFpsResult => ({
    os,
    avg: null,
    low1pct: null,
    playability: 'incompatible',
    confidence: 0,
    basedOn: 'none',
    notes: [note],
  });

  if (!gpu) {
    warnings.push('GPU non identifié : estimation impossible');
    return {
      gameId: game.id,
      gameName: game.name,
      resolution,
      preset,
      rayTracing: false,
      upscaling: { mode: 'none', technology: null },
      gpu: null,
      windows: none('windows', 'GPU non identifié'),
      linuxProton: none('linux_proton', 'GPU non identifié'),
      linux: { recommendedPath: 'none', antiCheat, notes: [] },
      bottleneck: 'unknown',
      warnings,
    };
  }
  if (cpu.assumed) warnings.push('CPU non identifié : plafond CPU estimé sur un processeur moyen');

  // Ray tracing et upscaling : la demande est honorée seulement si jeu ET GPU le permettent.
  let rayTracing = options.rayTracing === true;
  if (rayTracing && !game.rayTracing?.available) {
    rayTracing = false;
    warnings.push('Ce jeu ne propose pas de ray tracing');
  }
  if (rayTracing && !gpu.rtCapable) {
    rayTracing = false;
    warnings.push('GPU sans accélération matérielle du ray tracing : option ignorée');
  }
  const upscaling = resolveUpscaling(options.upscaling ?? 'none', game, gpu, resolution, model);
  if (upscaling.mode !== 'none' && !upscaling.technology) {
    warnings.push('Aucun upscaler commun au jeu et au GPU : upscaling ignoré');
  }

  // Pénalités mémoire, communes à tous les OS.
  const vramNeed =
    game.requirements.vramGb[preset] * model.vramResolutionFactor[resolution] +
    (rayTracing ? model.vramRayTracingExtraGb : 0);
  let vramPenalty = 1;
  if (vramNeed > gpu.vramGb) {
    // Dépassement marginal : quelques textures évincées ; franc : streaming permanent.
    const ratio = vramNeed / gpu.vramGb;
    vramPenalty = ratio > 1.3 ? 0.55 : ratio > 1.1 ? 0.75 : 0.9;
    warnings.push(
      `VRAM ${ratio > 1.1 ? 'insuffisante' : 'juste'} : ${round1(vramNeed)} Go requis (${preset}, ${resolution}), ${round1(gpu.vramGb)} Go disponibles — ${ratio > 1.1 ? 'saccades probables' : 'micro-saccades possibles'}`,
    );
  }
  let ramPenalty = 1;
  if (pc.ram.totalGb < game.requirements.minRamGb) {
    ramPenalty = 0.6;
    warnings.push(`RAM insuffisante : ${game.requirements.minRamGb} Go minimum, ${pc.ram.totalGb} Go installés`);
  } else if (pc.ram.totalGb < game.requirements.recRamGb) {
    ramPenalty = 0.92;
    warnings.push(`RAM sous la recommandation (${game.requirements.recRamGb} Go)`);
  }
  if (pc.ram.channels === 1) {
    ramPenalty *= gpu.integrated ? 0.7 : 0.95;
    warnings.push(
      gpu.integrated
        ? 'Mémoire en simple canal : un iGPU y perd jusqu\'à 30 % — ajouter une barrette identique'
        : 'Mémoire en simple canal : légère perte de performance',
    );
  }
  if (pc.storage.every((s) => s.type === 'hdd')) {
    warnings.push('Stockage sur disque dur : chargements longs et micro-saccades de streaming');
  }

  const fpsCpu = (game.cpuBoundFpsRef * cpu.gamingIndex) / 100;
  const k = model.softMinK;

  /** Projette une mesure de référence sur la configuration cible. */
  const project = (ref: ReferencePick): { avgUncapped: number; fpsGpu: number; lowRatio: number } => {
    const gpuBoundRef = uncapReference(ref.benchmark, game, model);
    let fpsGpu = gpuBoundRef * ref.scale * (gpu.effectiveIndex / ref.benchmark.gpuPerfIndex);
    if (rayTracing && game.rayTracing) fpsGpu *= game.rayTracing.cost * gpu.rtEfficiency;
    fpsGpu *= upscaling.gain;
    fpsGpu *= vramPenalty;
    const avgUncapped = softMin(fpsGpu, fpsCpu, k) * ramPenalty;
    const lowRatio = ref.benchmark.low1pctFps
      ? ref.benchmark.low1pctFps / ref.benchmark.avgFps
      : model.low1pctRatio;
    return { avgUncapped, fpsGpu, lowRatio };
  };

  const baseConfidence =
    0.9 - (gpu.tgpAssumed ? 0.1 : 0) - (gpu.integrated ? 0.1 : 0) - (cpu.assumed ? 0.1 : 0);

  // ---- Windows -----------------------------------------------------------
  const winRef = pickReference(options.benchmarks, game.id, 'windows', resolution, preset, gpu, model);
  let bottleneck: Bottleneck = 'unknown';
  let windows: OsFpsResult;
  let winProjection: { avgUncapped: number; fpsGpu: number; lowRatio: number } | undefined;
  if (!winRef) {
    windows = none('windows', 'Aucun banc de référence pour ce jeu');
    windows.playability = 'incompatible';
    warnings.push('Aucune donnée de référence pour ce jeu : estimation impossible');
  } else {
    winProjection = project(winRef);
    const capped = applyCap(winProjection.avgUncapped, game.fpsCap);
    bottleneck = detectBottleneck(winProjection.fpsGpu, fpsCpu, vramPenalty, ramPenalty, capped.capped);
    const low = capped.avg * winProjection.lowRatio * (bottleneck === 'cpu' ? 0.9 : 1) * (vramPenalty < 1 ? 0.8 : 1);
    windows = {
      os: 'windows',
      avg: round1(capped.avg),
      low1pct: round1(low),
      playability: playabilityOf(capped.avg),
      confidence: clampConfidence(baseConfidence - winRef.penalty),
      basedOn: winRef.derived ? 'derived' : 'measured',
      notes: [`Référence : ${winRef.benchmark.gpuName} — ${winRef.benchmark.source}`],
    };
  }

  // ---- Linux : facteur pilote commun -------------------------------------
  const linuxNotes: string[] = [];
  let driverFactor = model.linux.driver[gpu.vendor];
  if (gpu.linuxUnsupported) {
    driverFactor = 0;
    linuxNotes.push(`${gpu.name} : aucun pilote Linux exploitable`);
  } else if (gpu.vendor === 'nvidia' && gpu.linuxProprietaryDriver) {
    linuxNotes.push('Pilote propriétaire NVIDIA requis (Nouveau/NVK : performances très inférieures en jeu)');
  }
  if (upscaling.technology === 'dlss') {
    linuxNotes.push('DLSS super résolution fonctionne via Proton ; la génération d\'images (DLSS 3) reste partielle');
  }

  // ---- Linux natif -------------------------------------------------------
  let linuxNative: OsFpsResult | undefined;
  if (game.linuxNative) {
    if (antiCheat.linux === 'blocked') {
      linuxNative = none('linux_native', `Anti-cheat ${antiCheat.kind} : Linux bloqué par l'éditeur`);
    } else if (driverFactor === 0) {
      linuxNative = none('linux_native', 'GPU sans pilote Linux');
    } else {
      const nativeRef = pickReference(options.benchmarks, game.id, 'linux_native', resolution, preset, gpu, model, LINUX_PICK_CONSTRAINTS);
      if (nativeRef) {
        const p = project(nativeRef);
        const capped = applyCap(p.avgUncapped, game.fpsCap);
        linuxNative = {
          os: 'linux_native',
          avg: round1(capped.avg),
          low1pct: round1(capped.avg * p.lowRatio),
          playability: playabilityOf(capped.avg),
          confidence: clampConfidence(baseConfidence - nativeRef.penalty),
          basedOn: nativeRef.derived ? 'derived' : 'measured',
          notes: [`Mesure Linux native : ${nativeRef.benchmark.gpuName} — ${nativeRef.benchmark.source}`],
        };
      } else if (winProjection) {
        const ratio = game.linuxNative.perfRatio || model.linux.nativeDefaultRatio;
        const capped = applyCap(winProjection.avgUncapped * ratio * driverFactor, game.fpsCap);
        linuxNative = {
          os: 'linux_native',
          avg: round1(capped.avg),
          low1pct: round1(capped.avg * winProjection.lowRatio),
          playability: playabilityOf(capped.avg),
          confidence: clampConfidence((windows.confidence || 0.5) - 0.1),
          basedOn: 'model',
          notes: [`Portage natif (${game.linuxNative.api.toUpperCase()}) : ${Math.round(ratio * 100)} % des performances Windows`],
        };
      } else {
        linuxNative = none('linux_native', 'Aucun banc de référence');
      }
    }
  }

  // ---- Linux via Proton --------------------------------------------------
  let linuxProton: OsFpsResult;
  const tier = game.proton?.tier;
  if (antiCheat.linux === 'blocked') {
    linuxProton = none('linux_proton', `Anti-cheat ${antiCheat.kind} : le jeu refuse de se lancer sous Linux`);
  } else if (tier === 'borked') {
    linuxProton = none('linux_proton', 'ProtonDB : Borked — le jeu ne fonctionne pas via Proton');
  } else if (driverFactor === 0) {
    linuxProton = none('linux_proton', 'GPU sans pilote Linux');
  } else {
    const protonRef = pickReference(options.benchmarks, game.id, 'linux_proton', resolution, preset, gpu, model, LINUX_PICK_CONSTRAINTS);
    const api = game.apis[0] ?? 'dx11';
    const tierFactor = model.linux.protonTier[tier ?? 'pending'];
    const rt = rayTracing ? model.linux.rayTracing[gpu.vendor] : 1;
    const notes: string[] = [];
    if (rayTracing) notes.push(`Ray tracing via VKD3D-Proton : facteur ${rt} sur ce vendeur`);
    if (protonRef) {
      // Les mesures de référence sont faites sans RT : le surcoût Linux du RT s'ajoute.
      const p = project(protonRef);
      const capped = applyCap(p.avgUncapped * rt, game.fpsCap);
      linuxProton = {
        os: 'linux_proton',
        avg: round1(capped.avg),
        low1pct: round1(capped.avg * p.lowRatio * model.linux.protonLow1pctPenalty),
        playability: playabilityOf(capped.avg),
        confidence: clampConfidence(baseConfidence - protonRef.penalty - (tierFactor < 0.9 ? 0.1 : 0)),
        basedOn: protonRef.derived ? 'derived' : 'measured',
        notes: [`Mesure Proton : ${protonRef.benchmark.gpuName} — ${protonRef.benchmark.source}`, ...notes],
      };
    } else if (winProjection) {
      const translation = model.linux.translation[api][gpu.vendor];
      const factor = translation * tierFactor * driverFactor * rt;
      const capped = applyCap(winProjection.avgUncapped * factor, game.fpsCap);
      notes.push(describeTranslation(api, translation));
      if (tier) notes.push(`ProtonDB : ${tier} (${game.proton?.reports ?? 0} rapports) → facteur ${tierFactor}`);
      else notes.push('Aucun rapport ProtonDB : facteur prudent appliqué');
      if (api === 'dx12') notes.push('Premier lancement : compilation des shaders (activer le pré-cache Steam)');
      linuxProton = {
        os: 'linux_proton',
        avg: round1(capped.avg),
        low1pct: round1(capped.avg * winProjection.lowRatio * model.linux.protonLow1pctPenalty),
        playability: playabilityOf(capped.avg),
        confidence: clampConfidence(
          (windows.confidence || 0.5) - 0.15 - (game.proton?.confidence === 'low' || !tier ? 0.1 : 0),
        ),
        basedOn: 'model',
        notes,
      };
    } else {
      linuxProton = none('linux_proton', 'Aucun banc de référence');
    }
  }

  const recommendedPath = pickLinuxPath(linuxNative, linuxProton);

  return {
    gameId: game.id,
    gameName: game.name,
    resolution,
    preset,
    rayTracing,
    upscaling: { mode: upscaling.technology ? upscaling.mode : 'none', technology: upscaling.technology },
    gpu: {
      name: gpu.name,
      effectiveIndex: round1(gpu.effectiveIndex),
      tgpW: gpu.tgpW,
      tgpAssumed: gpu.tgpAssumed,
      vramGb: round1(gpu.vramGb),
      integrated: gpu.integrated,
    },
    windows,
    linuxNative,
    linuxProton,
    linux: {
      recommendedPath,
      protonTier: tier,
      protonConfidence: game.proton?.confidence,
      antiCheat,
      steamDeck: game.proton?.steamDeck,
      notes: linuxNotes,
    },
    bottleneck,
    warnings,
  };
}

/** Estime tout un catalogue : la fiche d'un PC affiche typiquement 10 à 20 jeux. */
export function estimateFpsCatalog(pc: PcConfiguration, games: Game[], options: EstimateOptions): FpsEstimate[] {
  return games.map((game) => estimateFps(pc, game, options));
}

// -----------------------------------------------------------------------------
//  Aides
// -----------------------------------------------------------------------------

function resolveUpscaling(
  mode: UpscalingMode,
  game: Game,
  gpu: ResolvedGpu,
  resolution: Resolution,
  model: PerfModel,
): { mode: UpscalingMode; technology: UpscalerKind | null; gain: number } {
  if (mode === 'none') return { mode, technology: null, gain: 1 };
  // Priorité à l'upscaler « maison » du GPU, puis aux solutions ouvertes.
  const order: UpscalerKind[] = gpu.vendor === 'nvidia' ? ['dlss', 'fsr', 'xess'] : gpu.vendor === 'intel' ? ['xess', 'fsr'] : ['fsr', 'xess'];
  const technology = order.find((t) => game.upscalers.includes(t) && gpu.upscalers.includes(t)) ?? null;
  if (!technology) return { mode, technology: null, gain: 1 };
  return { mode, technology, gain: model.upscalingGain[mode][resolution] };
}

function applyCap(avg: number, cap: number | undefined): { avg: number; capped: boolean } {
  if (cap !== undefined && avg > cap) return { avg: cap, capped: true };
  return { avg, capped: false };
}

function detectBottleneck(
  fpsGpu: number,
  fpsCpu: number,
  vramPenalty: number,
  ramPenalty: number,
  capped: boolean,
): Bottleneck {
  if (capped) return 'fps_cap';
  if (vramPenalty < 1) return 'vram';
  if (ramPenalty <= 0.7) return 'ram';
  if (fpsCpu < fpsGpu * 0.9) return 'cpu';
  if (fpsGpu < fpsCpu * 0.9) return 'gpu';
  return 'balanced';
}

export function playabilityOf(avg: number | null): Playability {
  if (avg === null) return 'incompatible';
  if (avg >= 120) return 'excellent';
  if (avg >= 60) return 'smooth';
  if (avg >= 40) return 'playable';
  if (avg >= 25) return 'limited';
  return 'unplayable';
}

function pickLinuxPath(native: OsFpsResult | undefined, proton: OsFpsResult): 'native' | 'proton' | 'none' {
  const nativeOk = native?.avg !== null && native?.avg !== undefined;
  const protonOk = proton.avg !== null;
  if (nativeOk && (!protonOk || (native?.avg ?? 0) >= (proton.avg ?? 0) * 0.95)) return 'native';
  if (protonOk) return 'proton';
  return 'none';
}

function describeTranslation(api: GraphicsApi, factor: number): string {
  const pct = Math.round((1 - factor) * 100);
  switch (api) {
    case 'dx12':
      return `DirectX 12 traduit par VKD3D-Proton : environ −${pct} %`;
    case 'dx11':
      return `DirectX 11 traduit par DXVK : environ −${pct} %`;
    case 'dx9':
      return `DirectX 9 traduit par DXVK : environ −${pct} %`;
    case 'vulkan':
      return 'Vulkan natif sous Proton : quasi sans perte';
    case 'opengl':
      return `OpenGL sous Proton : environ −${pct} %`;
  }
}

function clampConfidence(value: number): number {
  return Math.round(Math.min(0.95, Math.max(0.2, value)) * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
