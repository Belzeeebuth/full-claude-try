// =============================================================================
//  Charges de travail professionnelles — Windows vs Linux
//
//  Contrairement au jeu, l'OS change ici rarement la performance brute : ce qui
//  change, c'est l'accès aux accélérateurs (CUDA identique, ROCm surtout sur
//  Linux, oneAPI) et la nature des outils (conteneurs natifs sous Linux, suite
//  Adobe absente). Le score est une capacité matérielle 0-100 par charge, avec
//  un ajustement par OS uniquement là où il est mesurable, et les outils
//  optimisés à recommander pour chaque OS.
// =============================================================================

import type { PcConfiguration } from '../types.js';
import { vendorKey, type GpuVendorKey } from './fps-estimator.js';

export type Workload = 'video_editing' | 'software_dev' | 'rendering_3d' | 'local_ai';

export interface WorkloadEstimate {
  workload: Workload;
  label: string;
  /** Capacité matérielle sous Windows, 0-100. */
  windowsScore: number;
  /** Capacité matérielle sous Linux, 0-100. */
  linuxScore: number;
  linuxTools: string[];
  windowsTools: string[];
  notes: string[];
  limitingFactor: string;
}

/** Rendement des API de calcul GPU par OS (1 = CUDA). */
export const COMPUTE_EFFICIENCY: Record<'windows' | 'linux', Record<GpuVendorKey, { official: number; unofficial: number }>> = {
  windows: {
    nvidia: { official: 1, unofficial: 1 },
    amd: { official: 0.65, unofficial: 0.45 }, // HIP SDK Windows : couverture partielle
    intel: { official: 0.6, unofficial: 0.5 },
    other: { official: 0.3, unofficial: 0.3 },
  },
  linux: {
    nvidia: { official: 1, unofficial: 1 },
    amd: { official: 0.85, unofficial: 0.55 }, // ROCm : liste officielle vs HSA_OVERRIDE_GFX_VERSION
    intel: { official: 0.7, unofficial: 0.55 },
    other: { official: 0.3, unofficial: 0.3 },
  },
};

interface Hardware {
  cpuMulti: number;
  cpuSingle: number;
  cores: number;
  ramGb: number;
  storageScore: number;
  gpuIndex: number;
  gpuVendor: GpuVendorKey;
  gpuVramGb: number;
  gpuIntegrated: boolean;
  rocmOfficial: boolean;
  hasEncoder: boolean;
  hasNpu: boolean;
  gpuName: string;
}

function collect(pc: PcConfiguration): Hardware {
  const cpu = pc.components.find((c) => c.role === 'cpu')?.component;
  const gpuComponent =
    pc.components.find((c) => c.role === 'gpu_discrete' && c.component.gpu)?.component ??
    pc.components.find((c) => c.role === 'gpu_integrated' && c.component.gpu)?.component;
  const gpu = gpuComponent?.gpu;
  const best = pc.storage.reduce((acc, s) => Math.max(acc, storageScore(s.type)), 0);
  return {
    cpuMulti: cpu?.cpu?.multiIndex ?? 40,
    cpuSingle: cpu?.cpu?.gamingIndex ?? 50,
    cores: cpu?.cpu?.cores ?? 4,
    ramGb: pc.ram.totalGb,
    storageScore: best,
    gpuIndex: gpu?.perfIndex ?? 0,
    gpuVendor: gpuComponent ? vendorKey(gpuComponent.vendor) : 'other',
    gpuVramGb: gpu?.integrated ? Math.min(pc.ram.totalGb / 2, 16) : gpu?.vramGb ?? 0,
    gpuIntegrated: gpu?.integrated ?? true,
    rocmOfficial: gpu?.features.rocmOfficial === true,
    hasEncoder: (gpu?.features.encoders?.length ?? 0) > 0,
    hasNpu: cpu?.cpu?.npu === true,
    gpuName: gpuComponent?.name ?? 'GPU inconnu',
  };
}

function storageScore(type: PcConfiguration['storage'][number]['type']): number {
  switch (type) {
    case 'nvme':
      return 100;
    case 'sata_ssd':
      return 70;
    case 'emmc':
      return 25;
    case 'hdd':
      return 20;
  }
}

