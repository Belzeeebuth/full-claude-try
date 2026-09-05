import type { Preset, Resolution, UpscalingMode, UserProfile } from '@pc-analyzer/engine';
import { detectRetailer, matchDemoPc } from './demo-data.js';
import { renderApp, type State } from './views.js';

const state: State = {
  pcId: 'pc-legion-5',
  distroId: 'ubuntu-24.04',
  profile: { usage: 'gaming', experience: 'intermediate', keepSecureBoot: false, prefersStability: false },
  resolution: '1080p',
  preset: 'high',
  rayTracing: false,
  upscaling: 'none',
  compareIds: ['pc-legion-5', 'pc-zenbook-s16', 'pc-desktop-amd'],
  expanded: new Set(),
  notice: null,
  input: '',
};

const app = document.getElementById('app');
if (!app) throw new Error('#app introuvable');
const root: HTMLElement = app;

function render(): void {
  root.innerHTML = renderApp(state);
}

function analyze(query: string): void {
  if (!query) {
    state.notice = { kind: 'info', text: 'Collez un lien ou une référence, ou choisissez une configuration de démonstration ci-dessous.' };
    return;
  }
  const hit = detectRetailer(query);
  const pc = matchDemoPc(query);
  if (pc) {
    state.pcId = pc.id;
    state.notice = {
      kind: 'ok',
      text: `${hit ? `Lien ${hit.retailer} détecté (référence ${hit.externalId}). ` : ''}Configuration de démonstration reconnue : ${pc.name}.`,
    };
  } else if (hit) {
    state.notice = {
      kind: 'warn',
      text: `Lien ${hit.retailer} détecté (référence ${hit.externalId}), mais cette démo statique n'interroge pas les sites marchands : le worker de scraping n'est pas déployé sur GitHub Pages. Choisissez une configuration de démonstration ci-dessous.`,
    };
  } else {
    state.notice = {
      kind: 'warn',
      text: 'Aucun marchand ni configuration de démonstration reconnus. Essayez « Legion 5 », « Zenbook », « RX 7800 XT », « RTX 5070 », « MacBook M3 » ou « N100 ».',
    };
  }
}

function applyState(key: string, value: string | boolean): void {
  switch (key) {
    case 'distroId':
      state.distroId = String(value);
      break;
    case 'usage':
      state.profile = { ...state.profile, usage: value as UserProfile['usage'] };
      break;
    case 'experience':
      state.profile = { ...state.profile, experience: value as UserProfile['experience'] };
      break;
    case 'keepSecureBoot':
      state.profile = { ...state.profile, keepSecureBoot: Boolean(value) };
      break;
    case 'prefersStability':
      state.profile = { ...state.profile, prefersStability: Boolean(value) };
      break;
    case 'resolution':
      state.resolution = value as Resolution;
      break;
    case 'preset':
      state.preset = value as Preset;
      break;
    case 'rayTracing':
      state.rayTracing = Boolean(value);
      break;
    case 'upscaling':
      state.upscaling = value as UpscalingMode;
      break;
    default:
      break;
  }
}

root.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'analyze-form') return;
  event.preventDefault();
  const query = String(new FormData(form).get('q') ?? '').trim();
  state.input = query;
  analyze(query);
  render();
});

root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>('[data-pc],[data-compare],[data-toggle]');
  if (!button) return;
  if (button.dataset.pc) {
    state.pcId = button.dataset.pc;
    state.notice = null;
    state.expanded.clear();
  } else if (button.dataset.compare) {
    const id = button.dataset.compare;
    if (state.compareIds.includes(id)) state.compareIds = state.compareIds.filter((x) => x !== id);
    else if (state.compareIds.length < 4) state.compareIds = [...state.compareIds, id];
  } else if (button.dataset.toggle) {
    const id = button.dataset.toggle;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
  }
  render();
});

root.addEventListener('change', (event) => {
  const el = event.target;
  if (!(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement)) return;
  const key = el.dataset.state;
  if (!key) return;
  const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
  applyState(key, value);
  render();
});

render();
