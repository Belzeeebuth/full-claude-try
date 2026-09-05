// =============================================================================
//  Fixtures : composants
//
//  Valeurs INDICATIVES — indices de performance approximatifs (RTX 4090 fixe =
//  100, dérivés des scores 3DMark Time Spy publics), versions de noyau issues
//  des notes de version et de l'Arch Wiki au moment de la rédaction. En
//  production, ces lignes viennent des tables `components` / `linux_support`,
//  rafraîchies par les jobs d'import (voir docs/02-base-de-donnees.md).
// =============================================================================

import type { Component } from '../types.js';

const inTree = (name: string, firmwarePackage?: string): Component['linux']['driver'] =>
  firmwarePackage ? { name, type: 'in_tree_firmware', firmwarePackage } : { name, type: 'in_tree' };

export const COMPONENTS = {
  // ---- CPU ----------------------------------------------------------------
  'cpu-i7-13700h': {
    id: 'cpu-i7-13700h',
    family: 'cpu',
    vendor: 'intel',
    name: 'Intel Core i7-13700H',
    launchYear: 2023,
    cpu: { gamingIndex: 72, multiIndex: 62, cores: 14, threads: 20, tdpW: 45 },
    linux: { status: 'plug_and_play', kernelMin: '5.19', driver: inTree('intel_pstate'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'cpu-r7-8845hs': {
    id: 'cpu-r7-8845hs',
    family: 'cpu',
    vendor: 'amd',
    name: 'AMD Ryzen 7 8845HS',
    launchYear: 2024,
    cpu: { gamingIndex: 73, multiIndex: 60, cores: 8, threads: 16, tdpW: 45, npu: true },
    linux: { status: 'plug_and_play', kernelMin: '6.2', driver: inTree('amd_pstate'), secureBootImpact: 'none', confidence: 0.9 },
  },
  'cpu-ryzen-ai-9-hx-370': {
    id: 'cpu-ryzen-ai-9-hx-370',
    family: 'cpu',
    vendor: 'amd',
    name: 'AMD Ryzen AI 9 HX 370',
    launchYear: 2024,
    cpu: { gamingIndex: 76, multiIndex: 70, cores: 12, threads: 24, tdpW: 28, npu: true },
    linux: {
      status: 'plug_and_play',
      kernelMin: '6.10',
      kernelRecommended: '6.11',
      driver: inTree('amd_pstate'),
      secureBootImpact: 'none',
      confidence: 0.85,
      knownIssues: [
        { summary: 'NPU (XDNA) : pilote amdxdna disponible à partir du noyau 6.14', severity: 'minor', fixedInKernel: '6.14' },
      ],
    },
  },
  'cpu-r7-7800x3d': {
    id: 'cpu-r7-7800x3d',
    family: 'cpu',
    vendor: 'amd',
    name: 'AMD Ryzen 7 7800X3D',
    launchYear: 2023,
    cpu: { gamingIndex: 95, multiIndex: 55, cores: 8, threads: 16, tdpW: 120 },
    linux: { status: 'plug_and_play', kernelMin: '6.0', driver: inTree('amd_pstate'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'cpu-apple-m3': {
    id: 'cpu-apple-m3',
    family: 'cpu',
    vendor: 'apple',
    name: 'Apple M3',
    launchYear: 2023,
    cpu: { gamingIndex: 60, multiIndex: 50, cores: 8, threads: 8, npu: true },
    linux: {
      status: 'unsupported',
      driver: { name: 'asahi', type: 'none' },
      secureBootImpact: 'none',
      confidence: 0.9,
      knownIssues: [{ summary: 'Asahi Linux ne prend pas en charge les puces M3 et ultérieures', severity: 'blocking' }],
    },
  },
  'cpu-n100': {
    id: 'cpu-n100',
    family: 'cpu',
    vendor: 'intel',
    name: 'Intel N100',
    launchYear: 2023,
    cpu: { gamingIndex: 22, multiIndex: 12, cores: 4, threads: 4, tdpW: 6 },
    linux: { status: 'plug_and_play', kernelMin: '6.0', driver: inTree('intel_pstate'), secureBootImpact: 'none', confidence: 0.9 },
  },

  // ---- GPU ----------------------------------------------------------------
  'gpu-rtx-4060-laptop': {
    id: 'gpu-rtx-4060-laptop',
    family: 'gpu',
    vendor: 'nvidia',
    name: 'NVIDIA GeForce RTX 4060 Laptop',
    launchYear: 2023,
    gpu: {
      perfIndex: 29,
      vramGb: 8,
      integrated: false,
      tgpMaxW: 140,
      tgpMinW: 35,
      architecture: 'ada',
      features: { rayTracing: true, rtEfficiency: 1, upscalers: ['dlss', 'fsr', 'xess'], encoders: ['nvenc'], compute: ['cuda'] },
    },
    linux: {
      status: 'tweaks_required',
      proprietaryDriverMin: '525',
      driver: { name: 'nvidia', type: 'proprietary' },
      secureBootImpact: 'mok_enrollment',
      confidence: 0.95,
      knownIssues: [
        {
          summary: 'Graphismes hybrides (Optimus) : le dGPU est utilisé à la demande',
          severity: 'minor',
          workaround: 'Lancer les jeux avec PRIME render offload (prime-run ou __NV_PRIME_RENDER_OFFLOAD=1)',
        },
      ],
    },
  },
  'gpu-rtx-5070': {
    id: 'gpu-rtx-5070',
    family: 'gpu',
    vendor: 'nvidia',
    name: 'NVIDIA GeForce RTX 5070',
    launchYear: 2025,
    gpu: {
      perfIndex: 61,
      vramGb: 12,
      integrated: false,
      architecture: 'blackwell',
      features: { rayTracing: true, rtEfficiency: 1, upscalers: ['dlss', 'fsr', 'xess'], encoders: ['nvenc'], compute: ['cuda'] },
    },
    linux: {
      status: 'tweaks_required',
      proprietaryDriverMin: '570',
      driver: { name: 'nvidia-open', type: 'proprietary' },
      secureBootImpact: 'mok_enrollment',
      confidence: 0.9,
      knownIssues: [{ summary: 'Blackwell : seuls les modules noyau ouverts (nvidia-open) sont pris en charge', severity: 'minor' }],
    },
  },
  'gpu-rx-7800-xt': {
    id: 'gpu-rx-7800-xt',
    family: 'gpu',
    vendor: 'amd',
    name: 'AMD Radeon RX 7800 XT',
    launchYear: 2023,
    gpu: {
      perfIndex: 56,
      vramGb: 16,
      integrated: false,
      architecture: 'rdna3',
      features: { rayTracing: true, rtEfficiency: 0.7, upscalers: ['fsr', 'xess'], encoders: ['vcn'], compute: ['rocm'], rocmOfficial: true },
    },
    linux: {
      status: 'plug_and_play',
      kernelMin: '6.5',
      mesaMin: '23.1',
      driver: inTree('amdgpu', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.95,
    },
  },
  'gpu-radeon-890m': {
    id: 'gpu-radeon-890m',
    family: 'gpu',
    vendor: 'amd',
    name: 'AMD Radeon 890M',
    launchYear: 2024,
    gpu: {
      perfIndex: 10.5,
      vramGb: 0,
      integrated: true,
      architecture: 'rdna3.5',
      features: { rayTracing: true, rtEfficiency: 0.5, upscalers: ['fsr', 'xess'], encoders: ['vcn'], compute: ['rocm'] },
    },
    linux: {
      status: 'plug_and_play',
      kernelMin: '6.10',
      kernelRecommended: '6.11',
      mesaMin: '24.1',
      driver: inTree('amdgpu', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.85,
    },
  },
  'gpu-radeon-780m': {
    id: 'gpu-radeon-780m',
    family: 'gpu',
    vendor: 'amd',
    name: 'AMD Radeon 780M',
    launchYear: 2023,
    gpu: {
      perfIndex: 9,
      vramGb: 0,
      integrated: true,
      architecture: 'rdna3',
      features: { rayTracing: true, rtEfficiency: 0.5, upscalers: ['fsr', 'xess'], encoders: ['vcn'], compute: ['rocm'] },
    },
    linux: { status: 'plug_and_play', kernelMin: '6.2', mesaMin: '23.0', driver: inTree('amdgpu', 'linux-firmware'), secureBootImpact: 'none', confidence: 0.9 },
  },
  'gpu-iris-xe-96': {
    id: 'gpu-iris-xe-96',
    family: 'gpu',
    vendor: 'intel',
    name: 'Intel Iris Xe Graphics (96 EU)',
    launchYear: 2021,
    gpu: {
      perfIndex: 4.7,
      vramGb: 0,
      integrated: true,
      architecture: 'xe-lp',
      features: { rayTracing: false, upscalers: ['fsr', 'xess'], encoders: ['qsv'], compute: ['oneapi'] },
    },
    linux: { status: 'plug_and_play', kernelMin: '5.11', mesaMin: '21.0', driver: inTree('i915', 'linux-firmware'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'gpu-arc-b580': {
    id: 'gpu-arc-b580',
    family: 'gpu',
    vendor: 'intel',
    name: 'Intel Arc B580',
    launchYear: 2024,
    gpu: {
      perfIndex: 40,
      vramGb: 12,
      integrated: false,
      architecture: 'xe2',
      features: { rayTracing: true, rtEfficiency: 0.85, upscalers: ['xess', 'fsr'], encoders: ['qsv'], compute: ['oneapi'] },
    },
    linux: {
      status: 'plug_and_play',
      kernelMin: '6.12',
      kernelRecommended: '6.13',
      mesaMin: '24.3',
      driver: inTree('xe', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.8,
    },
  },
  'gpu-apple-m3': {
    id: 'gpu-apple-m3',
    family: 'gpu',
    vendor: 'apple',
    name: 'Apple M3 GPU (10 cœurs)',
    launchYear: 2023,
    gpu: { perfIndex: 8, vramGb: 0, integrated: true, features: { rayTracing: true, rtEfficiency: 0.4, upscalers: [] } },
    linux: { status: 'unsupported', driver: { name: 'asahi', type: 'none' }, secureBootImpact: 'none', confidence: 0.9 },
  },
  'gpu-uhd-n100': {
    id: 'gpu-uhd-n100',
    family: 'gpu',
    vendor: 'intel',
    name: 'Intel UHD Graphics (N100)',
    launchYear: 2023,
    gpu: { perfIndex: 1.2, vramGb: 0, integrated: true, features: { rayTracing: false, upscalers: ['fsr'], encoders: ['qsv'] } },
    linux: { status: 'plug_and_play', kernelMin: '6.0', driver: inTree('i915', 'linux-firmware'), secureBootImpact: 'none', confidence: 0.9 },
  },

  // ---- Wi-Fi --------------------------------------------------------------
  'wifi-intel-ax211': {
    id: 'wifi-intel-ax211',
    family: 'wifi',
    vendor: 'intel',
    name: 'Intel Wi-Fi 6E AX211',
    launchYear: 2021,
    linux: { status: 'plug_and_play', kernelMin: '5.14', driver: inTree('iwlwifi', 'linux-firmware'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'wifi-mediatek-mt7922': {
    id: 'wifi-mediatek-mt7922',
    family: 'wifi',
    vendor: 'mediatek',
    name: 'MediaTek MT7922 (AMD RZ616) Wi-Fi 6E',
    launchYear: 2022,
    linux: { status: 'plug_and_play', kernelMin: '5.18', driver: inTree('mt7921e', 'linux-firmware'), secureBootImpact: 'none', confidence: 0.9 },
  },
  'wifi-realtek-rtl8852be': {
    id: 'wifi-realtek-rtl8852be',
    family: 'wifi',
    vendor: 'realtek',
    name: 'Realtek RTL8852BE Wi-Fi 6',
    launchYear: 2022,
    linux: {
      status: 'plug_and_play',
      kernelMin: '6.2',
      kernelRecommended: '6.4',
      driver: inTree('rtw89', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.8,
      knownIssues: [{ summary: 'Débits réduits en coexistence Wi-Fi / Bluetooth sur certains firmwares', severity: 'minor' }],
    },
  },
  'wifi-broadcom-bcm4360': {
    id: 'wifi-broadcom-bcm4360',
    family: 'wifi',
    vendor: 'broadcom',
    name: 'Broadcom BCM4360',
    launchYear: 2013,
    linux: {
      status: 'tweaks_required',
      driver: { name: 'wl (broadcom-sta)', type: 'proprietary' },
      secureBootImpact: 'mok_enrollment',
      confidence: 0.85,
    },
  },
  'wifi-unknown-usb': {
    id: 'wifi-unknown-usb',
    family: 'wifi',
    vendor: 'other',
    name: 'Adaptateur Wi-Fi USB non identifié',
    linux: { status: 'unknown', driver: { name: '?', type: 'none' }, secureBootImpact: 'none', confidence: 0.5 },
  },

  // ---- Audio / webcam / empreintes / stockage / divers ---------------------
  'audio-realtek-sof': {
    id: 'audio-realtek-sof',
    family: 'audio',
    vendor: 'realtek',
    name: 'Realtek ALC (Intel SOF)',
    linux: { status: 'plug_and_play', kernelMin: '5.10', driver: inTree('snd_sof', 'sof-firmware'), secureBootImpact: 'none', confidence: 0.9 },
  },
  'audio-cirrus-cs35l41': {
    id: 'audio-cirrus-cs35l41',
    family: 'audio',
    vendor: 'other',
    name: 'Cirrus Logic CS35L41 (amplificateur)',
    launchYear: 2022,
    linux: {
      status: 'tweaks_required',
      kernelMin: '6.2',
      kernelRecommended: '6.5',
      driver: inTree('snd_hda_scodec_cs35l41', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.75,
      knownIssues: [
        {
          summary: 'Haut-parleurs muets tant que le firmware CS35L41 propre au modèle est absent',
          severity: 'major',
          workaround: 'Installer un linux-firmware récent ; certains modèles exigent un correctif _DSD (voir bugzilla.kernel.org)',
        },
      ],
    },
  },
  'webcam-uvc': {
    id: 'webcam-uvc',
    family: 'webcam',
    vendor: 'other',
    name: 'Webcam USB (UVC)',
    linux: { status: 'plug_and_play', driver: inTree('uvcvideo'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'webcam-intel-ipu6': {
    id: 'webcam-intel-ipu6',
    family: 'webcam',
    vendor: 'intel',
    name: 'Caméra MIPI Intel IPU6',
    launchYear: 2022,
    linux: {
      status: 'partial',
      kernelMin: '6.10',
      driver: inTree('intel_ipu6', 'linux-firmware'),
      secureBootImpact: 'none',
      confidence: 0.7,
      knownIssues: [
        { summary: 'Pile libcamera / IPU6 incomplète : image dégradée ou absente selon l\'application', severity: 'major' },
      ],
    },
  },
  'fp-synaptics-06cb-00bd': {
    id: 'fp-synaptics-06cb-00bd',
    family: 'fingerprint',
    vendor: 'other',
    name: 'Lecteur d\'empreintes Synaptics (06cb:00bd)',
    linux: { status: 'plug_and_play', driver: inTree('libfprint (userspace)'), secureBootImpact: 'none', confidence: 0.8 },
  },
  'fp-goodix-27c6-550a': {
    id: 'fp-goodix-27c6-550a',
    family: 'fingerprint',
    vendor: 'other',
    name: 'Lecteur d\'empreintes Goodix (27c6:550a)',
    linux: { status: 'unsupported', driver: { name: 'libfprint', type: 'none' }, secureBootImpact: 'none', confidence: 0.7 },
  },
  'ssd-nvme-generic': {
    id: 'ssd-nvme-generic',
    family: 'storage',
    vendor: 'other',
    name: 'SSD NVMe PCIe (contrôleur standard)',
    linux: { status: 'plug_and_play', driver: inTree('nvme'), secureBootImpact: 'none', confidence: 0.95 },
  },
  'touchpad-i2c-hid': {
    id: 'touchpad-i2c-hid',
    family: 'touchpad',
    vendor: 'other',
    name: 'Pavé tactile I2C HID (Precision)',
    linux: { status: 'plug_and_play', driver: inTree('i2c_hid'), secureBootImpact: 'none', confidence: 0.9 },
  },
  'eth-realtek-rtl8125': {
    id: 'eth-realtek-rtl8125',
    family: 'ethernet',
    vendor: 'realtek',
    name: 'Realtek RTL8125 2.5 GbE',
    launchYear: 2019,
    linux: { status: 'plug_and_play', kernelMin: '5.9', driver: inTree('r8169'), secureBootImpact: 'none', confidence: 0.95 },
  },
} as const satisfies Record<string, Component>;

export type ComponentId = keyof typeof COMPONENTS;

export function component(id: ComponentId): Component {
  return COMPONENTS[id];
}
