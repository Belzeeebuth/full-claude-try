import type { GameErrorCode } from '../utils/errors';

/**
 * Registre de métriques Prometheus maison.
 *
 * POURQUOI pas `prom-client` — trois types de métriques et un rendu texte ne
 * justifient ni une dépendance ni son registre global implicite. Écrit ici, le
 * format d'exposition est entièrement sous contrôle et testable sans réseau.
 *
 * CARDINALITÉ — Prometheus n'oublie jamais une série : chaque combinaison
 * d'étiquettes vue une fois coûte de la mémoire ici et dans le serveur de
 * scrape pour toujours. Toute étiquette provient donc d'un ensemble FERMÉ :
 * codes d'erreur (union `GameErrorCode` + codes du pipeline, vérifiée par le
 * compilateur via `KNOWN_ERROR_CODES`), noms de commandes du registre (≤ 70),
 * namespaces de composants enregistrés (≤ 30). Toute valeur hors ensemble est
 * repliée sur `other`, et un plafond de séries par métrique sert de filet si
 * un appelant contourne un jour cette règle.
 */

/** Valeur d'étiquette de repli pour tout ce qui sort des ensembles connus. */
export const OTHER_LABEL = 'other';

/**
 * Plafond de séries par métrique étiquetée. 70 commandes × 1 étiquette ou
 * 60 codes × 2 types restent loin en dessous ; atteindre ce seuil signale une
 * étiquette non bornée, et le repli sur `other` évite que la fuite grossisse.
 */
const DEFAULT_MAX_SERIES = 256;

// Nommage imposé par le format d'exposition : un nom hors motif est rejeté par
// Prometheus à l'ingestion — autant échouer au démarrage, à la définition.
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Échappement d'une valeur d'étiquette : antislash, guillemet et retour à la
 * ligne sont les trois seuls caractères qui casseraient la ligne de sample.
 * L'ordre compte — l'antislash d'abord, sinon on doublerait ceux qu'on ajoute.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Le texte de `# HELP` n'admet que deux échappements, pas le guillemet. */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Un nombre au format attendu par le parseur Go de Prometheus. */
