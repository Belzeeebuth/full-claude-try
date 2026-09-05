// =============================================================================
//  @pc-analyzer/engine — types du domaine
//
//  Ces types sont la projection « en mémoire » du schéma PostgreSQL décrit dans
//  packages/db/migrations/0001_init.sql (mêmes noms, mêmes énumérations). Le
//  moteur ne fait AUCUNE I/O : l'API charge les lignes, les convertit dans ces
//  structures, et le même code tourne côté navigateur pour les comparaisons
//  instantanées (changer la résolution ou le preset ne coûte pas un aller-retour).
// =============================================================================

/** Badge de couleur affiché dans l'interface. */
export type Badge = 'green' | 'orange' | 'red' | 'unknown';

// -----------------------------------------------------------------------------
//  Composants
// -----------------------------------------------------------------------------

export type ComponentFamily =
  | 'cpu'
  | 'gpu'
  | 'wifi'
  | 'bluetooth'
  | 'audio'
  | 'webcam'
  | 'fingerprint'
  | 'storage'
  | 'ethernet'
  | 'touchpad'
  | 'display'
  | 'chipset'
  | 'other';

/** Rôle joué par un composant DANS une configuration (un GPU peut être intégré ou dédié). */
export type ComponentRole =
  | 'cpu'
  | 'gpu_integrated'
  | 'gpu_discrete'
  | 'wifi'
  | 'bluetooth'
  | 'audio'
  | 'webcam'
  | 'fingerprint'
  | 'storage'
  | 'ethernet'
  | 'touchpad'
  | 'display'
  | 'other';

export type Vendor =
  | 'intel'
  | 'amd'
  | 'nvidia'
  | 'apple'
  | 'qualcomm'
  | 'mediatek'
  | 'realtek'
  | 'broadcom'
  | 'other';

/**
 * Statut de support Linux d'un composant, tel que stocké dans `linux_support`.
 *  - plug_and_play   : fonctionne à l'installation (vert)
 *  - tweaks_required : fonctionne après une action documentée — pilote propriétaire,
 *                      firmware, option BIOS, noyau plus récent (orange)
 *  - partial         : fonctionne avec des limitations non contournables (orange foncé)
 *  - unsupported     : ne fonctionne pas (rouge)
 *  - unknown         : aucune donnée (gris — abaisse la confiance, pas le score)
 */
export type LinuxSupportStatus =
  | 'plug_and_play'
  | 'tweaks_required'
  | 'partial'
  | 'unsupported'
  | 'unknown';

export type DriverType =
  | 'in_tree' // pilote dans le noyau, sans firmware externe
  | 'in_tree_firmware' // pilote dans le noyau + firmware (paquet linux-firmware ou constructeur)
  | 'dkms' // module hors arbre à compiler (signature requise avec Secure Boot)
  | 'proprietary' // pilote propriétaire (NVIDIA, broadcom-wl…)
  | 'none';

export type SecureBootImpact = 'none' | 'mok_enrollment' | 'must_disable';

export interface KnownIssue {
  summary: string;
  severity: 'minor' | 'major' | 'blocking';
  workaround?: string;
  /** Version de noyau à partir de laquelle le problème est corrigé. */
  fixedInKernel?: string;
  sourceUrl?: string;
}

export interface LinuxSupport {
  status: LinuxSupportStatus;
  /** Premier noyau où le composant est pris en charge (ex. "6.10"). */
  kernelMin?: string;
  /** Noyau à partir duquel le support est considéré mûr (sans régression connue). */
  kernelRecommended?: string;
  driver: { name: string; type: DriverType; firmwarePackage?: string };
  /** GPU : version minimale de Mesa (pilotes RADV / ANV / NVK). */
  mesaMin?: string;
  /** GPU NVIDIA : version minimale du pilote propriétaire (ex. "570"). */
  proprietaryDriverMin?: string;
  secureBootImpact: SecureBootImpact;
  knownIssues?: KnownIssue[];
  /** 0..1 — qualité de la donnée (nombre de sondes linux-hardware.org, vérification manuelle…). */
  confidence: number;
  sourceUrl?: string;
}

