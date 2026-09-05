import { describe, expect, it } from 'vitest';
import { evaluateLinuxCompatibility } from '../src/linux/compatibility.js';
import { compareVersions, maxVersion } from '../src/version.js';
import { component } from '../src/fixtures/components.js';
import { DISTROS } from '../src/fixtures/distros.js';
import { DESKTOP_AMD, DESKTOP_RTX_5070, LEGION_5, MACBOOK_AIR_M3, ZENBOOK_S16 } from '../src/fixtures/pcs.js';
import type { PcConfiguration } from '../src/types.js';

const distro = (id: string) => {
  const found = DISTROS.find((d) => d.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('comparaison de versions', () => {
  it('compare numériquement, pas lexicalement', () => {
    expect(compareVersions('6.10', '6.8')).toBeGreaterThan(0);
    expect(compareVersions('6.8', '6.8.0')).toBe(0);
    expect(compareVersions('570', '535')).toBeGreaterThan(0);
    expect(compareVersions('24.2', '24.10')).toBeLessThan(0);
    expect(maxVersion('6.2', undefined, '6.10', '6.5')).toBe('6.10');
  });
});

describe('badge global', () => {
  it('tout AMD + MediaTek sur un noyau récent : vert', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('fedora-43') });
    expect(report.overall.badge).toBe('green');
    expect(report.overall.score).toBeGreaterThanOrEqual(90);
    expect(report.distro?.viaHwe).toBe(false);
    expect(report.kernel.minRequired).toBe('6.10');
    expect(report.kernel.satisfied).toBe(true);
  });

  it('fixe tout AMD sans Secure Boot : vert, Wi-Fi non critique grâce à l\'Ethernet', () => {
    const report = evaluateLinuxCompatibility(DESKTOP_AMD, { distro: distro('fedora-43') });
    expect(report.overall.badge).toBe('green');
    const wifi = report.components.find((c) => c.role === 'wifi');
    expect(wifi?.critical).toBe(false);
  });

  it('Intel + NVIDIA + Realtek : orange, avec pilote propriétaire et clé MOK', () => {
    const report = evaluateLinuxCompatibility(LEGION_5, { distro: distro('ubuntu-24.04') });
    expect(report.overall.badge).toBe('orange');
    const nvidia = report.components.find((c) => c.role === 'gpu_discrete');
    expect(nvidia?.status).toBe('tweaks_required');
    expect(nvidia?.actions.join(' ')).toMatch(/propriétaire nvidia/i);
    expect(nvidia?.actions.join(' ')).toMatch(/MOK/);
    expect(report.secureBoot.impact).toBe('mok_enrollment');
    // RTL8852BE : dans l'arbre depuis 6.2, le noyau 6.8 suffit.
    const wifi = report.components.find((c) => c.role === 'wifi');
    expect(wifi?.status).toBe('plug_and_play');
    // CS35L41 : problème majeur connu → tweaks.
    const audio = report.components.find((c) => c.role === 'audio');
    expect(audio?.status).toBe('tweaks_required');
    expect(audio?.actions.length).toBeGreaterThan(0);
  });

  it('Apple M3 : rouge, avec le composant bloquant nommé', () => {
    const report = evaluateLinuxCompatibility(MACBOOK_AIR_M3, { distro: distro('fedora-43') });
    expect(report.overall.badge).toBe('red');
    expect(report.overall.summary).toMatch(/Incompatible/);
    expect(report.overall.summary).toMatch(/Apple M3/);
  });

  it('sans distribution : évaluation « noyau récent », sans porte de version', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16);
    expect(report.distro).toBeUndefined();
    expect(report.kernel.satisfied).toBeUndefined();
    expect(report.overall.badge).toBe('green');
  });
});

