import type { Badge, ComponentRole, LinuxSupportStatus, Playability } from '@pc-analyzer/engine';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export const BADGE_LABEL: Record<Badge, string> = {
  green: 'Plug & Play',
  orange: 'Tweaks requis',
  red: 'Incompatible',
  unknown: 'Données insuffisantes',
};

export function badge(kind: Badge | 'accent' | 'linux', label: string, large = false): string {
  return `<span class="badge badge-${kind}${large ? ' badge-lg' : ''}">${esc(label)}</span>`;
}

export const STATUS_LABEL: Record<LinuxSupportStatus, string> = {
  plug_and_play: 'Plug & Play',
  tweaks_required: 'Tweaks requis',
  partial: 'Partiel',
  unsupported: 'Non supporté',
  unknown: 'Inconnu',
};

export const ROLE_LABEL: Record<ComponentRole, string> = {
  cpu: 'Processeur',
  gpu_discrete: 'GPU dédié',
  gpu_integrated: 'GPU intégré',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  audio: 'Audio',
  webcam: 'Webcam',
  fingerprint: 'Empreintes',
  storage: 'Stockage',
  ethernet: 'Ethernet',
  touchpad: 'Pavé tactile',
  display: 'Écran',
  other: 'Autre',
};

export const PLAY_LABEL: Record<Playability, string> = {
  excellent: 'Excellent',
  smooth: 'Fluide',
  playable: 'Jouable',
  limited: 'Limité',
  unplayable: 'Injouable',
  incompatible: 'Incompatible',
};

export function playClass(p: Playability): string {
  return `play play-${p}`;
}

export function fmtFps(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : String(Math.round(v));
}

export function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function bar(value: number, max: number, cls = ''): string {
  const width = max > 0 ? Math.max(1.5, Math.min(100, (value / max) * 100)) : 0;
  return `<div class="bar ${cls}"><i style="width:${width.toFixed(1)}%"></i></div>`;
}

export function list(items: string[], cls = 'reasons'): string {
  return items.length ? `<ul class="plain ${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
}

export function euro(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toLocaleString('fr-FR')} €`;
}

export function option(value: string, label: string, selected: boolean): string {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}