/** Interpolation linéaire par paliers : [[seuil, score], …] trié par seuil croissant. */
function ladder(value: number, steps: [number, number][]): number {
  let result = steps[0]?.[1] ?? 0;
  for (const [threshold, score] of steps) {
    if (value >= threshold) result = score;
  }
  return result;
}

function gpuCompute(hw: Hardware, os: 'windows' | 'linux'): number {
  const eff = COMPUTE_EFFICIENCY[os][hw.gpuVendor];
  const factor = hw.gpuVendor === 'amd' ? (hw.rocmOfficial ? eff.official : eff.unofficial) : eff.official;
  return Math.min(100, hw.gpuIndex * 1.2) * factor;
}

export function estimateProWorkloads(pc: PcConfiguration): WorkloadEstimate[] {
  const hw = collect(pc);
  return [videoEditing(hw), softwareDev(hw), rendering3d(hw), localAi(hw)];
}

function videoEditing(hw: Hardware): WorkloadEstimate {
  const ram = ladder(hw.ramGb, [[8, 25], [16, 65], [32, 100]]);
  const gpuRaster = Math.min(100, hw.gpuIndex * 1.4);
  const encode = hw.hasEncoder ? 100 : 30;
  const base = 0.35 * hw.cpuMulti + 0.25 * gpuRaster + 0.2 * ram + 0.1 * hw.storageScore + 0.1 * encode;
  const notes: string[] = [];
  const linuxTools = ['DaVinci Resolve (Studio conseillé : H.264/AAC absents de la version gratuite sous Linux)', 'Kdenlive (VA-API / NVENC)', 'Blender VSE'];
  if (hw.gpuVendor === 'amd') notes.push('Sous Linux, Resolve accélère via OpenCL/ROCm : vérifier la prise en charge du GPU');
  if (hw.ramGb < 32) notes.push('32 Go de RAM recommandés pour le montage 4K');
  return {
    workload: 'video_editing',
    label: 'Montage vidéo',
    windowsScore: Math.round(base),
    linuxScore: Math.round(base * (hw.gpuVendor === 'nvidia' || hw.hasEncoder ? 1 : 0.95)),
    linuxTools,
    windowsTools: ['DaVinci Resolve', 'Adobe Premiere Pro', 'HandBrake (NVENC / QSV / VCE)'],
    notes,
    limitingFactor: limiting({ CPU: hw.cpuMulti, GPU: gpuRaster, RAM: ram, Stockage: hw.storageScore }),
  };
}

function softwareDev(hw: Hardware): WorkloadEstimate {
  const ram = ladder(hw.ramGb, [[8, 35], [16, 75], [32, 100]]);
  const base = 0.4 * hw.cpuMulti + 0.25 * ram + 0.2 * hw.storageScore + 0.15 * hw.cpuSingle;
  const notes = ['Conteneurs natifs (Docker / Podman) sans la couche WSL2 : E/S disque et démarrage bien plus rapides sous Linux'];
  if (hw.ramGb < 16) notes.push('16 Go minimum pour IDE + conteneurs + navigateur');
  return {
    workload: 'software_dev',
    label: 'Développement logiciel',
    windowsScore: Math.round(base),
    linuxScore: Math.round(Math.min(100, base * 1.05)),
    linuxTools: ['Docker / Podman natifs', 'VS Code, JetBrains, Neovim', 'distrobox / toolbox', 'ccache, mold'],
    windowsTools: ['WSL2 + Docker Desktop', 'Visual Studio / VS Code', 'Windows Terminal'],
    notes,
    limitingFactor: limiting({ CPU: hw.cpuMulti, RAM: ram, Stockage: hw.storageScore }),
  };
}