describe('portes liées à la distribution', () => {
  it('noyau GA trop ancien mais HWE suffisant : orange avec action « HWE »', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('ubuntu-24.04') });
    expect(report.kernel.satisfied).toBe(false);
    expect(report.kernel.satisfiedWithHwe).toBe(true);
    expect(report.distro?.viaHwe).toBe(true);
    expect(report.distro?.kernelUsed).toBe('6.14');
    expect(report.overall.badge).toBe('orange');
    const gpu = report.components.find((c) => c.role === 'gpu_integrated');
    expect(gpu?.status).toBe('tweaks_required');
    expect(gpu?.actions.join(' ')).toMatch(/HWE/);
  });

  it('noyau trop ancien sans alternative : composant critique non supporté → rouge', () => {
    const oldDistro = { ...distro('ubuntu-24.04'), id: 'old', name: 'Distribution 6.8 sans HWE', kernelHweVersion: undefined };
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: oldDistro });
    expect(report.overall.badge).toBe('red');
    const cpu = report.components.find((c) => c.role === 'cpu');
    expect(cpu?.status).toBe('unsupported');
    expect(cpu?.reasons.join(' ')).toMatch(/6\.8 antérieur au 6\.10/);
  });

  it('Debian 13 (noyau 6.12) accueille le Strix Point sans HWE', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('debian-13') });
    expect(report.kernel.satisfied).toBe(true);
    expect(report.overall.badge).toBe('green');
  });

  it('pilote NVIDIA des dépôts trop ancien pour une RTX 5070 : action explicite', () => {
    const onDebian = evaluateLinuxCompatibility(DESKTOP_RTX_5070, { distro: distro('debian-13') });
    const gpuDebian = onDebian.components.find((c) => c.role === 'gpu_discrete');
    expect(gpuDebian?.actions.join(' ')).toMatch(/≥ 570/);
    const onFedora = evaluateLinuxCompatibility(DESKTOP_RTX_5070, { distro: distro('fedora-43') });
    const gpuFedora = onFedora.components.find((c) => c.role === 'gpu_discrete');
    expect(gpuFedora?.actions.join(' ')).not.toMatch(/≥ 570/);
  });

  it('distribution sans Secure Boot sur une machine où il est actif : action UEFI, jamais vert', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('pop-24.04') });
    expect(report.firmwareActions.join(' ')).toMatch(/Secure Boot/);
    expect(report.overall.badge).toBe('orange');
  });

  it('un problème connu corrigé par le noyau retenu disparaît', () => {
    const report = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('fedora-43') });
    const cpu = report.components.find((c) => c.role === 'cpu');
    expect(cpu?.reasons.join(' ')).not.toMatch(/amdxdna/);
    const older = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('debian-13') });
    const cpuOlder = older.components.find((c) => c.role === 'cpu');
    expect(cpuOlder?.reasons.join(' ')).toMatch(/amdxdna/);
  });
});

describe('pondération et confiance', () => {
  const laptopWith = (wifiId: Parameters<typeof component>[0], kind: PcConfiguration['kind'] = 'laptop'): PcConfiguration => ({
    ...ZENBOOK_S16,
    id: 'variant',
    kind,
    components: [
      ...ZENBOOK_S16.components.filter((c) => c.role !== 'wifi'),
      { role: 'wifi', component: component(wifiId) },
      ...(kind === 'desktop' ? [{ role: 'ethernet' as const, component: component('eth-realtek-rtl8125') }] : []),
    ],
  });

  it('un Wi-Fi non supporté est bloquant sur un portable, pas sur un fixe avec Ethernet', () => {
    const unsupportedWifi = { ...component('wifi-broadcom-bcm4360'), linux: { ...component('wifi-broadcom-bcm4360').linux, status: 'unsupported' as const } };
    const laptop = { ...laptopWith('wifi-broadcom-bcm4360'), components: laptopWith('wifi-broadcom-bcm4360').components.map((c) => (c.role === 'wifi' ? { ...c, component: unsupportedWifi } : c)) };
    expect(evaluateLinuxCompatibility(laptop, { distro: distro('fedora-43') }).overall.badge).toBe('red');
    const desktop = { ...laptopWith('wifi-broadcom-bcm4360', 'desktop'), components: laptopWith('wifi-broadcom-bcm4360', 'desktop').components.map((c) => (c.role === 'wifi' ? { ...c, component: unsupportedWifi } : c)) };
    expect(evaluateLinuxCompatibility(desktop, { distro: distro('fedora-43') }).overall.badge).toBe('orange');
  });

  it('un composant inconnu abaisse la confiance, pas le badge des autres', () => {
    const report = evaluateLinuxCompatibility(laptopWith('wifi-unknown-usb'), { distro: distro('fedora-43') });
    const wifi = report.components.find((c) => c.role === 'wifi');
    expect(wifi?.badge).toBe('unknown');
    expect(wifi?.confidence).toBeLessThanOrEqual(0.3);
    const reference = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('fedora-43') });
    expect(report.overall.confidence).toBeLessThan(reference.overall.confidence);
  });

  it('une certification constructeur remonte la confiance', () => {
    const certified = { ...ZENBOOK_S16, linuxVendorCertified: ['ubuntu-certified'] };
    const a = evaluateLinuxCompatibility(ZENBOOK_S16, { distro: distro('fedora-43') });
    const b = evaluateLinuxCompatibility(certified, { distro: distro('fedora-43') });
    expect(b.overall.confidence).toBeGreaterThan(a.overall.confidence);
    expect(b.notes.join(' ')).toMatch(/certifiée/);
  });

  it('Intel VMD en RAID par défaut : action UEFI et stockage en orange', () => {
    const vmd = { ...LEGION_5, firmware: { ...LEGION_5.firmware, intelVmdRaidDefault: true } };
    const report = evaluateLinuxCompatibility(vmd, { distro: distro('ubuntu-24.04') });
    expect(report.firmwareActions.join(' ')).toMatch(/AHCI/);
    expect(report.components.find((c) => c.role === 'storage')?.status).toBe('tweaks_required');
  });
});
