// Rendu de la démo : des chaînes HTML construites à partir de l'état, sans
// framework — le moteur fait tout le travail, l'interface ne fait que
// présenter ses rapports.
import {
  badgeOf,
  estimateFps,
  estimateProWorkloads,
  evaluateLinuxCompatibility,
  recommendDistros,
  type Bottleneck,
  type DistroRelease,
  type FpsEstimate,
  type Game,
  type OsFpsResult,
  type PcConfiguration,
  type Preset,
  type ProtonTier,
  type Resolution,
  type UpscalingMode,
  type UserProfile,
} from '@pc-analyzer/engine';
import { ALL_PCS, BENCHMARKS, DISTROS, GAMES } from '@pc-analyzer/engine/fixtures';
import { diagnose } from './demo-data.js';
import { BADGE_LABEL, PLAY_LABEL, ROLE_LABEL, STATUS_LABEL, badge, bar, esc, euro, fmtFps, list, option, pct, playClass } from './format.js';

export interface Notice {
  kind: 'ok' | 'warn' | 'info';
  text: string;
}

export interface State {
  pcId: string;
  distroId: string;
  profile: UserProfile;
  resolution: Resolution;
  preset: Preset;
  rayTracing: boolean;
  upscaling: UpscalingMode;
  compareIds: string[];
  expanded: Set<string>;
  notice: Notice | null;
  input: string;
}

const REPO_URL = 'https://github.com/Belzeeebuth/full-claude-try/tree/claude/pc-analysis-comparison-tool-q412a3/pc-analyzer';

const KIND_LABEL: Record<PcConfiguration['kind'], string> = {
  laptop: 'Portable',
  desktop: 'PC fixe',
  mini_pc: 'Mini PC',
  all_in_one: 'Tout-en-un',
};

const STORAGE_LABEL: Record<PcConfiguration['storage'][number]['type'], string> = {
  nvme: 'SSD NVMe',
  sata_ssd: 'SSD SATA',
  hdd: 'disque dur',
  emmc: 'eMMC',
};

const BOTTLENECK_LABEL: Record<Bottleneck, string> = {
  gpu: 'GPU',
  cpu: 'CPU',
  vram: 'VRAM',
  ram: 'RAM',
  balanced: 'Équilibré',
  fps_cap: 'Plafond moteur',
  unknown: '—',
};

const TIER_BADGE: Record<ProtonTier, 'green' | 'orange' | 'red' | 'unknown'> = {
  platinum: 'green',
  gold: 'green',
  silver: 'orange',
  bronze: 'orange',
  borked: 'red',
  pending: 'unknown',
};

const USAGE_LABEL: Record<UserProfile['usage'], string> = {
  gaming: 'Jeu',
  developer: 'Développement',
  creator: 'Création (vidéo, 3D)',
  office: 'Bureautique',
  general: 'Usage général',
};

const EXPERIENCE_LABEL: Record<UserProfile['experience'], string> = {
  beginner: 'Débutant Linux',
  intermediate: 'Intermédiaire',
  advanced: 'Avancé',
};

const COMPARE_GAMES = ['cyberpunk-2077', 'counter-strike-2', 'elden-ring'];

export function pcById(id: string): PcConfiguration {
  return ALL_PCS.find((p) => p.id === id) ?? ALL_PCS[0];
}

export function distroById(id: string): DistroRelease {
  return DISTROS.find((d) => d.id === id) ?? DISTROS[0];
}

function gameById(id: string): Game {
  const found = GAMES.find((g) => g.id === id);
  if (!found) throw new Error(`jeu inconnu : ${id}`);
  return found;
}

function primaryGpu(pc: PcConfiguration) {
  return (
    pc.components.find((c) => c.role === 'gpu_discrete')?.component ??
    pc.components.find((c) => c.role === 'gpu_integrated')?.component
  );
}

function fpsOptions(state: State) {
  return {
    resolution: state.resolution,
    preset: state.preset,
    rayTracing: state.rayTracing,
    upscaling: state.upscaling,
    benchmarks: BENCHMARKS,
  };
}

