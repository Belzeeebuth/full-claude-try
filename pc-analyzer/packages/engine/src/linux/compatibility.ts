// =============================================================================
//  Compatibilité Linux d'une configuration
//
//  Principe : chaque composant porte un statut de support « sur noyau récent »
//  (table linux_support). Pour une distribution donnée, ce statut est ensuite
//  DÉGRADÉ par des portes successives — noyau livré trop ancien, Mesa trop
//  ancien, pilote NVIDIA absent des dépôts, Secure Boot actif avec un module
//  non signé, option BIOS bloquante, problème connu non corrigé. Le statut
//  effectif donne un score, pondéré par l'importance du rôle (un Wi-Fi mort
//  sur un portable est bloquant, un lecteur d'empreintes ne l'est pas).
//
//  Le résultat est un rapport : badge global, score 0-100, confiance, et pour
//  chaque composant les RAISONS du statut et les ACTIONS pour l'améliorer.
// =============================================================================

import type {
  Badge,
  ComponentRole,
  DistroRelease,
  LinuxSupportStatus,
  PcComponent,
  PcConfiguration,
  SecureBootImpact,
  UserProfile,
} from '../types.js';
import { compareVersions, maxVersion } from '../version.js';

// -----------------------------------------------------------------------------
//  Barème
// -----------------------------------------------------------------------------

export interface RoleWeight {
  laptop: number;
  desktop: number;
  /** Un composant critique en `unsupported` rend la configuration rouge à lui seul. */
  critical: boolean;
}

/** Poids relatifs des rôles. Ils n'ont pas besoin de sommer à 100 : le score est une moyenne pondérée. */
export const ROLE_WEIGHTS: Record<ComponentRole, RoleWeight> = {
  gpu_discrete: { laptop: 22, desktop: 30, critical: true },
  gpu_integrated: { laptop: 18, desktop: 12, critical: true },
  cpu: { laptop: 12, desktop: 12, critical: true },
  wifi: { laptop: 18, desktop: 6, critical: true },
  storage: { laptop: 8, desktop: 8, critical: true },
  audio: { laptop: 7, desktop: 4, critical: false },
  bluetooth: { laptop: 4, desktop: 2, critical: false },
  webcam: { laptop: 5, desktop: 1, critical: false },
  touchpad: { laptop: 4, desktop: 0, critical: false },
  fingerprint: { laptop: 2, desktop: 0, critical: false },
  ethernet: { laptop: 1, desktop: 5, critical: false },
  display: { laptop: 2, desktop: 1, critical: false },
  other: { laptop: 1, desktop: 1, critical: false },
};

export const STATUS_SCORE: Record<LinuxSupportStatus, number> = {
  plug_and_play: 100,
  tweaks_required: 65,
  partial: 40,
  unsupported: 0,
  unknown: 50,
};

/** Ordre de gravité pour ne jamais « améliorer » un statut en appliquant une porte. */
const SEVERITY: Record<LinuxSupportStatus, number> = {
  plug_and_play: 0,
  unknown: 1,
  tweaks_required: 2,
  partial: 3,
  unsupported: 4,
};

export function worstStatus(a: LinuxSupportStatus, b: LinuxSupportStatus): LinuxSupportStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function badgeOf(status: LinuxSupportStatus): Badge {
  switch (status) {
    case 'plug_and_play':
      return 'green';
    case 'tweaks_required':
    case 'partial':
      return 'orange';
    case 'unsupported':
      return 'red';
    case 'unknown':
      return 'unknown';
  }
}

/** Seuil de score global en dessous duquel une configuration sans composant critique dégradé reste orange. */
export const GREEN_THRESHOLD = 85;

/** Poids en dessous duquel un composant (empreintes, extras d'écran…) n'influence pas le badge — seulement le score. */
export const MINOR_WEIGHT = 3;

/** Confiance globale en dessous de laquelle le badge est gris : trop de composants sans donnée. */
export const UNKNOWN_CONFIDENCE = 0.4;

// -----------------------------------------------------------------------------
//  Types du rapport
// -----------------------------------------------------------------------------