export type UpscalerKind = 'dlss' | 'fsr' | 'xess';
export type VideoEncoder = 'nvenc' | 'vcn' | 'qsv';
export type ComputeApi = 'cuda' | 'rocm' | 'oneapi';

export interface GpuSpecs {
  /** Indice de rastérisation normalisé : GeForce RTX 4090 (fixe) = 100. */
  perfIndex: number;
  /** Mémoire vidéo dédiée en Go ; 0 pour un iGPU (mémoire partagée). */
  vramGb: number;
  integrated: boolean;
  /** Portables : TGP auquel `perfIndex` a été mesuré (généralement le maximum). */
  tgpMaxW?: number;
  tgpMinW?: number;
  architecture?: string;
  features: {
    rayTracing?: boolean;
    /** Efficacité RT relative (NVIDIA même génération = 1). */
    rtEfficiency?: number;
    upscalers?: UpscalerKind[];
    encoders?: VideoEncoder[];
    compute?: ComputeApi[];
    /** Présent dans la liste de support officielle de ROCm (AMD). */
    rocmOfficial?: boolean;
  };
}

export interface CpuSpecs {
  /** Indice « jeu » (mono-cœur + cache) : meilleur CPU desktop = 100. */
  gamingIndex: number;
  /** Indice multi-cœur : meilleur CPU desktop grand public = 100. */
  multiIndex: number;
  cores: number;
  threads: number;
  tdpW?: number;
  npu?: boolean;
}

export interface Component {
  id: string;
  family: ComponentFamily;
  vendor: Vendor;
  /** Nom canonique (ex. "GeForce RTX 4060 Laptop"). */
  name: string;
  launchYear?: number;
  linux: LinuxSupport;
  gpu?: GpuSpecs;
  cpu?: CpuSpecs;
}

// -----------------------------------------------------------------------------
//  Configuration (un PC)
// -----------------------------------------------------------------------------

export interface PcComponent {
  role: ComponentRole;
  component: Component;
  /** GPU de portable : TGP configuré par le constructeur, s'il est connu. */
  tgpW?: number;
}

export type RamType = 'ddr3' | 'ddr4' | 'ddr5' | 'lpddr4x' | 'lpddr5' | 'lpddr5x' | 'unified';
export type StorageType = 'nvme' | 'sata_ssd' | 'hdd' | 'emmc';

export interface PcConfiguration {
  id: string;
  name: string;
  kind: 'laptop' | 'desktop' | 'mini_pc' | 'all_in_one';
  priceEur?: number;
  components: PcComponent[];
  ram: {
    totalGb: number;
    type: RamType;
    speedMt?: number;
    channels: 1 | 2 | 4 | 8;
    soldered: boolean;
    slotsFree?: number;
    maxGb?: number;
  };
  storage: { type: StorageType; capacityGb: number }[];
  firmware: {
    secureBootDefault: boolean;
    /** Intel RST / VMD en mode RAID par défaut : le disque NVMe est invisible pour l'installeur. */
    intelVmdRaidDefault?: boolean;
    tpm?: boolean;
  };
  /** Certifications constructeur : "ubuntu-certified", "linux-first-oem", "redhat-certified"… */
  linuxVendorCertified?: string[];
  batteryWh?: number;
}

// -----------------------------------------------------------------------------
//  Distributions
// -----------------------------------------------------------------------------

export type DistroFamily = 'debian' | 'ubuntu' | 'fedora' | 'arch' | 'suse' | 'other';
export type Audience = 'beginner' | 'gaming' | 'developer' | 'workstation' | 'enthusiast';