// -----------------------------------------------------------------------------

export function renderApp(state: State): string {
  const pc = pcById(state.pcId);
  return [
    renderHeader(),
    '<main>',
    renderHero(state),
    renderSheet(pc),
    renderLinux(pc, state),
    renderFps(pc, state),
    renderPro(pc),
    renderCompare(state),
    '</main>',
    renderFooter(),
  ].join('');
}

function renderHeader(): string {
  return `<header class="top"><div class="inner">
    <div class="brand">PC Analyzer<span class="tag">démo statique</span></div>
    <nav><a href="#fiche">Fiche</a><a href="#linux">Linux</a><a href="#fps">FPS</a><a href="#pro">Pro</a><a href="#comparer">Comparer</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">Code &amp; docs</a></nav>
  </div></header>`;
}

function renderHero(state: State): string {
  const notice = state.notice ? `<div class="notice ${state.notice.kind}">${esc(state.notice.text)}</div>` : '';
  const chips = ALL_PCS.map(
    (p) => `<button type="button" class="chip${p.id === state.pcId ? ' active' : ''}" data-pc="${p.id}">${esc(p.name)}</button>`,
  ).join('');
  return `<section class="card hero">
    <h1>Analysez et comparez un PC, sous Windows <em>et</em> sous Linux</h1>
    <p class="lead">Collez un lien Amazon, Fnac, Boulanger, Cdiscount ou une référence : fiche détaillée, diagnostic virtuel,
    compatibilité Linux composant par composant et distribution par distribution, FPS Windows / Linux natif / Proton.
    Cette démo statique fait tourner le moteur d'analyse dans votre navigateur sur six configurations de démonstration.</p>
    <form class="analyze" id="analyze-form">
      <input name="q" value="${esc(state.input)}" placeholder="https://www.amazon.fr/dp/B0… ou « Lenovo Legion 5 RTX 4060 »" autocomplete="off" aria-label="Lien ou référence du PC">
      <button type="submit">Analyser</button>
    </form>
    ${notice}
    <div class="chips" aria-label="Configurations de démonstration">${chips}</div>
  </section>`;
}