export interface ComponentVerdict {
  role: ComponentRole;
  componentId: string;
  componentName: string;
  /** Statut brut de la base (sur noyau récent). */
  baseStatus: LinuxSupportStatus;
  /** Statut effectif pour la distribution ciblée. */
  status: LinuxSupportStatus;
  badge: Badge;
  score: number;
  weight: number;
  critical: boolean;
  confidence: number;
  reasons: string[];
  actions: string[];
  requirements: {
    driver: string;
    kernelMin?: string;
    kernelRecommended?: string;
    mesaMin?: string;
    proprietaryDriverMin?: string;
  };
}

export interface LinuxCompatibilityReport {
  pcId: string;
  distro?: { id: string; name: string; kernelUsed: string; viaHwe: boolean };
  overall: { badge: Badge; score: number; confidence: number; summary: string };
  components: ComponentVerdict[];
  kernel: {
    minRequired?: string;
    recommended?: string;
    /** Le noyau par défaut de la distribution suffit-il ? (undefined sans distribution) */
    satisfied?: boolean;
    /** Sinon, le noyau HWE/alternatif suffit-il ? */
    satisfiedWithHwe?: boolean;
  };
  secureBoot: { impact: SecureBootImpact; enabledByDefault: boolean; guidance: string[] };
  firmwareActions: string[];
  notes: string[];
}

export interface EvaluateOptions {
  distro?: DistroRelease;
  profile?: UserProfile;
}

// -----------------------------------------------------------------------------
//  Évaluation
// -----------------------------------------------------------------------------

interface Context {
  isLaptop: boolean;
  hasDiscreteGpu: boolean;
  hasEthernet: boolean;
  /** Noyau retenu pour les portes (GA, ou HWE si le GA ne suffit pas). */
  kernelUsed?: string;
  viaHwe: boolean;
}

