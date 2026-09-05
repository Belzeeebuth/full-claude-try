// Catalogue INDICATIF : exigences et plafonds CPU approximatifs, paliers
// ProtonDB tels qu'observés au moment de la rédaction. En production : tables
// `games`, `game_proton_status` (import ProtonDB) et `game_benchmarks`.
import type { Game, GameBenchmark, Vendor } from '../types.js';

type RefGpu = { gpuName: string; gpuVendor: Vendor; gpuPerfIndex: number; cpuGamingIndex: number };

export const GAMES: Game[] = [
  {
    id: 'cyberpunk-2077',
    name: 'Cyberpunk 2077',
    steamAppId: 1091500,
    apis: ['dx12'],
    antiCheat: { kind: 'none', linux: 'supported' },
    proton: { tier: 'gold', confidence: 'strong', reports: 4200, steamDeck: 'verified' },
    requirements: { minRamGb: 12, recRamGb: 16, vramGb: { low: 4, medium: 5, high: 6.5, ultra: 8 } },
    cpuBoundFpsRef: 170,
    rayTracing: { available: true, cost: 0.55 },
    upscalers: ['dlss', 'fsr', 'xess'],
  },
  {
    id: 'counter-strike-2',
    name: 'Counter-Strike 2',
    steamAppId: 730,
    apis: ['dx11'],
    linuxNative: { api: 'vulkan', perfRatio: 0.85 },
    antiCheat: { kind: 'vac', linux: 'supported' },
    requirements: { minRamGb: 8, recRamGb: 16, vramGb: { low: 2, medium: 3, high: 4, ultra: 5 } },
    cpuBoundFpsRef: 480,
    upscalers: [],
  },
  {
    id: 'elden-ring',
    name: 'Elden Ring',
    steamAppId: 1245620,
    apis: ['dx12'],
    antiCheat: { kind: 'eac', linux: 'supported' },
    proton: { tier: 'platinum', confidence: 'strong', reports: 3100, steamDeck: 'verified' },
    requirements: { minRamGb: 12, recRamGb: 16, vramGb: { low: 3, medium: 4, high: 5, ultra: 6 } },
    cpuBoundFpsRef: 140,
    fpsCap: 60,
    rayTracing: { available: true, cost: 0.7 },
    upscalers: [],
  },
  {
    id: 'baldurs-gate-3',
    name: "Baldur's Gate 3",
    steamAppId: 1086940,
    apis: ['dx11', 'vulkan'],
    antiCheat: { kind: 'none', linux: 'supported' },
    proton: { tier: 'platinum', confidence: 'strong', reports: 2800, steamDeck: 'verified' },
    requirements: { minRamGb: 8, recRamGb: 16, vramGb: { low: 3, medium: 4, high: 6, ultra: 8 } },
    cpuBoundFpsRef: 150,
    upscalers: ['dlss', 'fsr'],
  },
  {
    id: 'hogwarts-legacy',
    name: 'Hogwarts Legacy',
    steamAppId: 990080,
    apis: ['dx12'],
    antiCheat: { kind: 'none', linux: 'supported' },
    proton: { tier: 'gold', confidence: 'good', reports: 900, steamDeck: 'playable' },
    requirements: { minRamGb: 16, recRamGb: 16, vramGb: { low: 4, medium: 6, high: 8, ultra: 12 } },
    cpuBoundFpsRef: 130,
    rayTracing: { available: true, cost: 0.6 },
    upscalers: ['dlss', 'fsr', 'xess'],
  },
  {
    id: 'fortnite',
    name: 'Fortnite',
    apis: ['dx12', 'dx11'],
    antiCheat: { kind: 'eac', linux: 'blocked' },
    proton: { tier: 'borked', confidence: 'strong', reports: 1500, steamDeck: 'unsupported' },
    requirements: { minRamGb: 8, recRamGb: 16, vramGb: { low: 2, medium: 3, high: 4, ultra: 6 } },
    cpuBoundFpsRef: 300,
    upscalers: ['dlss', 'fsr', 'xess'],
  },
  {
    id: 'valorant',
    name: 'Valorant',
    apis: ['dx11'],
    antiCheat: { kind: 'vanguard', linux: 'blocked' },
    proton: { tier: 'borked', confidence: 'strong', reports: 600, steamDeck: 'unsupported' },
    requirements: { minRamGb: 4, recRamGb: 8, vramGb: { low: 1, medium: 1, high: 2, ultra: 2 } },
    cpuBoundFpsRef: 600,
    upscalers: [],
  },
  {
    id: 'minecraft-java',
    name: 'Minecraft (Java Edition)',
    apis: ['opengl'],
    linuxNative: { api: 'opengl', perfRatio: 1.0 },
    antiCheat: { kind: 'none', linux: 'supported' },
    requirements: { minRamGb: 4, recRamGb: 8, vramGb: { low: 1, medium: 1, high: 2, ultra: 3 } },
    cpuBoundFpsRef: 400,
    upscalers: [],
  },
];