function renderSheet(pc: PcConfiguration): string {
  const diag = diagnose(pc);
  const cpu = pc.components.find((c) => c.role === 'cpu')?.component;
  const gpu = primaryGpu(pc);
  const rows = pc.components
    .map(
      (c) => `<tr>
        <td class="muted">${ROLE_LABEL[c.role]}</td>
        <td class="name">${esc(c.component.name)}${c.tgpW ? ` <span class="muted small">(${c.tgpW} W)</span>` : ''}</td>
        <td>${badge(badgeOf(c.component.linux.status), STATUS_LABEL[c.component.linux.status])}</td>
        <td class="mono muted">${esc(c.component.linux.driver.name)}</td>
      </tr>`,
    )
    .join('');
  const ram = `${pc.ram.totalGb} Go ${pc.ram.type.toUpperCase()}${pc.ram.speedMt ? ` ${pc.ram.speedMt} MT/s` : ''} · ${
    pc.ram.channels === 1 ? 'simple canal' : `${pc.ram.channels} canaux`
  } · ${pc.ram.soldered ? 'soudée' : 'sur barrettes'}`;
  const storage = pc.storage.map((s) => `${s.capacityGb} Go ${STORAGE_LABEL[s.type]}`).join(', ');
  return `<section class="card" id="fiche">
    <h2>Fiche technique <span class="sub">${esc(pc.name)} · ${KIND_LABEL[pc.kind]}</span></h2>
    <div class="grid">
      <div class="kpi"><div class="value">${euro(pc.priceEur)}</div><div class="label">Prix de démonstration</div></div>
      <div class="kpi"><div class="value">${gpu?.gpu?.perfIndex ?? '—'}</div><div class="label">Indice GPU (RTX 4090 = 100) · ${esc(gpu?.name ?? '')}</div></div>
      <div class="kpi"><div class="value">${cpu?.cpu?.gamingIndex ?? '—'}</div><div class="label">Indice CPU jeu · ${esc(cpu?.name ?? '')}</div></div>
      <div class="kpi"><div class="value">${diag.perfPrice === null ? '—' : diag.perfPrice.toFixed(1)}</div><div class="label">Points de performance pour 100 € (perf / prix)</div></div>
    </div>
    <div class="two-col">
      <div>
        <h3>Composants</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Rôle</th><th>Composant</th><th>Linux (noyau récent)</th><th>Pilote</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div>
        <h3>Mémoire, stockage, firmware</h3>
        <table>
          <tr><td class="muted">RAM</td><td>${esc(ram)}${pc.ram.slotsFree !== undefined ? `<div class="small muted">${pc.ram.slotsFree} emplacement(s) libre(s)${pc.ram.maxGb ? `, max ${pc.ram.maxGb} Go` : ''}</div>` : ''}</td></tr>
          <tr><td class="muted">Stockage</td><td>${esc(storage)}</td></tr>
          <tr><td class="muted">Secure Boot</td><td>${pc.firmware.secureBootDefault ? 'activé par défaut' : 'désactivé par défaut'}${pc.firmware.intelVmdRaidDefault ? ' · Intel VMD/RST actif' : ''}</td></tr>
          <tr><td class="muted">Batterie</td><td>${pc.batteryWh ? `${pc.batteryWh} Wh` : '—'}</td></tr>
          <tr><td class="muted">Certification Linux</td><td>${pc.linuxVendorCertified?.length ? esc(pc.linuxVendorCertified.join(', ')) : '—'}</td></tr>
        </table>
        <h3>Diagnostic virtuel</h3>
        ${list(diag.strengths, 'ok-list')}
        ${list(diag.weaknesses, 'warn-list')}
        <div class="grid" style="margin-top:12px">
          <div class="kpi"><div class="value">${diag.repairability}<small class="muted">/10</small></div><div class="label">Réparabilité (estimation démo)</div>${bar(diag.repairability, 10, diag.repairability >= 7 ? 'green' : diag.repairability >= 4 ? 'orange' : 'red')}</div>
          <div class="kpi"><div class="value">${diag.upgradability}<small class="muted">/10</small></div><div class="label">Évolutivité (estimation démo)</div>${bar(diag.upgradability, 10, diag.upgradability >= 7 ? 'green' : diag.upgradability >= 4 ? 'orange' : 'red')}</div>
        </div>
      </div>
    </div>
  </section>`;
}