export function formatSample(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/**
 * Replie `value` sur `fallback` quand elle n'appartient pas à l'ensemble
 * connu. C'est LA porte par laquelle toute étiquette dynamique doit passer.
 */
export function boundedLabel(
  value: string,
  known: ReadonlySet<string> | ((candidate: string) => boolean),
  fallback = OTHER_LABEL,
): string {
  const isKnown = typeof known === 'function' ? known(value) : known.has(value);
  return isKnown ? value : fallback;
}

export type LabelValues = Readonly<Record<string, string>>;

export interface Metric {
  readonly name: string;
  render(): string;
  reset(): void;
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name: "${name}"`);
}

function assertLabelNames(labelNames: readonly string[]): void {
  for (const label of labelNames) {
    if (!LABEL_NAME.test(label)) throw new Error(`invalid label name: "${label}"`);
    // `le` est réservé par les histogrammes : une collision rendrait les
    // seaux ambigus pour Prometheus.
    if (label === 'le') throw new Error('label "le" is reserved for histogram buckets');
  }
}

/**
 * Socle commun : une table de séries indexée par le tuple ordonné des valeurs
 * d'étiquettes. L'ordre est celui de la déclaration, jamais celui de l'objet
 * passé à l'appel — un même tuple donne toujours la même série.
 */
abstract class LabelledMetric<State> implements Metric {
  protected readonly series = new Map<string, { values: readonly string[]; state: State }>();
  private readonly maxSeries: number;

  protected constructor(
    public readonly name: string,
    protected readonly help: string,
    protected readonly labelNames: readonly string[],
    options: { maxSeries?: number } = {},
  ) {
    assertMetricName(name);
    assertLabelNames(labelNames);
    this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
  }

  protected abstract initialState(): State;
  protected abstract renderSeries(labels: string, state: State): string[];
  protected abstract readonly type: 'counter' | 'gauge' | 'histogram';

  private valuesFor(labels: LabelValues): string[] {
    return this.labelNames.map((label) => labels[label] ?? '');
  }

  /** Lecture sans effet de bord : `undefined` si la série n'existe pas. */
  protected peek(labels: LabelValues): State | undefined {
    return this.series.get(JSON.stringify(this.valuesFor(labels)))?.state;
  }

  /** Retourne l'état de la série, en la créant si besoin. */
  protected touch(labels: LabelValues): State {
    let values = this.valuesFor(labels);
    let key = JSON.stringify(values);
    const existing = this.series.get(key);
    if (existing) return existing.state;

    if (this.series.size >= this.maxSeries) {
      // Le plafond est atteint : la nouvelle combinaison est absorbée par une
      // série « other » unique plutôt que d'en créer une de plus.
      values = this.labelNames.map(() => OTHER_LABEL);
      key = JSON.stringify(values);
      const overflow = this.series.get(key);
      if (overflow) return overflow.state;
    }

    const state = this.initialState();
    this.series.set(key, { values, state });
    return state;
  }

  protected formatLabels(values: readonly string[], extra?: readonly [string, string]): string {
    const pairs = this.labelNames.map(
      (label, index) => `${label}="${escapeLabelValue(values[index] ?? '')}"`,
    );
    if (extra) pairs.push(`${extra[0]}="${extra[1]}"`);
    return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
  }

  render(): string {
    // Sans étiquette, la série unique doit être visible à zéro dès le premier
    // scrape, pas seulement après le premier incrément — sinon `rate()`
    // démarre sur un trou. Elle est créée ici et non dans le constructeur :
    // `initialState()` d'une sous-classe dépend de champs (les seaux d'un
    // histogramme) qui ne sont assignés qu'après `super()`.
    if (this.labelNames.length === 0 && this.series.size === 0) this.touch({});
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
    for (const { values, state } of this.series.values()) {
      lines.push(...this.renderSeries(this.formatLabels(values), state));
    }
    return lines.join('\n');
  }

  reset(): void {
    this.series.clear();
  }

  /** Nombre de séries vivantes — pour les tests de cardinalité. */
  get seriesCount(): number {
    return this.series.size;
  }
}

export class Counter extends LabelledMetric<{ value: number }> {
  protected readonly type = 'counter';

  constructor(name: string, help: string, labelNames: readonly string[] = [], options?: { maxSeries?: number }) {
    super(name, help, labelNames, options);
  }

  protected initialState(): { value: number } {
    return { value: 0 };
  }

  inc(labels: LabelValues = {}, by = 1): void {
    // Un compteur ne décroît jamais : un incrément négatif est un bug de
    // l'appelant, pas une valeur à propager silencieusement à Prometheus.
    if (!(by >= 0)) throw new Error(`counter ${this.name}: increment must be >= 0`);
    this.touch(labels).value += by;
  }

  value(labels: LabelValues = {}): number {
    return this.peek(labels)?.value ?? 0;
  }

  protected renderSeries(labels: string, state: { value: number }): string[] {
    return [`${this.name}${labels} ${formatSample(state.value)}`];
  }
}

export class Gauge extends LabelledMetric<{ value: number }> {
  protected readonly type = 'gauge';

  constructor(name: string, help: string, labelNames: readonly string[] = [], options?: { maxSeries?: number }) {
    super(name, help, labelNames, options);
  }

  protected initialState(): { value: number } {
    return { value: 0 };
  }

  set(value: number, labels: LabelValues = {}): void {
    this.touch(labels).value = value;
  }

  value(labels: LabelValues = {}): number {
    return this.peek(labels)?.value ?? 0;
  }

  protected renderSeries(labels: string, state: { value: number }): string[] {
    return [`${this.name}${labels} ${formatSample(state.value)}`];
  }
}

interface HistogramState {
  /** Comptes PAR seau (non cumulés) ; le cumul se fait au rendu. */
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends LabelledMetric<HistogramState> {
  protected readonly type = 'histogram';
  private readonly buckets: readonly number[];

  constructor(
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames: readonly string[] = [],
    options?: { maxSeries?: number },
  ) {
    super(name, help, labelNames, options);
    // Les bornes doivent être finies et strictement croissantes : `+Inf` est
    // ajouté au rendu, jamais déclaré, pour ne pas pouvoir être oublié.
    for (let index = 0; index < buckets.length; index += 1) {
      const bound = buckets[index];
      const previous = index > 0 ? buckets[index - 1] : Number.NEGATIVE_INFINITY;
      if (bound === undefined || !Number.isFinite(bound) || previous === undefined || bound <= previous) {
        throw new Error(`histogram ${name}: buckets must be finite and strictly increasing`);
      }
    }
    this.buckets = [...buckets];
  }

  protected initialState(): HistogramState {
    return { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
  }

  observe(value: number, labels: LabelValues = {}): void {
    if (!Number.isFinite(value)) return;
    const state = this.touch(labels);
    // Borne INCLUSIVE (`le` = less or equal), conformément au format : une
    // observation exactement à 0.5 s appartient au seau 0.5.
    const index = this.buckets.findIndex((bound) => value <= bound);
    if (index >= 0) state.counts[index] = (state.counts[index] ?? 0) + 1;
    state.sum += value;
    state.count += 1;
  }

  protected renderSeries(labels: string, state: HistogramState): string[] {
    const lines: string[] = [];
    let cumulative = 0;
    // Le format exige `{…,le="x"}` avec `le` en DERNIÈRE position ; on
    // réinjecte les étiquettes utilisateur avant, telles qu'elles ont été
    // formatées, en ouvrant l'accolade existante.
    const withLe = (bound: string): string =>
      labels === '' ? `{le="${bound}"}` : `${labels.slice(0, -1)},le="${bound}"}`;

    this.buckets.forEach((bound, index) => {
      cumulative += state.counts[index] ?? 0;
      lines.push(`${this.name}_bucket${withLe(formatSample(bound))} ${cumulative}`);
    });
    lines.push(`${this.name}_bucket${withLe('+Inf')} ${state.count}`);
    lines.push(`${this.name}_sum${labels} ${formatSample(state.sum)}`);
    lines.push(`${this.name}_count${labels} ${state.count}`);
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  register<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`metric already registered: ${metric.name}`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /** Texte au format d'exposition 0.0.4, terminé par un retour à la ligne. */
  render(): string {
    return [...this.metrics.values()].map((metric) => metric.render()).join('\n') + '\n';
  }

  /** Remet chaque métrique à zéro sans les désenregistrer (tests). */
  reset(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }
}

// ---------------------------------------------------------------------------
// Métriques applicatives
// ---------------------------------------------------------------------------

/** Codes produits par le pipeline d'interaction lui-même, hors `GameError`. */
export type PipelineErrorCode = 'internal' | 'not_owner' | 'busy' | 'maintenance';
export type ErrorMetricCode = GameErrorCode | PipelineErrorCode;

/**
 * Ensemble fermé des codes acceptés comme étiquette. Le type `Record<…, true>`
 * force la liste à suivre l'union : ajouter un code à `GameErrorCode` sans
 * l'inscrire ici ne compile pas, et inversement. Tout code hors liste à
 * l'exécution — cast hasardeux, erreur forgée — devient `other`.
 */
const KNOWN_ERROR_CODES: Readonly<Record<ErrorMetricCode, true>> = {
  not_registered: true,
  already_registered: true,
  insufficient_funds: true,
  insufficient_gems: true,
  insufficient_items: true,
  insufficient_energy: true,
  inventory_full: true,
  level_too_low: true,
  plot_locked: true,
  plot_occupied: true,
  plot_empty: true,
  plot_not_found: true,
  crop_not_ready: true,
  crop_withered: true,
  wrong_season: true,
  no_water_needed: true,
  no_pest: true,
  building_required: true,
  building_full: true,
  building_max_tier: true,
  animal_not_found: true,
  animal_dead: true,
  animal_not_hungry: true,
  animal_not_ready: true,
  breeding_unavailable: true,
  recipe_unknown: true,
  no_crafting_slot: true,
  craft_not_ready: true,
  item_unknown: true,
  item_not_sellable: true,
  item_not_tradable: true,
  quantity_invalid: true,
  cooldown: true,
  rate_limited: true,
  eco_banned: true,
  maintenance: true,
  coop_not_found: true,
  coop_full: true,
  coop_already_member: true,
  coop_not_member: true,
  coop_forbidden: true,
  coop_name_taken: true,
  trade_forbidden: true,
  trade_expired: true,
  auction_not_found: true,
  auction_own_listing: true,
  auction_bid_too_low: true,
  bank_capacity: true,
  target_invalid: true,
  privacy_blocked: true,
  not_found: true,
  forbidden: true,
  busy: true,
  invalid_state: true,
  internal: true,
  not_owner: true,
};

export function errorCodeLabel(code: string): string {
  return boundedLabel(code, (candidate) => Object.hasOwn(KNOWN_ERROR_CODES, candidate));
}

/**
 * Seaux de latence, en secondes. 2.5 et 5 encadrent le budget de 3 s que
 * Discord accorde avant la première réponse : c'est la lecture qui manquait
 * quand des commandes expiraient sans qu'aucune métrique ne le montre.
 */
export const DURATION_BUCKETS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export type ErrorKind = 'command' | 'component';

export const metricsRegistry = new MetricsRegistry();

export const errorsTotal = metricsRegistry.register(
  new Counter(
    'harvester_errors_total',
    'Erreurs répondues au joueur, par code et par type d’interaction (command|component)',
    ['code', 'kind'],
  ),
);

export const commandDuration = metricsRegistry.register(
  new Histogram(
    'harvester_command_duration_seconds',
    'Durée totale de traitement d’une commande, du reçu de l’interaction à la réponse',
    DURATION_BUCKETS,
    ['command'],
  ),
);

export const componentDuration = metricsRegistry.register(
  new Histogram(
    'harvester_component_duration_seconds',
    'Durée totale de traitement d’un composant (bouton, menu, modal), par namespace',
    DURATION_BUCKETS,
    ['namespace'],
  ),
);

export const renderWorkers = metricsRegistry.register(
  new Gauge('harvester_render_workers', 'Threads de rendu vivants dans le pool'),
);
export const renderBusy = metricsRegistry.register(
  new Gauge('harvester_render_busy', 'Threads de rendu occupés par une image'),
);
export const renderQueued = metricsRegistry.register(
  new Gauge('harvester_render_queued', 'Rendus en attente d’un thread libre'),
);

/** Compte une erreur répondue au joueur ; `code` est replié sur l'ensemble connu. */
export function recordError(kind: ErrorKind, code: string): void {
  errorsTotal.inc({ code: errorCodeLabel(code), kind });
}

/**
 * Durée d'une commande. L'appelant fournit une étiquette DÉJÀ bornée (via
 * `boundedLabel` contre le registre de commandes) : ce module ne connaît pas
 * le registre, et ne doit pas le connaître pour rester testable à vide.
 */
export function observeCommandDuration(commandLabel: string, seconds: number): void {
  commandDuration.observe(seconds, { command: commandLabel });
}

/** Idem pour un composant, étiqueté par namespace borné. */
export function observeComponentDuration(namespaceLabel: string, seconds: number): void {
  componentDuration.observe(seconds, { namespace: namespaceLabel });
}

export function setRenderPoolGauges(stats: { workers: number; busy: number; queued: number }): void {
  renderWorkers.set(stats.workers);
  renderBusy.set(stats.busy);
  renderQueued.set(stats.queued);
}
