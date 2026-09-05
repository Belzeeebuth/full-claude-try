import type { PcConfiguration } from '../types.js';
import { component } from './components.js';

/** Portable gaming Intel + NVIDIA + Realtek : le cas « orange » typique. */
export const LEGION_5: PcConfiguration = {
  id: 'pc-legion-5',
  name: 'Lenovo Legion 5 15 (i7-13700H / RTX 4060 140 W)',
  kind: 'laptop',
  priceEur: 1299,
  components: [
    { role: 'cpu', component: component('cpu-i7-13700h') },
    { role: 'gpu_integrated', component: component('gpu-iris-xe-96') },
    { role: 'gpu_discrete', component: component('gpu-rtx-4060-laptop'), tgpW: 140 },
    { role: 'wifi', component: component('wifi-realtek-rtl8852be') },
    { role: 'audio', component: component('audio-cirrus-cs35l41') },
    { role: 'webcam', component: component('webcam-uvc') },
    { role: 'storage', component: component('ssd-nvme-generic') },
    { role: 'touchpad', component: component('touchpad-i2c-hid') },
  ],
  ram: { totalGb: 16, type: 'ddr5', speedMt: 5600, channels: 2, soldered: false, slotsFree: 0, maxGb: 64 },
  storage: [{ type: 'nvme', capacityGb: 512 }],
  firmware: { secureBootDefault: true, tpm: true },
  batteryWh: 80,
};

/** Ultraportable tout AMD + MediaTek : matériel récent, plug & play sur noyau ≥ 6.10. */
export const ZENBOOK_S16: PcConfiguration = {
  id: 'pc-zenbook-s16',
  name: 'ASUS Zenbook S 16 (Ryzen AI 9 HX 370 / Radeon 890M)',
  kind: 'laptop',
  priceEur: 1699,
  components: [
    { role: 'cpu', component: component('cpu-ryzen-ai-9-hx-370') },
    { role: 'gpu_integrated', component: component('gpu-radeon-890m') },
    { role: 'wifi', component: component('wifi-mediatek-mt7922') },
    { role: 'audio', component: component('audio-realtek-sof') },
    { role: 'webcam', component: component('webcam-uvc') },
    { role: 'fingerprint', component: component('fp-synaptics-06cb-00bd') },
    { role: 'storage', component: component('ssd-nvme-generic') },
    { role: 'touchpad', component: component('touchpad-i2c-hid') },
  ],
  ram: { totalGb: 32, type: 'lpddr5x', speedMt: 7500, channels: 2, soldered: true, slotsFree: 0, maxGb: 32 },
  storage: [{ type: 'nvme', capacityGb: 1024 }],
  firmware: { secureBootDefault: true, tpm: true },
  batteryWh: 78,
};

/** Fixe tout AMD avec Ethernet : le cas « vert ». */
export const DESKTOP_AMD: PcConfiguration = {
  id: 'pc-desktop-amd',
  name: 'PC fixe Ryzen 7 7800X3D / Radeon RX 7800 XT',
  kind: 'desktop',
  priceEur: 1499,
  components: [
    { role: 'cpu', component: component('cpu-r7-7800x3d') },
    { role: 'gpu_discrete', component: component('gpu-rx-7800-xt') },
    { role: 'ethernet', component: component('eth-realtek-rtl8125') },
    { role: 'wifi', component: component('wifi-intel-ax211') },
    { role: 'audio', component: component('audio-realtek-sof') },
    { role: 'storage', component: component('ssd-nvme-generic') },
  ],
  ram: { totalGb: 32, type: 'ddr5', speedMt: 6000, channels: 2, soldered: false, slotsFree: 2, maxGb: 128 },
  storage: [{ type: 'nvme', capacityGb: 2000 }],
  firmware: { secureBootDefault: false, tpm: true },
};

/** Fixe avec RTX 5070 : teste la porte « version de pilote NVIDIA ». */
export const DESKTOP_RTX_5070: PcConfiguration = {
  id: 'pc-desktop-rtx-5070',
  name: 'PC fixe Ryzen 7 7800X3D / GeForce RTX 5070',
  kind: 'desktop',
  priceEur: 1599,
  components: [
    { role: 'cpu', component: component('cpu-r7-7800x3d') },
    { role: 'gpu_discrete', component: component('gpu-rtx-5070') },
    { role: 'ethernet', component: component('eth-realtek-rtl8125') },
    { role: 'storage', component: component('ssd-nvme-generic') },
  ],
  ram: { totalGb: 32, type: 'ddr5', speedMt: 6000, channels: 2, soldered: false, slotsFree: 2, maxGb: 128 },
  storage: [{ type: 'nvme', capacityGb: 1000 }],
  firmware: { secureBootDefault: true, tpm: true },
};

/** Apple Silicon M3 : le cas « rouge ». */
export const MACBOOK_AIR_M3: PcConfiguration = {
  id: 'pc-macbook-air-m3',
  name: 'Apple MacBook Air 13 (M3)',
  kind: 'laptop',
  priceEur: 1299,
  components: [
    { role: 'cpu', component: component('cpu-apple-m3') },
    { role: 'gpu_integrated', component: component('gpu-apple-m3') },
  ],
  ram: { totalGb: 16, type: 'unified', channels: 2, soldered: true },
  storage: [{ type: 'nvme', capacityGb: 256 }],
  firmware: { secureBootDefault: true },
};

/** Mini PC d'entrée de gamme, RAM en simple canal. */
export const MINI_N100: PcConfiguration = {
  id: 'pc-mini-n100',
  name: 'Mini PC Intel N100 (16 Go simple canal)',
  kind: 'mini_pc',
  priceEur: 199,
  components: [
    { role: 'cpu', component: component('cpu-n100') },
    { role: 'gpu_integrated', component: component('gpu-uhd-n100') },
    { role: 'wifi', component: component('wifi-intel-ax211') },
    { role: 'ethernet', component: component('eth-realtek-rtl8125') },
    { role: 'storage', component: component('ssd-nvme-generic') },
  ],
  ram: { totalGb: 16, type: 'ddr4', speedMt: 3200, channels: 1, soldered: false, slotsFree: 0, maxGb: 32 },
  storage: [{ type: 'sata_ssd', capacityGb: 512 }],
  firmware: { secureBootDefault: false },
};

export const ALL_PCS: PcConfiguration[] = [LEGION_5, ZENBOOK_S16, DESKTOP_AMD, DESKTOP_RTX_5070, MACBOOK_AIR_M3, MINI_N100];