function renderLinux(pc: PcConfiguration, state: State): string {
  const distro = distroById(state.distroId);
  const report = evaluateLinuxCompatibility(pc, { distro, profile: state.profile });
  const recs = recommendDistros(pc, DISTROS, state.profile, 7);
  const hasNvidia = pc.components.some((c) => c.role === 'gpu_discrete' && c.component.vendor === 'nvidia');

  const min = report.kernel.minRequired;
  let kernelKind: 'green' | 'orange' | 'red' = 'green';
  let kernelText: string;
  if (!min) kernelText = `Aucune exigence de noyau particulière · ${distro.name} livre le ${distro.kernelVersion}`;
  else if (report.kernel.satisfied) kernelText = `Noyau ${distro.kernelVersion} livré ≥ ${min} requis${report.kernel.recommended ? ` (mûr à partir du ${report.kernel.recommended})` : ''}`;
  else if (report.kernel.satisfiedWithHwe) {
    kernelKind = 'orange';
    kernelText = `Noyau ${distro.kernelVersion} livré < ${min} requis → installer le noyau HWE ${distro.kernelHweVersion}`;
  } else {
    kernelKind = 'red';
    kernelText = `Noyau ${distro.kernelVersion} livré < ${min} requis : distribution inadaptée à ce matériel`;
  }

  const rows = report.components
    .map(
      (v) => `<tr>
        <td class="muted">${ROLE_LABEL[v.role]}</td>
        <td class="name">${esc(v.componentName)}<div class="mono muted small">${esc(v.requirements.driver)}${v.requirements.kernelMin ? ` · noyau ≥ ${v.requirements.kernelMin}` : ''}${v.requirements.mesaMin ? ` · Mesa ≥ ${v.requirements.mesaMin}` : ''}${v.requirements.proprietaryDriverMin ? ` · pilote ≥ ${v.requirements.proprietaryDriverMin}` : ''}</div></td>
        <td>${badge(v.badge, STATUS_LABEL[v.status])}${v.status !== v.baseStatus ? `<div class="small muted">base : ${STATUS_LABEL[v.baseStatus]}</div>` : ''}<div class="small muted">poids ${v.weight}${v.critical ? ' · critique' : ''}</div></td>
        <td>${list(v.reasons, 'reasons') || '<span class="muted">—</span>'}</td>
        <td>${list(v.actions, 'actions') || '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join('');

  const recRows = recs
    .map(
      (r, i) => `<div class="distro-row">
        <div>
          <span class="rank">${i + 1}</span><b>${esc(r.distro.name)}</b> ${badge(r.badge, BADGE_LABEL[r.badge])}
          <div class="small muted">noyau ${r.distro.kernelVersion}${r.distro.kernelHweVersion ? ` (HWE ${r.distro.kernelHweVersion})` : ''} · Mesa ${r.distro.mesaVersion}${hasNvidia ? ` · pilote NVIDIA ${r.distro.nvidiaDriverVersion ?? 'absent'} (${r.distro.nvidiaInstall})` : ''} · Secure Boot : ${r.distro.secureBoot === 'out_of_the_box' ? 'natif' : r.distro.secureBoot === 'mok' ? 'via MOK' : 'non géré'}</div>
          ${list(r.reasons, 'ok-list')}${list(r.warnings, 'warn-list')}
        </div>
        <div><div class="fps">${r.score}<small>/100</small></div>${bar(r.score, 100, 'linux')}<div class="small muted">matériel ${r.hardwareScore} · profil ${r.fitScore}</div></div>
      </div>`,
    )
    .join('');

  return `<section class="card" id="linux">
    <h2>Compatibilité Linux <span class="sub">par composant et par distribution</span></h2>
    <div class="controls">
      <label>Distribution <select data-state="distroId">${DISTROS.map((d) => option(d.id, `${d.name} · noyau ${d.kernelVersion}`, d.id === state.distroId)).join('')}</select></label>
      <label>Usage <select data-state="usage">${(Object.keys(USAGE_LABEL) as UserProfile['usage'][]).map((u) => option(u, USAGE_LABEL[u], u === state.profile.usage)).join('')}</select></label>
      <label>Expérience <select data-state="experience">${(Object.keys(EXPERIENCE_LABEL) as UserProfile['experience'][]).map((e) => option(e, EXPERIENCE_LABEL[e], e === state.profile.experience)).join('')}</select></label>
      <label class="check"><input type="checkbox" data-state="keepSecureBoot"${state.profile.keepSecureBoot ? ' checked' : ''}> Garder Secure Boot actif</label>
      <label class="check"><input type="checkbox" data-state="prefersStability"${state.profile.prefersStability ? ' checked' : ''}> Priorité à la stabilité (LTS)</label>
    </div>
    <div class="score-big">
      ${badge(report.overall.badge, BADGE_LABEL[report.overall.badge], true)}
      <div class="score">${report.overall.score}<small> /100</small></div>
      <div class="muted small">confiance ${pct(report.overall.confidence)}${report.distro?.viaHwe ? ' · noyau HWE retenu' : ''}</div>
    </div>
    <p>${esc(report.overall.summary)}</p>
    <div class="grid">
      <div class="kpi">${badge(kernelKind, 'Noyau')}<div class="label" style="margin-top:8px">${esc(kernelText)}</div></div>
      <div class="kpi">${badge(report.secureBoot.impact === 'none' ? 'green' : 'orange', 'Secure Boot')}<div class="label" style="margin-top:8px">${report.secureBoot.guidance.map(esc).join('<br>')}</div></div>
      <div class="kpi">${badge(report.firmwareActions.length ? 'orange' : 'green', 'UEFI')}<div class="label" style="margin-top:8px">${report.firmwareActions.length ? report.firmwareActions.map(esc).join('<br>') : 'Aucune action dans le firmware'}</div></div>
    </div>
    ${report.notes.length ? `<p class="small muted">${report.notes.map(esc).join(' · ')}</p>` : ''}
    <h3>Composants</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Rôle</th><th>Composant</th><th>Statut</th><th>Raisons</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h3>Distributions recommandées pour ce matériel et ce profil</h3>
    ${recRows}
  </section>`;
}

function fpsCell(r: OsFpsResult, max: number, cls: string): string {
  if (r.avg === null) {
    return `<span class="${playClass('incompatible')}">Incompatible</span><div class="small muted">${esc(r.notes[0] ?? '')}</div>`;
  }
  const origin = r.basedOn === 'measured' ? 'mesuré' : r.basedOn === 'derived' ? 'dérivé' : 'modélisé';
  return `<div class="fps">${fmtFps(r.avg)} <small>(${fmtFps(r.low1pct)} en 1 % low)</small></div>
    <span class="${playClass(r.playability)}">${PLAY_LABEL[r.playability]} · ${origin} · confiance ${pct(r.confidence)}</span>
    ${bar(r.avg, max, cls)}`;
}

function protonCell(game: Game): string {
  const deck = game.proton?.steamDeck ? `Steam Deck : ${game.proton.steamDeck}` : '';
  if (game.antiCheat.linux === 'blocked') {
    return `${badge('red', `Anti-cheat ${game.antiCheat.kind.toUpperCase()} bloqué`)}<div class="small muted">${esc(deck)}</div>`;
  }
  if (!game.proton) return `${badge('linux', 'Version Linux native')}<div class="small muted">Proton inutile</div>`;
  const tier = game.proton.tier;
  return `${badge(TIER_BADGE[tier], `ProtonDB ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`)}<div class="small muted">${game.proton.reports} rapports · ${esc(deck)}</div>`;
}

function detailsRow(e: FpsEstimate): string {
  const block = (title: string, items: string[]): string => (items.length ? `<div><b>${esc(title)}</b>${list(items, 'reasons')}</div>` : '');
  return `<tr class="details-row"><td colspan="7"><div class="grid">
    ${block('Windows', e.windows.notes)}
    ${e.linuxNative ? block('Linux natif', e.linuxNative.notes) : ''}
    ${block('Linux via Proton', e.linuxProton.notes)}
    ${block('Linux — pilotes', e.linux.notes)}
    ${block('Avertissements', e.warnings)}
    <div><b>GPU retenu</b><ul class="plain reasons"><li>${esc(e.gpu?.name ?? '—')} · indice effectif ${e.gpu?.effectiveIndex ?? '—'}${e.gpu?.tgpW ? ` · TGP ${Math.round(e.gpu.tgpW)} W${e.gpu.tgpAssumed ? ' (supposé)' : ''}` : ''} · VRAM ${e.gpu?.vramGb ?? '—'} Go</li><li>Chemin Linux recommandé : ${e.linux.recommendedPath === 'native' ? 'version native' : e.linux.recommendedPath === 'proton' ? 'Proton' : 'aucun'}</li></ul></div>
  </div></td></tr>`;
}

function renderFps(pc: PcConfiguration, state: State): string {
  const isApple = primaryGpu(pc)?.vendor === 'apple';
  const estimates = GAMES.map((g) => estimateFps(pc, g, fpsOptions(state)));
  const max = Math.max(1, ...estimates.flatMap((e) => [isApple ? 0 : (e.windows.avg ?? 0), e.linuxNative?.avg ?? 0, e.linuxProton.avg ?? 0]));
  const rows = estimates
    .map((e) => {
      const g = gameById(e.gameId);
      const open = state.expanded.has(e.gameId);
      return `<tr>
        <td class="name">${esc(e.gameName)}<div class="small muted">${g.apis.map((a) => a.toUpperCase()).join(' / ')}${g.linuxNative ? ` · natif Linux (${g.linuxNative.api.toUpperCase()})` : ''}${g.fpsCap ? ` · plafond ${g.fpsCap} FPS` : ''}</div></td>
        <td>${isApple ? '<span class="muted small">Windows indisponible sur Apple Silicon</span>' : fpsCell(e.windows, max, '')}</td>
        <td>${e.linuxNative ? fpsCell(e.linuxNative, max, 'linux') : '<span class="muted small">pas de portage</span>'}</td>
        <td>${fpsCell(e.linuxProton, max, 'linux')}</td>
        <td>${protonCell(g)}</td>
        <td>${BOTTLENECK_LABEL[e.bottleneck]}</td>
        <td><button type="button" class="ghost small" data-toggle="${e.gameId}">${open ? 'Masquer' : 'Détails'}</button></td>
      </tr>${open ? detailsRow(e) : ''}`;
    })
    .join('');
  const resolutions: Resolution[] = ['1080p', '1440p', '2160p'];
  const presets: Preset[] = ['low', 'medium', 'high', 'ultra'];
  const presetLabel: Record<Preset, string> = { low: 'Bas', medium: 'Moyen', high: 'Élevé', ultra: 'Ultra' };
  const upscalings: UpscalingMode[] = ['none', 'quality', 'balanced', 'performance'];
  const upLabel: Record<UpscalingMode, string> = { none: 'Aucun', quality: 'Qualité', balanced: 'Équilibré', performance: 'Performance' };
  return `<section class="card" id="fps">
    <h2>Estimation des FPS <span class="sub">Windows · Linux natif · Linux via Proton — ${esc(pc.name)}</span></h2>
    <div class="controls">
      <label>Résolution <select data-state="resolution">${resolutions.map((r) => option(r, r === '2160p' ? '4K (2160p)' : r, r === state.resolution)).join('')}</select></label>
      <label>Preset <select data-state="preset">${presets.map((p) => option(p, presetLabel[p], p === state.preset)).join('')}</select></label>
      <label>Upscaling (DLSS / FSR / XeSS) <select data-state="upscaling">${upscalings.map((u) => option(u, upLabel[u], u === state.upscaling)).join('')}</select></label>
      <label class="check"><input type="checkbox" data-state="rayTracing"${state.rayTracing ? ' checked' : ''}> Ray tracing</label>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Jeu</th><th>Windows</th><th>Linux natif</th><th>Linux · Proton</th><th>ProtonDB</th><th>Goulot</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="small muted">Barres à l'échelle du meilleur résultat du tableau. « Mesuré » : banc de référence sur ce GPU, cette résolution et ce preset ; « dérivé » : banc voisin ramené à la cible ; « modélisé » : facteurs (couche de traduction, palier ProtonDB, pilote). Données de démonstration.</p>
  </section>`;
}

function renderPro(pc: PcConfiguration): string {
  const cards = estimateProWorkloads(pc)
    .map(
      (w) => `<div class="kpi pro-card">
        <b>${esc(w.label)}</b>
        <div class="small muted" style="margin-top:8px">Windows <b style="color:var(--text)">${w.windowsScore}</b>/100</div>${bar(w.windowsScore, 100, '')}
        <div class="small muted" style="margin-top:8px">Linux <b style="color:var(--text)">${w.linuxScore}</b>/100</div>${bar(w.linuxScore, 100, 'linux')}
        <div class="small muted" style="margin-top:8px">Facteur limitant : ${esc(w.limitingFactor)}</div>
        <div class="tools"><b>Linux :</b> ${w.linuxTools.map(esc).join(' · ')}</div>
        <div class="tools">Windows : ${w.windowsTools.map(esc).join(' · ')}</div>
        ${list(w.notes, 'reasons')}
      </div>`,
    )
    .join('');
  return `<section class="card" id="pro">
    <h2>Charges de travail professionnelles <span class="sub">score par OS et outils optimisés sous Linux</span></h2>
    <div class="grid">${cards}</div>
  </section>`;
}

interface CompareRow {
  label: string;
  cells: string[];
  values?: (number | null)[];
  lowerIsBetter?: boolean;
}

function renderCompare(state: State): string {
  const selected = state.compareIds.map(pcById);
  const full = state.compareIds.length >= 4;
  const chips = ALL_PCS.map((p) => {
    const on = state.compareIds.includes(p.id);
    return `<button type="button" class="chip${on ? ' on' : ''}" data-compare="${p.id}"${!on && full ? ' disabled' : ''}>${esc(p.name)}</button>`;
  }).join('');
  const head = `<section class="card" id="comparer">
    <h2>Comparer jusqu'à 4 PC <span class="sub">matériel et comportement par OS · ${state.compareIds.length}/4 sélectionnés</span></h2>
    <div class="chips" style="margin:0 0 16px">${chips}</div>`;
  if (selected.length < 2) return `${head}<p class="muted">Sélectionnez au moins deux configurations.</p></section>`;

  const distro = distroById(state.distroId);
  const cols = selected.map((pc) => {
    const linux = evaluateLinuxCompatibility(pc, { distro, profile: state.profile });
    const top = recommendDistros(pc, DISTROS, state.profile, 1)[0];
    const fps = COMPARE_GAMES.map((id) => estimateFps(pc, gameById(id), fpsOptions(state)));
    return { pc, diag: diagnose(pc), linux, top, fps, cpu: pc.components.find((c) => c.role === 'cpu')?.component, gpu: primaryGpu(pc) };
  });

  const rows: CompareRow[] = [
    { label: 'Prix', cells: cols.map((c) => euro(c.pc.priceEur)), values: cols.map((c) => c.pc.priceEur ?? null), lowerIsBetter: true },
    { label: 'Type', cells: cols.map((c) => KIND_LABEL[c.pc.kind]) },
    { label: 'Processeur', cells: cols.map((c) => `${esc(c.cpu?.name ?? '—')}<div class="small muted">indice jeu ${c.cpu?.cpu?.gamingIndex ?? '—'} · multi ${c.cpu?.cpu?.multiIndex ?? '—'}</div>`), values: cols.map((c) => c.cpu?.cpu?.gamingIndex ?? null) },
    { label: 'GPU', cells: cols.map((c) => `${esc(c.gpu?.name ?? '—')}<div class="small muted">indice ${c.gpu?.gpu?.perfIndex ?? '—'} · ${c.gpu?.gpu?.integrated ? 'intégré' : `${c.gpu?.gpu?.vramGb ?? '?'} Go VRAM`}</div>`), values: cols.map((c) => c.gpu?.gpu?.perfIndex ?? null) },
    { label: 'RAM', cells: cols.map((c) => `${c.pc.ram.totalGb} Go ${c.pc.ram.type.toUpperCase()}<div class="small muted">${c.pc.ram.channels === 1 ? 'simple canal' : `${c.pc.ram.channels} canaux`} · ${c.pc.ram.soldered ? 'soudée' : 'évolutive'}</div>`), values: cols.map((c) => c.pc.ram.totalGb) },
    { label: 'Stockage', cells: cols.map((c) => esc(c.pc.storage.map((s) => `${s.capacityGb} Go ${STORAGE_LABEL[s.type]}`).join(', '))) },
    { label: 'Secure Boot par défaut', cells: cols.map((c) => (c.pc.firmware.secureBootDefault ? 'Oui' : 'Non')) },
    { label: `Linux · ${distro.name}`, cells: cols.map((c) => `${badge(c.linux.overall.badge, BADGE_LABEL[c.linux.overall.badge])}<div class="small muted">score ${c.linux.overall.score} · confiance ${pct(c.linux.overall.confidence)}</div>`), values: cols.map((c) => c.linux.overall.score) },
    { label: 'Distribution recommandée', cells: cols.map((c) => (c.top ? `${esc(c.top.distro.name)}<div class="small muted">${c.top.score}/100</div>` : '—')), values: cols.map((c) => c.top?.score ?? null) },
    ...COMPARE_GAMES.flatMap((id, i) => {
      const name = gameById(id).name;
      return [
        {
          label: `${name} · Windows`,
          cells: cols.map((c) => (c.gpu?.vendor === 'apple' ? '<span class="muted">—</span>' : `<span class="fps">${fmtFps(c.fps[i]?.windows.avg)}</span> <span class="small muted">FPS</span>`)),
          values: cols.map((c) => (c.gpu?.vendor === 'apple' ? null : (c.fps[i]?.windows.avg ?? null))),
        },
        {
          label: `${name} · Linux (meilleur chemin)`,
          cells: cols.map((c) => {
            const e = c.fps[i];
            const best = e?.linux.recommendedPath === 'native' ? e.linuxNative : e?.linuxProton;
            if (!e || !best || best.avg === null) return `<span class="${playClass('incompatible')}">Incompatible</span>`;
            return `<span class="fps">${fmtFps(best.avg)}</span> <span class="small muted">FPS · ${e.linux.recommendedPath === 'native' ? 'natif' : 'Proton'}</span>`;
          }),
          values: cols.map((c) => {
            const e = c.fps[i];
            const best = e?.linux.recommendedPath === 'native' ? e.linuxNative : e?.linuxProton;
            return best?.avg ?? null;
          }),
        },
      ];
    }),
    { label: 'Perf / prix (pts pour 100 €)', cells: cols.map((c) => (c.diag.perfPrice === null ? '—' : c.diag.perfPrice.toFixed(1))), values: cols.map((c) => c.diag.perfPrice) },
    { label: 'Réparabilité · évolutivité', cells: cols.map((c) => `${c.diag.repairability}/10 · ${c.diag.upgradability}/10`), values: cols.map((c) => c.diag.repairability + c.diag.upgradability) },
  ];

  const body = rows
    .map((row) => {
      let bestIndexes = new Set<number>();
      if (row.values) {
        const nums = row.values.filter((v): v is number => v !== null);
        if (nums.length > 1) {
          const best = row.lowerIsBetter ? Math.min(...nums) : Math.max(...nums);
          bestIndexes = new Set(row.values.map((v, i) => (v !== null && Math.abs(v - best) < 1e-9 ? i : -1)).filter((i) => i >= 0));
          if (bestIndexes.size === row.values.length) bestIndexes = new Set();
        }
      }
      return `<tr><th>${esc(row.label)}</th>${row.cells.map((cell, i) => `<td${bestIndexes.has(i) ? ' class="best"' : ''}>${cell}</td>`).join('')}</tr>`;
    })
    .join('');

  return `${head}
    <div class="table-wrap"><table>
      <thead><tr><th></th>${cols.map((c) => `<th>${esc(c.pc.name)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="small muted">En vert : le meilleur de la ligne. FPS à ${state.resolution} / ${state.preset}${state.rayTracing ? ' avec ray tracing' : ''}${state.upscaling !== 'none' ? ` · upscaling ${state.upscaling}` : ''} ; la distribution et le profil sont ceux de la section Linux.</p>
  </section>`;
}

function renderFooter(): string {
  return `<footer>Démo statique : données de démonstration (indices approximatifs, versions de noyau indicatives). Le moteur <span class="mono">@pc-analyzer/engine</span> calcule tout dans le navigateur ; le vrai produit ajoute le scraping des fiches marchandes, le matching des composants et des données importées (ProtonDB, linux-hardware.org, bancs). <a href="${REPO_URL}" target="_blank" rel="noopener">Architecture, schéma et algorithmes sur GitHub</a>.</footer>`;
}
