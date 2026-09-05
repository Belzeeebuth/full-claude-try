// =============================================================================
//  Recommandation de distributions
//
//  Deux dimensions, combinées :
//   - le score MATÉRIEL : le rapport de compatibilité recalculé avec le noyau,
//     le Mesa et le pilote NVIDIA que cette distribution livre réellement ;
//   - le score d'ADÉQUATION au profil : pilote NVIDIA préinstallé, Secure Boot,
//     public visé (débutant, jeu, développement), stabilité vs fraîcheur.
//
//  La liste des distributions vient de la table `distributions`, rafraîchie
//  par un job (versions de noyau/Mesa via l'API Repology, fins de vie via
//  endoflife.date) : le moteur ne contient aucune version en dur.
// =============================================================================

import type { Audience, Badge, DistroRelease, PcConfiguration, UserProfile } from '../types.js';
import { evaluateLinuxCompatibility, type LinuxCompatibilityReport } from './compatibility.js';

export interface DistroRecommendation {
  distro: DistroRelease;
  /** Score combiné 0-100. */
  score: number;
  hardwareScore: number;
  fitScore: number;
  badge: Badge;
  reasons: string[];
  warnings: string[];
  report: LinuxCompatibilityReport;
}

export const DEFAULT_PROFILE: UserProfile = {
  usage: 'general',
  experience: 'intermediate',
  keepSecureBoot: false,
  prefersStability: false,
};

const USAGE_AUDIENCE: Record<UserProfile['usage'], Audience> = {
  gaming: 'gaming',
  developer: 'developer',
  creator: 'workstation',
  office: 'beginner',
  general: 'beginner',
};

export const HARDWARE_WEIGHT = 0.65;

/** À score égal, une distribution sans ajustement passe devant. */
const BADGE_RANK: Record<Badge, number> = { green: 0, orange: 1, unknown: 2, red: 3 };

export function recommendDistros(
  pc: PcConfiguration,
  distros: DistroRelease[],
  profile: UserProfile = DEFAULT_PROFILE,
  limit = 5,
): DistroRecommendation[] {
  const hasNvidia = pc.components.some(
    (c) => c.role === 'gpu_discrete' && c.component.vendor === 'nvidia',
  );

  const ranked = distros.map((distro): DistroRecommendation => {
    const report = evaluateLinuxCompatibility(pc, { distro, profile });
    const reasons: string[] = [];
    const warnings: string[] = [];
    let fit = 50;

    if (hasNvidia) {
      switch (distro.nvidiaInstall) {
        case 'bundled':
          fit += 15;
          reasons.push('Pilote NVIDIA préinstallé (image dédiée)');
          break;
        case 'easy':
          fit += 8;
          reasons.push('Installation du pilote NVIDIA en une étape');
          break;
        case 'manual':
          fit -= 5;
          warnings.push('Pilote NVIDIA à installer et à maintenir manuellement');
          break;
        case 'none':
          fit -= 25;
          warnings.push('Pilote NVIDIA non distribué');
          break;
      }
    }

    if (pc.firmware.secureBootDefault && profile.keepSecureBoot) {
      switch (distro.secureBoot) {
        case 'out_of_the_box':
          fit += 10;
          reasons.push('Démarre avec Secure Boot actif');
          break;
        case 'mok':
          fit += 4;
          reasons.push('Secure Boot pris en charge (enrôlement d\'une clé MOK)');
          break;
        case 'unsupported':
          fit -= 25;
          warnings.push('Secure Boot doit être désactivé');
          break;
      }
    }

    const wanted = USAGE_AUDIENCE[profile.usage];
    if (distro.audience.includes(wanted)) {
      fit += 10;
      reasons.push(`Orientée ${labelAudience(wanted)}`);
    }
    if (profile.experience === 'beginner') {
      if (distro.audience.includes('beginner')) fit += 8;
      if (distro.rolling) {
        fit -= 10;
        warnings.push('Rolling release : mises à jour continues, moins adaptée à un premier contact');
      }
    }
    if (profile.experience === 'advanced' && distro.audience.includes('enthusiast')) fit += 5;
    if (profile.prefersStability) {
      if (distro.lts) {
        fit += 8;
        reasons.push('Version à support long terme');
      }
      if (distro.rolling) fit -= 8;
    }

    // Matériel récent : une distribution qui l'accueille sans noyau alternatif est préférable.
    if (report.kernel.minRequired) {
      if (report.kernel.satisfied) {
        reasons.push(`Noyau ${distro.kernelVersion} ≥ ${report.kernel.minRequired} requis par le matériel`);
      } else if (report.kernel.satisfiedWithHwe) {
        fit -= 5;
        warnings.push(`Nécessite le noyau alternatif ${distro.kernelHweVersion} (HWE)`);
      } else {
        warnings.push(`Noyau ${distro.kernelVersion} trop ancien pour ce matériel (${report.kernel.minRequired} requis)`);
      }
    }

    fit = clamp(fit, 0, 100);
    const hardwareScore = report.overall.score;
    const score = Math.round(HARDWARE_WEIGHT * hardwareScore + (1 - HARDWARE_WEIGHT) * fit);
    return {
      distro,
      score,
      hardwareScore,
      fitScore: fit,
      badge: report.overall.badge,
      reasons,
      warnings,
      report,
    };
  });

  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        BADGE_RANK[a.badge] - BADGE_RANK[b.badge] ||
        b.hardwareScore - a.hardwareScore ||
        a.distro.name.localeCompare(b.distro.name),
    )
    .slice(0, limit);
}

function labelAudience(audience: Audience): string {
  switch (audience) {
    case 'beginner':
      return 'grand public';
    case 'gaming':
      return 'jeu';
    case 'developer':
      return 'développement';
    case 'workstation':
      return 'station de travail';
    case 'enthusiast':
      return 'utilisateurs avancés';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