function rendering3d(hw: Hardware): WorkloadEstimate {
  const ram = ladder(hw.ramGb, [[8, 20], [16, 55], [32, 85], [64, 100]]);
  const cpuFallback = hw.cpuMulti * 0.6;
  const win = Math.max(gpuCompute(hw, 'windows'), cpuFallback);
  const lin = Math.max(gpuCompute(hw, 'linux'), cpuFallback);
  const score = (gpu: number): number => 0.6 * gpu + 0.25 * hw.cpuMulti + 0.15 * ram;
  const notes: string[] = [];
  const linuxTools = ['Blender (Cycles)'];
  switch (hw.gpuVendor) {
    case 'nvidia':
      linuxTools.push('CUDA / OptiX : mêmes performances que sous Windows');
      break;
    case 'amd':
      linuxTools.push(hw.rocmOfficial ? 'HIP via ROCm (GPU dans la liste officielle)' : 'HIP via ROCm (GPU hors liste officielle : HSA_OVERRIDE_GFX_VERSION, non garanti)');
      notes.push('ROCm est d\'abord une pile Linux : AMD y est mieux exploité que sous Windows');
      break;
    case 'intel':
      linuxTools.push('oneAPI / Level Zero (Intel Arc)');
      break;
    case 'other':
      notes.push('Rendu GPU non disponible : Cycles en mode CPU');
      break;
  }
  if (hw.gpuIntegrated) notes.push('iGPU : le rendu CPU sera généralement plus rapide et plus stable');
  return {
    workload: 'rendering_3d',
    label: 'Rendu 3D',
    windowsScore: Math.round(score(win)),
    linuxScore: Math.round(score(lin)),
    linuxTools,
    windowsTools: ['Blender (CUDA / OptiX / HIP / oneAPI)', 'Autodesk Maya, 3ds Max', 'V-Ray, Octane'],
    notes,
    limitingFactor: limiting({ 'GPU (calcul)': Math.max(win, lin), CPU: hw.cpuMulti, RAM: ram }),
  };
}

function localAi(hw: Hardware): WorkloadEstimate {
  // Un LLM 7-8B quantifié tient dans ~5-6 Go, 13B dans ~9-10 Go, 70B dans ~40 Go.
  const vram = hw.gpuIntegrated
    ? ladder(hw.ramGb, [[8, 15], [16, 35], [32, 55], [64, 75], [128, 90]])
    : ladder(hw.gpuVramGb, [[4, 20], [6, 35], [8, 50], [12, 70], [16, 85], [24, 100]]);
  const win = vram * (gpuCompute(hw, 'windows') / Math.max(1, Math.min(100, hw.gpuIndex * 1.2)) || 0.3);
  const lin = vram * (gpuCompute(hw, 'linux') / Math.max(1, Math.min(100, hw.gpuIndex * 1.2)) || 0.3);
  const notes: string[] = [];
  const linuxTools = ['llama.cpp / Ollama', 'PyTorch'];
  if (hw.gpuVendor === 'nvidia') linuxTools.push('CUDA + cuDNN (identique à Windows)');
  if (hw.gpuVendor === 'amd') {
    linuxTools.push('ROCm (PyTorch officiel sur Linux uniquement)');
    notes.push('Avantage Linux : PyTorch ROCm n\'est officiellement supporté que sous Linux');
  }
  if (hw.gpuVendor === 'intel') linuxTools.push('OpenVINO / IPEX (Intel)');
  if (hw.hasNpu) notes.push('NPU : pilote noyau (intel_vpu ≥ 6.8, amdxdna ≥ 6.14) + runtime OpenVINO / Ryzen AI ; écosystème encore jeune sous Linux');
  if (hw.gpuIntegrated) notes.push('Mémoire unifiée : la taille de modèle possible dépend de la RAM, la vitesse reste limitée');
  return {
    workload: 'local_ai',
    label: 'IA locale (LLM, diffusion)',
    windowsScore: Math.round(Math.min(100, win)),
    linuxScore: Math.round(Math.min(100, lin)),
    linuxTools,
    windowsTools: ['Ollama / LM Studio', 'PyTorch (CUDA ; DirectML pour AMD/Intel)'],
    notes,
    limitingFactor: hw.gpuIntegrated ? 'RAM (mémoire unifiée)' : `VRAM (${hw.gpuVramGb} Go)`,
  };
}

function limiting(scores: Record<string, number>): string {
  let worst = '';
  let min = Number.POSITIVE_INFINITY;
  for (const [name, value] of Object.entries(scores)) {
    if (value < min) {
      min = value;
      worst = name;
    }
  }
  return worst;
}