export function evaluateLinuxCompatibility(
  pc: PcConfiguration,
  options: EvaluateOptions = {},
): LinuxCompatibilityReport {
  const { distro, profile } = options;
  const supports = pc.components.map((c) => c.component.linux);
  const minRequired = maxVersion(...supports.map((s) => s.kernelMin));
  const recommended = maxVersion(...supports.map((s) => s.kernelRecommended));

  // Le noyau HWE n'est retenu que s'il est nécessaire : on ne demande pas à
  // l'utilisateur d'installer un noyau alternatif quand le noyau GA suffit.
  let kernelUsed: string | undefined;
  let viaHwe = false;
  let satisfied: boolean | undefined;
  let satisfiedWithHwe: boolean | undefined;
  if (distro) {
    satisfied = minRequired === undefined || compareVersions(distro.kernelVersion, minRequired) >= 0;
    kernelUsed = distro.kernelVersion;
    if (!satisfied && distro.kernelHweVersion && minRequired) {
      satisfiedWithHwe = compareVersions(distro.kernelHweVersion, minRequired) >= 0;
      if (satisfiedWithHwe) {
        kernelUsed = distro.kernelHweVersion;
        viaHwe = true;
      }
    }
  }

  const ctx: Context = {
    isLaptop: pc.kind === 'laptop',
    hasDiscreteGpu: pc.components.some((c) => c.role === 'gpu_discrete'),
    hasEthernet: pc.components.some((c) => c.role === 'ethernet'),
    kernelUsed,
    viaHwe,
  };

  const components = pc.components.map((pcc) => evaluateComponent(pcc, pc, distro, ctx));

  const totalWeight = components.reduce((sum, v) => sum + v.weight, 0);
  const weighted = (pick: (v: ComponentVerdict) => number): number =>
    totalWeight === 0 ? 0 : components.reduce((sum, v) => sum + pick(v) * v.weight, 0) / totalWeight;

  let score = Math.round(weighted((v) => v.score));
  let confidence = weighted((v) => v.confidence);
  const notes: string[] = [];

  if (pc.linuxVendorCertified && pc.linuxVendorCertified.length > 0) {
    // Une certification constructeur (Ubuntu certified, machine vendue sous Linux)
    // ne change pas les faits matériels mais lève l'incertitude : le constructeur
    // a validé l'ensemble.
    notes.push(`Configuration certifiée ou vendue sous Linux (${pc.linuxVendorCertified.join(', ')})`);
    confidence = Math.min(1, confidence + 0.15);
    score = Math.min(100, score + 3);
  }

  const criticalUnsupported = components.some((v) => v.critical && v.status === 'unsupported');
  const criticalDegraded = components.some(
    (v) => v.critical && (v.status === 'tweaks_required' || v.status === 'partial'),
  );
  // « Plug & Play » veut dire que tout fonctionne : un composant mort, même
  // secondaire (webcam, audio), interdit le vert. Les rôles mineurs (poids ≤ 3)
  // sont seulement signalés dans le résumé.
  const secondaryUnsupported = components.some(
    (v) => !v.critical && v.weight > MINOR_WEIGHT && v.status === 'unsupported',
  );

  const secureBoot = summarizeSecureBoot(pc, components, distro);
  const firmwareActions: string[] = [];
  if (pc.firmware.intelVmdRaidDefault) {
    firmwareActions.push(
      "Passer le contrôleur de stockage en mode AHCI (désactiver Intel VMD / RST) dans l'UEFI, sinon l'installeur ne voit pas le disque NVMe",
    );
  }
  if (distro?.secureBoot === 'unsupported' && pc.firmware.secureBootDefault) {
    firmwareActions.push(`Désactiver Secure Boot : ${distro.name} ne fournit pas de chargeur signé`);
  }
  if (profile?.keepSecureBoot && distro?.secureBoot === 'unsupported') {
    notes.push(`${distro.name} est incompatible avec l'exigence « Secure Boot actif » du profil`);
  }

  // Une action dans l'UEFI est un « tweak » au même titre qu'un pilote à
  // installer : elle interdit le vert, sans faire tomber le score.
  let badge: Badge;
  if (components.length === 0) badge = 'unknown';
  else if (criticalUnsupported) badge = 'red';
  else if (confidence < UNKNOWN_CONFIDENCE) badge = 'unknown';
  else if (score < GREEN_THRESHOLD || criticalDegraded || secondaryUnsupported || firmwareActions.length > 0) {
    badge = 'orange';
  } else badge = 'green';

  return {
    pcId: pc.id,
    distro: distro && kernelUsed ? { id: distro.id, name: distro.name, kernelUsed, viaHwe } : undefined,
    overall: {
      badge,
      score,
      confidence: round2(confidence),
      summary: summarize(badge, components, firmwareActions, distro, viaHwe),
    },
    components,
    kernel: { minRequired, recommended, satisfied, satisfiedWithHwe },
    secureBoot,
    firmwareActions,
    notes,
  };
}