export interface DistroRelease {
  id: string;
  name: string;
  version: string;
  family: DistroFamily;
  /** Noyau livré par défaut (ex. "6.8"). Pour une rolling release : dernier noyau stable au moment du rafraîchissement. */
  kernelVersion: string;
  /** Noyau alternatif officiel (Ubuntu HWE, kernel-lt/zen…) si la distribution en propose un. */
  kernelHweVersion?: string;
  rolling: boolean;
  lts: boolean;
  mesaVersion: string;
  /** Version du pilote NVIDIA la plus récente disponible dans les dépôts officiels ou partenaires. */
  nvidiaDriverVersion?: string;
  /** bundled : image ISO avec pilote préinstallé ; easy : un clic / une commande ; manual : configuration à la main. */
  nvidiaInstall: 'bundled' | 'easy' | 'manual' | 'none';
  secureBoot: 'out_of_the_box' | 'mok' | 'unsupported';
  audience: Audience[];
  releaseDate?: string;
  eolDate?: string;
}

export interface UserProfile {
  usage: 'gaming' | 'developer' | 'office' | 'creator' | 'general';
  experience: 'beginner' | 'intermediate' | 'advanced';
  /** L'utilisateur veut garder Secure Boot actif (double démarrage Windows 11, politique d'entreprise…). */
  keepSecureBoot?: boolean;
  prefersStability?: boolean;
}

// -----------------------------------------------------------------------------
//  Jeux et benchmarks
// -----------------------------------------------------------------------------

export type Resolution = '1080p' | '1440p' | '2160p';
export type Preset = 'low' | 'medium' | 'high' | 'ultra';
export type GraphicsApi = 'dx9' | 'dx11' | 'dx12' | 'vulkan' | 'opengl';
export type ProtonTier = 'platinum' | 'gold' | 'silver' | 'bronze' | 'borked' | 'pending';
export type ProtonConfidence = 'low' | 'moderate' | 'good' | 'strong';
export type UpscalingMode = 'none' | 'quality' | 'balanced' | 'performance';
export type TargetOs = 'windows' | 'linux_native' | 'linux_proton';

export interface AntiCheatInfo {
  kind: 'none' | 'vac' | 'eac' | 'battleye' | 'vanguard' | 'ricochet' | 'gameguard' | 'other';
  /** supported : l'éditeur a activé le support Linux ; blocked : refusé ou noyau (Vanguard, Ricochet…). */
  linux: 'supported' | 'blocked' | 'unknown';
}

export interface Game {
  id: string;
  name: string;
  steamAppId?: number;
  /** API graphiques disponibles, la première étant celle utilisée par défaut. */
  apis: GraphicsApi[];
  /** Version Linux native, avec son ratio de performance mesuré par rapport à Windows. */
  linuxNative?: { api: GraphicsApi; perfRatio: number };
  antiCheat: AntiCheatInfo;
  /** Synthèse ProtonDB (importée périodiquement). */
  proton?: {
    tier: ProtonTier;
    confidence: ProtonConfidence;
    reports: number;
    steamDeck?: 'verified' | 'playable' | 'unsupported' | 'unknown';
  };
  requirements: {
    minRamGb: number;
    recRamGb: number;
    /** VRAM nécessaire par preset, à 1080p, en Go. */
    vramGb: Record<Preset, number>;
  };
  /** Plafond de FPS imposé par le CPU sur un CPU d'indice 100 (préréglage moyen, 1080p). */
  cpuBoundFpsRef: number;
  /** Limite de FPS imposée par le moteur (Elden Ring : 60). */
  fpsCap?: number;
  rayTracing?: { available: boolean; cost: number };
  upscalers: UpscalerKind[];
}

export interface GameBenchmark {
  gameId: string;
  os: TargetOs;
  gpuName: string;
  gpuVendor: Vendor;
  gpuPerfIndex: number;
  cpuGamingIndex?: number;
  resolution: Resolution;
  preset: Preset;
  rayTracing: boolean;
  upscaling: UpscalingMode;
  avgFps: number;
  low1pctFps?: number;
  /** Portables : TGP du GPU pendant la mesure. */
  tgpW?: number;
  source: string;
}
