// Ce que le vrai produit fait côté serveur (adaptateurs marchands, scraping,
// matching) est ici réduit à une reconnaissance de démonstration : on détecte
// le marchand et sa référence comme le ferait l'adaptateur, puis on rapproche le
// texte des six configurations de démonstration.
import type { PcConfiguration } from '@pc-analyzer/engine';
import { ALL_PCS } from '@pc-analyzer/engine/fixtures';

export interface RetailerHit {
  retailer: string;
  externalId: string;
}

const RETAILERS: { retailer: string; host: RegExp; id: RegExp }[] = [
  { retailer: 'Amazon', host: /amazon\.(?:fr|com|de|es|it|co\.uk|nl|be)/i, id: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i },
  { retailer: 'Fnac', host: /fnac\.com/i, id: /\/a(\d{6,9})\b/i },
  { retailer: 'Boulanger', host: /boulanger\.com/i, id: /\/ref\/(\d{6,8})/i },
  { retailer: 'Cdiscount', host: /cdiscount\.com/i, id: /\/f-\d+-([a-z0-9-]+)\.html/i },
  { retailer: 'Darty', host: /darty\.com/i, id: /_([a-z0-9]{6,})\.html/i },
  { retailer: 'LDLC', host: /ldlc\.com/i, id: /\/fiche\/([A-Z0-9]+)\.html/i },
];

export function detectRetailer(input: string): RetailerHit | null {
  for (const r of RETAILERS) {
    if (r.host.test(input)) {
      const m = input.match(r.id);
      return { retailer: r.retailer, externalId: m?.[1] ?? 'référence non lue' };
    }
  }
  if (/^B0[A-Z0-9]{8}$/i.test(input.trim())) return { retailer: 'Amazon', externalId: input.trim().toUpperCase() };
  return null;
}

const DEMO_KEYWORDS: [RegExp, string][] = [
  [/legion|lenovo|13700h|rtx ?4060/i, 'pc-legion-5'],
  [/zenbook|asus|hx ?370|890m|ryzen ai/i, 'pc-zenbook-s16'],
  [/7800 ?xt|7800x3d|radeon rx/i, 'pc-desktop-amd'],
  [/rtx ?5070|blackwell|rtx ?50/i, 'pc-desktop-rtx-5070'],
  [/macbook|apple|\bm3\b/i, 'pc-macbook-air-m3'],
  [/n100|mini ?pc/i, 'pc-mini-n100'],
];

export function matchDemoPc(input: string): PcConfiguration | null {
  for (const [re, id] of DEMO_KEYWORDS) {
    if (re.test(input)) return ALL_PCS.find((p) => p.id === id) ?? null;
  }
  return null;
}

// -----------------------------------------------------------------------------
//  Diagnostic virtuel (règles de démonstration, cf. docs/03-algorithmes.md § 5)
// -----------------------------------------------------------------------------

export interface Diagnostic {
  strengths: string[];
  weaknesses: string[];
  repairability: number;
  upgradability: number;
  perfIndex: number;
  perfPrice: number | null;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function diagnose(pc: PcConfiguration): Diagnostic {
  const cpu = pc.components.find((c) => c.role === 'cpu')?.component.cpu;
  const gpuComponent =
    pc.components.find((c) => c.role === 'gpu_discrete')?.component ??
    pc.components.find((c) => c.role === 'gpu_integrated')?.component;
  const gpu = gpuComponent?.gpu;
  const strengths: string[] = [];
  const weaknesses: string[] = [];

  if (pc.ram.totalGb >= 32) strengths.push(`${pc.ram.totalGb} Go de RAM : confortable pour le multitâche, le montage et les conteneurs`);
  else if (pc.ram.totalGb < 16) weaknesses.push(`${pc.ram.totalGb} Go de RAM : limite en 2026, surtout avec un GPU intégré`);
  if (pc.ram.channels === 1) weaknesses.push("Mémoire en simple canal : jusqu'à 30 % de performance en moins avec un GPU intégré");
  if (pc.ram.soldered) weaknesses.push('RAM soudée : non évolutive');
  else if ((pc.ram.slotsFree ?? 0) > 0) strengths.push(`${pc.ram.slotsFree} emplacement(s) RAM libre(s), jusqu'à ${pc.ram.maxGb ?? '?'} Go`);

  if (pc.storage.some((s) => s.type === 'nvme')) strengths.push('Stockage NVMe');
  else if (pc.storage.every((s) => s.type === 'hdd' || s.type === 'emmc')) weaknesses.push('Stockage lent (disque dur ou eMMC)');
  else weaknesses.push("SSD SATA : chargements plus lents qu'en NVMe");

  if (gpu) {
    if (!gpu.integrated && gpu.perfIndex >= 40) strengths.push(`GPU puissant (indice ${gpu.perfIndex}) : 1440p confortable`);
    if (gpu.integrated && gpu.perfIndex < 5) weaknesses.push("GPU intégré d'entrée de gamme : jeux récents en 1080p bas uniquement");
    if (!gpu.integrated && gpu.vramGb <= 8) weaknesses.push(`${gpu.vramGb} Go de VRAM : juste pour les textures ultra en 1440p`);
    if (gpuComponent?.vendor === 'nvidia') weaknesses.push('GPU NVIDIA : pilote propriétaire sous Linux (Secure Boot : clé MOK à enrôler)');
  }
  if (cpu && cpu.gamingIndex >= 85) strengths.push('CPU jeu excellent (cache 3D, haute fréquence)');
  if (cpu && gpu && !gpu.integrated && gpu.perfIndex / cpu.gamingIndex > 0.75) {
    weaknesses.push('Le CPU peut brider le GPU dans les jeux très demandeurs en processeur');
  }
  if (pc.kind === 'laptop' && pc.batteryWh !== undefined) {
    if (pc.batteryWh >= 75) strengths.push(`Batterie de ${pc.batteryWh} Wh`);
    else if (pc.batteryWh < 50) weaknesses.push(`Batterie de ${pc.batteryWh} Wh : autonomie limitée`);
  }
  if (pc.linuxVendorCertified?.length) strengths.push('Certifié ou vendu sous Linux');
  if (pc.components.some((c) => c.component.linux.status === 'unsupported')) weaknesses.push('Au moins un composant sans prise en charge Linux');
  if (pc.firmware.intelVmdRaidDefault) weaknesses.push('Intel VMD/RST actif par défaut : disque invisible pour un installeur Linux sans passage en AHCI');

  let repairability = 5;
  repairability += pc.ram.soldered ? -2 : 1;
  repairability += pc.ram.type === 'unified' ? -1 : 0;
  repairability += pc.kind === 'desktop' ? 3 : 1;
  repairability = clamp(repairability, 0, 10);

  let upgradability = Math.min(6, (pc.ram.slotsFree ?? 0) * 3);
  if (pc.ram.maxGb && pc.ram.maxGb >= pc.ram.totalGb * 2) upgradability += 1;
  if (!pc.ram.soldered) upgradability += 1;
  if (pc.kind === 'desktop') upgradability += 3;
  upgradability = clamp(upgradability, 0, 10);

  const memScore = Math.min(100, (pc.ram.totalGb / 32) * 60 + (pc.storage.some((s) => s.type === 'nvme') ? 40 : 20));
  const perfIndex = 0.5 * (gpu?.perfIndex ?? 0) + 0.3 * (cpu?.gamingIndex ?? 0) + 0.2 * memScore;
  const perfPrice = pc.priceEur ? (perfIndex / pc.priceEur) * 1000 : null;

  return { strengths, weaknesses, repairability, upgradability, perfIndex, perfPrice };
}