function evaluateComponent(
  pcc: PcComponent,
  pc: PcConfiguration,
  distro: DistroRelease | undefined,
  ctx: Context,
): ComponentVerdict {
  const { component } = pcc;
  const support = component.linux;
  const reasons: string[] = [];
  const actions: string[] = [];
  let status: LinuxSupportStatus = support.status;
  let confidence = support.confidence;
  const { weight, critical } = roleWeight(pcc.role, pc, ctx);

  // 1. Nature du pilote : une donnée, pas une porte — mais elle explique le statut.
  switch (support.driver.type) {
    case 'proprietary':
      actions.push(`Installer le pilote propriétaire ${support.driver.name}`);
      break;
    case 'dkms':
      actions.push(`Installer le module hors arbre ${support.driver.name} (DKMS)`);
      break;
    case 'in_tree_firmware':
      if (support.driver.firmwarePackage) {
        reasons.push(`Firmware requis : ${support.driver.firmwarePackage} (fourni par la plupart des distributions)`);
      }
      break;
    case 'none':
      reasons.push('Aucun pilote Linux connu');
      break;
    case 'in_tree':
      break;
  }

  // 2. Portes liées à la distribution ciblée.
  if (distro && ctx.kernelUsed) {
    if (support.kernelMin) {
      if (compareVersions(distro.kernelVersion, support.kernelMin) < 0) {
        if (ctx.viaHwe && compareVersions(ctx.kernelUsed, support.kernelMin) >= 0) {
          status = worstStatus(status, 'tweaks_required');
          actions.push(
            `Installer le noyau ${ctx.kernelUsed} (HWE) : le noyau ${distro.kernelVersion} livré par défaut est antérieur au ${support.kernelMin} requis`,
          );
        } else {
          status = 'unsupported';
          reasons.push(`Noyau ${distro.kernelVersion} antérieur au ${support.kernelMin} requis par ${component.name}`);
          actions.push('Choisir une distribution livrée avec un noyau plus récent');
        }
      }
    }
    if (
      support.kernelRecommended &&
      status === 'plug_and_play' &&
      compareVersions(ctx.kernelUsed, support.kernelRecommended) < 0
    ) {
      status = 'tweaks_required';
      reasons.push(
        `Support encore jeune sur le noyau ${ctx.kernelUsed} : mûr à partir du ${support.kernelRecommended}`,
      );
    }
    if (support.mesaMin && compareVersions(distro.mesaVersion, support.mesaMin) < 0) {
      status = worstStatus(status, 'tweaks_required');
      actions.push(
        `Mesa ${distro.mesaVersion} antérieur au ${support.mesaMin} requis : utiliser un dépôt Mesa plus récent`,
      );
    }
    if (support.proprietaryDriverMin) {
      const available = distro.nvidiaDriverVersion;
      if (!available || compareVersions(available, support.proprietaryDriverMin) < 0) {
        status = worstStatus(status, 'tweaks_required');
        actions.push(
          `Pilote ${support.driver.name} ≥ ${support.proprietaryDriverMin} requis (dépôts : ${available ?? 'aucun'})`,
        );
      }
    }
    if (component.vendor === 'nvidia' && support.driver.type === 'proprietary') {
      if (distro.nvidiaInstall === 'manual') {
        actions.push(`${distro.name} : installation manuelle du pilote NVIDIA`);
      } else if (distro.nvidiaInstall === 'none') {
        status = worstStatus(status, 'partial');
        reasons.push(`${distro.name} ne distribue pas le pilote NVIDIA`);
      }
    }
  }

  // 3. Secure Boot : un module non signé par la distribution ne se charge pas.
  if (pc.firmware.secureBootDefault && support.secureBootImpact !== 'none') {
    status = worstStatus(status, 'tweaks_required');
    if (support.secureBootImpact === 'must_disable') {
      actions.push(`Désactiver Secure Boot (${support.driver.name} ne peut pas être signé)`);
    } else if (distro?.secureBoot === 'out_of_the_box' || distro?.secureBoot === 'mok') {
      actions.push(`Enrôler la clé MOK proposée à l'installation du module ${support.driver.name} (Secure Boot actif)`);
    } else {
      actions.push(`Enrôler une clé MOK pour ${support.driver.name}, ou désactiver Secure Boot`);
    }
  }

  // 4. Problèmes connus non corrigés sur le noyau retenu.
  for (const issue of support.knownIssues ?? []) {
    if (issue.fixedInKernel && ctx.kernelUsed && compareVersions(ctx.kernelUsed, issue.fixedInKernel) >= 0) {
      continue;
    }
    if (issue.severity === 'blocking') status = worstStatus(status, 'partial');
    else if (issue.severity === 'major') status = worstStatus(status, 'tweaks_required');
    reasons.push(issue.summary + (issue.fixedInKernel ? ` (corrigé à partir du noyau ${issue.fixedInKernel})` : ''));
    if (issue.workaround) actions.push(issue.workaround);
  }

  // 5. Options firmware du PC qui touchent ce rôle.
  if (pcc.role === 'storage' && pc.firmware.intelVmdRaidDefault) {
    status = worstStatus(status, 'tweaks_required');
    actions.push("Désactiver Intel VMD / RST (mode AHCI) dans l'UEFI avant l'installation");
  }

  if (status === 'unknown') confidence = Math.min(confidence, 0.3);

  return {
    role: pcc.role,
    componentId: component.id,
    componentName: component.name,
    baseStatus: support.status,
    status,
    badge: badgeOf(status),
    score: STATUS_SCORE[status],
    weight,
    critical,
    confidence: round2(confidence),
    reasons,
    actions: dedupe(actions),
    requirements: {
      driver: support.driver.name,
      kernelMin: support.kernelMin,
      kernelRecommended: support.kernelRecommended,
      mesaMin: support.mesaMin,
      proprietaryDriverMin: support.proprietaryDriverMin,
    },
  };
}