const RTX_4060: RefGpu = { gpuName: 'GeForce RTX 4060', gpuVendor: 'nvidia', gpuPerfIndex: 30, cpuGamingIndex: 100 };
const RX_7800_XT: RefGpu = { gpuName: 'Radeon RX 7800 XT', gpuVendor: 'amd', gpuPerfIndex: 56, cpuGamingIndex: 100 };
const RTX_4090: RefGpu = { gpuName: 'GeForce RTX 4090', gpuVendor: 'nvidia', gpuPerfIndex: 100, cpuGamingIndex: 100 };
const RTX_3050: RefGpu = { gpuName: 'GeForce RTX 3050', gpuVendor: 'nvidia', gpuPerfIndex: 17, cpuGamingIndex: 100 };
const RADEON_780M: RefGpu = { gpuName: 'Radeon 780M', gpuVendor: 'amd', gpuPerfIndex: 9, cpuGamingIndex: 72 };
const IRIS_XE: RefGpu = { gpuName: 'Iris Xe (96 EU)', gpuVendor: 'intel', gpuPerfIndex: 4.7, cpuGamingIndex: 52 };

const win = (
  gameId: string,
  gpu: RefGpu,
  resolution: GameBenchmark['resolution'],
  preset: GameBenchmark['preset'],
  avgFps: number,
  low1pctFps?: number,
): GameBenchmark => ({
  gameId,
  os: 'windows',
  ...gpu,
  resolution,
  preset,
  rayTracing: false,
  upscaling: 'none',
  avgFps,
  low1pctFps,
  source: 'banc de référence (valeurs illustratives)',
});

/** Valeurs ILLUSTRATIVES, à remplacer par les imports de bancs publics. */
export const BENCHMARKS: GameBenchmark[] = [
  win('cyberpunk-2077', RTX_4060, '1080p', 'ultra', 68, 55),
  win('cyberpunk-2077', RX_7800_XT, '1440p', 'ultra', 85, 68),
  win('cyberpunk-2077', RTX_4090, '2160p', 'ultra', 75, 62),
  win('cyberpunk-2077', RADEON_780M, '1080p', 'low', 42, 30),
  {
    gameId: 'cyberpunk-2077',
    os: 'linux_proton',
    ...RX_7800_XT,
    resolution: '1440p',
    preset: 'ultra',
    rayTracing: false,
    upscaling: 'none',
    avgFps: 78,
    low1pctFps: 60,
    source: 'mesure Proton (valeur illustrative)',
  },
  win('counter-strike-2', RTX_4060, '1080p', 'high', 250, 160),
  win('counter-strike-2', RX_7800_XT, '1440p', 'high', 300, 190),
  {
    gameId: 'counter-strike-2',
    os: 'linux_native',
    ...RX_7800_XT,
    resolution: '1440p',
    preset: 'high',
    rayTracing: false,
    upscaling: 'none',
    avgFps: 265,
    low1pctFps: 150,
    source: 'mesure Linux native (valeur illustrative)',
  },
  win('elden-ring', RTX_4060, '1080p', 'ultra', 60, 48),
  win('elden-ring', RTX_3050, '1080p', 'high', 52, 40),
  win('baldurs-gate-3', RTX_4060, '1080p', 'ultra', 88, 65),
  win('baldurs-gate-3', RX_7800_XT, '1440p', 'ultra', 105, 78),
  win('hogwarts-legacy', RTX_4060, '1080p', 'ultra', 62, 45),
  win('hogwarts-legacy', RX_7800_XT, '1440p', 'ultra', 80, 60),
  win('fortnite', RTX_4060, '1080p', 'high', 140, 100),
  win('valorant', RTX_4060, '1080p', 'high', 400, 280),
  win('minecraft-java', RTX_4060, '1080p', 'high', 350, 200),
  win('minecraft-java', IRIS_XE, '1080p', 'medium', 90, 55),
];

export function game(id: string): Game {
  const found = GAMES.find((g) => g.id === id);
  if (!found) throw new Error(`Jeu inconnu dans les fixtures : ${id}`);
  return found;
}