function roleWeight(
  role: ComponentRole,
  pc: PcConfiguration,
  ctx: Context,
): { weight: number; critical: boolean } {
  const base = ROLE_WEIGHTS[role];
  let weight = ctx.isLaptop ? base.laptop : base.desktop;
  let critical = base.critical;
  // Graphismes hybrides : l'iGPU pilote toujours l'écran interne, mais le dGPU
  // porte la performance — l'iGPU (Intel/AMD, quasi toujours vert) pèse moins.
  if (role === 'gpu_integrated' && ctx.hasDiscreteGpu) weight = 8;
  // Sur un fixe avec Ethernet, le Wi-Fi n'est plus bloquant.
  if (role === 'wifi') critical = ctx.isLaptop || !ctx.hasEthernet;
  if (role === 'ethernet' && pc.kind !== 'laptop') weight = 6;
  return { weight, critical };
}

function summarizeSecureBoot(
  pc: PcConfiguration,
  components: ComponentVerdict[],
  distro: DistroRelease | undefined,
): LinuxCompatibilityReport['secureBoot'] {
  const impacts = pc.components.map((c) => c.component.linux.secureBootImpact);
  const impact: SecureBootImpact = impacts.includes('must_disable')
    ? 'must_disable'
    : impacts.includes('mok_enrollment')
      ? 'mok_enrollment'
      : 'none';
  const guidance: string[] = [];
  if (!pc.firmware.secureBootDefault) {
    guidance.push('Secure Boot désactivé par défaut sur cette machine : aucune contrainte de signature');
  } else if (impact === 'none') {
    guidance.push('Tous les pilotes sont signés par la distribution : Secure Boot peut rester actif');
  } else if (impact === 'mok_enrollment') {
    const modules = components
      .filter((c) => c.requirements.driver && pc.components.some((p) => p.component.id === c.componentId && p.component.linux.secureBootImpact === 'mok_enrollment'))
      .map((c) => c.requirements.driver);
    guidance.push(
      `Secure Boot peut rester actif en enrôlant une clé MOK pour : ${dedupe(modules).join(', ')}`,
    );
  } else {
    guidance.push('Un pilote requis ne peut pas être signé : Secure Boot doit être désactivé');
  }
  if (distro?.secureBoot === 'unsupported' && pc.firmware.secureBootDefault) {
    guidance.push(`${distro.name} ne démarre pas avec Secure Boot actif`);
  }
  return { impact, enabledByDefault: pc.firmware.secureBootDefault, guidance };
}

function summarize(
  badge: Badge,
  components: ComponentVerdict[],
  firmwareActions: string[],
  distro: DistroRelease | undefined,
  viaHwe: boolean,
): string {
  const target = distro ? ` sur ${distro.name}${viaHwe ? ' (noyau HWE)' : ''}` : '';
  const blockers = components.filter((c) => c.status === 'unsupported').map((c) => c.componentName);
  const tweaks = dedupe([...components.flatMap((c) => c.actions), ...firmwareActions]).slice(0, 3);
  const minorDead = components
    .filter((c) => c.weight <= MINOR_WEIGHT && c.status === 'unsupported')
    .map((c) => c.componentName);
  switch (badge) {
    case 'green':
      return minorDead.length
        ? `Plug & Play${target}, sauf : ${minorDead.join(', ')}`
        : `Plug & Play${target} : tout le matériel est pris en charge sans intervention`;
    case 'orange':
      return `Compatible avec ajustements${target}${tweaks.length ? ' : ' + tweaks.join(' ; ') : ''}`;
    case 'red':
      return `Incompatible${target} : ${blockers.join(', ')} sans prise en charge`;
    case 'unknown':
      return 'Données insuffisantes pour évaluer cette configuration';
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
