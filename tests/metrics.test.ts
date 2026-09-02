import { beforeEach, describe, expect, it } from 'vitest';
import {
  Counter,
  DURATION_BUCKETS,
  Gauge,
  Histogram,
  MetricsRegistry,
  OTHER_LABEL,
  boundedLabel,
  errorCodeLabel,
  escapeLabelValue,
  formatSample,
  metricsRegistry,
  observeCommandDuration,
  observeComponentDuration,
  recordError,
  setRenderPoolGauges,
} from '../src/http/metrics';

/**
 * Le registre Prometheus est écrit à la main : le format d'exposition est donc
 * une promesse que rien d'autre ne vérifie. Un seau non cumulé, un `le` mal
 * placé ou un guillemet non échappé ne casse rien ici — c'est Prometheus qui
 * rejette le scrape en silence, et le tableau de bord reste vide. Ces tests
 * fixent le format ligne par ligne, et la borne de cardinalité qui empêche une
 * étiquette forgée de faire grossir la mémoire du process à l'infini.
 */

/** Une ligne de sample valide au sens du format 0.0.4 (hors commentaires). */
const SAMPLE_LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"(?:,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*")*\})? (?:-?[0-9.]+(?:e[+-]?[0-9]+)?|[+-]Inf|NaN)$/;

function samples(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe("format d'exposition", () => {
  it('un compteur sans étiquette est visible à zéro dès sa création', () => {
    const counter = new Counter('demo_total', 'Aide');
    expect(counter.render()).toBe('# HELP demo_total Aide\n# TYPE demo_total counter\ndemo_total 0');
    counter.inc();
    counter.inc({}, 2);
    expect(counter.render()).toContain('\ndemo_total 3');
  });

  it("ordonne les étiquettes selon la déclaration, pas selon l'objet passé", () => {
    const counter = new Counter('demo_total', 'Aide', ['code', 'kind']);
    counter.inc({ kind: 'command', code: 'busy' });
    counter.inc({ code: 'busy', kind: 'command' });
    expect(counter.render()).toContain('demo_total{code="busy",kind="command"} 2');
    expect(counter.seriesCount).toBe(1);
  });

  it('une étiquette absente devient une chaîne vide, une étiquette inconnue est ignorée', () => {
    const counter = new Counter('demo_total', 'Aide', ['code']);
    counter.inc({ unrelated: 'x' });
    expect(counter.render()).toContain('demo_total{code=""} 1');
  });

  it('une jauge accepte toute valeur, négative comprise', () => {
    const gauge = new Gauge('demo', 'Aide');
    gauge.set(-2.5);
    expect(gauge.render()).toContain('\ndemo -2.5');
    gauge.set(7);
    expect(gauge.value()).toBe(7);
  });

  it("échappe antislash et retour à la ligne dans le texte d'aide", () => {
    const gauge = new Gauge('demo', 'ligne 1\nligne 2 \\ fin');
    expect(gauge.render().split('\n')[0]).toBe('# HELP demo ligne 1\\nligne 2 \\\\ fin');
  });

  it('formate les valeurs spéciales comme le parseur Go les attend', () => {
    expect(formatSample(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatSample(Number.NEGATIVE_INFINITY)).toBe('-Inf');
    expect(formatSample(Number.NaN)).toBe('NaN');
    expect(formatSample(0.25)).toBe('0.25');
    expect(formatSample(3)).toBe('3');
  });

  it('le registre sépare les familles par un seul saut de ligne et termine par un retour', () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter('a_total', 'A'));
    registry.register(new Gauge('b', 'B'));
    const text = registry.render();
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\n\n');
    expect(text.split('\n').filter((line) => line.startsWith('# TYPE'))).toEqual([
      '# TYPE a_total counter',
      '# TYPE b gauge',
    ]);
  });

  it('refuse un doublon de nom, un nom invalide et une étiquette réservée', () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter('a_total', 'A'));
    expect(() => registry.register(new Counter('a_total', 'A bis'))).toThrow(/already registered/);
    expect(() => new Counter('1bad', 'A')).toThrow(/invalid metric name/);
    expect(() => new Counter('ok_total', 'A', ['bad-label'])).toThrow(/invalid label name/);
    expect(() => new Histogram('ok', 'A', [1], ['le'])).toThrow(/reserved/);
  });

  it("refuse de décrémenter un compteur : c'est un bug d'appelant", () => {
    const counter = new Counter('demo_total', 'Aide');
    expect(() => counter.inc({}, -1)).toThrow(/>= 0/);
  });
});

describe('histogramme', () => {
  it('cumule les seaux, borne incluse, et ajoute +Inf, _sum et _count', () => {
    const histogram = new Histogram('demo_seconds', 'Aide', [0.1, 0.5, 1]);
    histogram.observe(0.05);
    histogram.observe(0.5); // exactement sur la borne : appartient au seau 0.5
    histogram.observe(0.7);
    histogram.observe(3);

    const lines = samples(histogram.render());
    expect(lines).toEqual([
      'demo_seconds_bucket{le="0.1"} 1',
      'demo_seconds_bucket{le="0.5"} 2',
      'demo_seconds_bucket{le="1"} 3',
      'demo_seconds_bucket{le="+Inf"} 4',
      'demo_seconds_sum 4.25',
      'demo_seconds_count 4',
    ]);
    expect(histogram.render()).toContain('# TYPE demo_seconds histogram');
  });

  it('place `le` en dernière position derrière les étiquettes utilisateur', () => {
    const histogram = new Histogram('demo_seconds', 'Aide', [0.1, 1], ['command']);
    histogram.observe(0.2, { command: 'farm' });
    const lines = samples(histogram.render());
    expect(lines).toEqual([
      'demo_seconds_bucket{command="farm",le="0.1"} 0',
      'demo_seconds_bucket{command="farm",le="1"} 1',
      'demo_seconds_bucket{command="farm",le="+Inf"} 1',
      'demo_seconds_sum{command="farm"} 0.2',
      'demo_seconds_count{command="farm"} 1',
    ]);
    for (const line of lines) expect(line).toMatch(SAMPLE_LINE);
  });

  it('ignore une observation non finie plutôt que de corrompre la somme', () => {
    const histogram = new Histogram('demo_seconds', 'Aide', [1]);
    histogram.observe(Number.NaN);
    histogram.observe(Number.POSITIVE_INFINITY);
    expect(samples(histogram.render())).toContain('demo_seconds_count 0');
  });

  it('exige des bornes finies et strictement croissantes', () => {
    expect(() => new Histogram('demo', 'A', [1, 1])).toThrow(/strictly increasing/);
    expect(() => new Histogram('demo', 'A', [2, 1])).toThrow(/strictly increasing/);
    expect(() => new Histogram('demo', 'A', [1, Number.POSITIVE_INFINITY])).toThrow(/finite/);
  });
});

describe('étiquettes', () => {
  it('échappe guillemet, antislash et retour à la ligne', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('une valeur hostile ne casse pas la ligne de sample', () => {
    const counter = new Counter('demo_total', 'Aide', ['code']);
    counter.inc({ code: 'x"} 999\nevil_total 1' });
    const [line] = samples(counter.render());
    expect(line).toBe('demo_total{code="x\\"} 999\\nevil_total 1"} 1');
    expect(line).toMatch(SAMPLE_LINE);
    expect(samples(counter.render())).toHaveLength(1);
  });

  it('replie sur `other` toute valeur hors ensemble connu', () => {
    const known = new Set(['farm', 'shop']);
    expect(boundedLabel('farm', known)).toBe('farm');
    expect(boundedLabel('DROP TABLE', known)).toBe(OTHER_LABEL);
    expect(boundedLabel('shop', (value) => value.length === 4)).toBe('shop');
    expect(boundedLabel('market', (value) => value.length === 4, 'inconnu')).toBe('inconnu');
  });

  it('accepte les codes de GameError et du pipeline, rien d’autre', () => {
    for (const code of ['insufficient_funds', 'plot_locked', 'internal', 'not_owner', 'busy', 'maintenance']) {
      expect(errorCodeLabel(code)).toBe(code);
    }
    for (const code of ['', 'forged', 'INSUFFICIENT_FUNDS', 'toString', 'constructor', '__proto__']) {
      expect(errorCodeLabel(code)).toBe(OTHER_LABEL);
    }
  });

  it('absorbe les combinaisons au-delà du plafond dans une série `other` unique', () => {
    const counter = new Counter('demo_total', 'Aide', ['code', 'kind'], { maxSeries: 2 });
    counter.inc({ code: 'a', kind: 'k' });
    counter.inc({ code: 'b', kind: 'k' });
    counter.inc({ code: 'c', kind: 'k' });
    counter.inc({ code: 'd', kind: 'k' });
    counter.inc({ code: 'a', kind: 'k' });
    expect(counter.seriesCount).toBe(3);
    expect(counter.value({ code: 'a', kind: 'k' })).toBe(2);
    expect(counter.value({ code: OTHER_LABEL, kind: OTHER_LABEL })).toBe(2);
    expect(counter.render()).not.toContain('code="c"');
  });
});

describe('métriques applicatives', () => {
  beforeEach(() => {
    metricsRegistry.reset();
  });

  it('les seaux encadrent le budget de 3 s de Discord', () => {
    expect(DURATION_BUCKETS).toEqual([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
  });

  it('compte les erreurs par code et par type, code inconnu replié sur other', () => {
    recordError('command', 'insufficient_funds');
    recordError('command', 'insufficient_funds');
    recordError('component', 'forged_by_client');
    recordError('component', 'not_owner');

    const text = metricsRegistry.render();
    expect(text).toContain('# TYPE harvester_errors_total counter');
    expect(text).toContain('harvester_errors_total{code="insufficient_funds",kind="command"} 2');
    expect(text).toContain('harvester_errors_total{code="other",kind="component"} 1');
    expect(text).toContain('harvester_errors_total{code="not_owner",kind="component"} 1');
  });

  it('une commande à 2,7 s tombe au-delà du seau 2.5 — le dépassement du budget est visible', () => {
    observeCommandDuration('farm', 2.7);
    observeCommandDuration('farm', 0.3);
    const text = metricsRegistry.render();
    expect(text).toContain('# TYPE harvester_command_duration_seconds histogram');
    expect(text).toContain('harvester_command_duration_seconds_bucket{command="farm",le="0.5"} 1');
    expect(text).toContain('harvester_command_duration_seconds_bucket{command="farm",le="2.5"} 1');
    expect(text).toContain('harvester_command_duration_seconds_bucket{command="farm",le="5"} 2');
    expect(text).toContain('harvester_command_duration_seconds_bucket{command="farm",le="+Inf"} 2');
    expect(text).toContain('harvester_command_duration_seconds_sum{command="farm"} 3');
    expect(text).toContain('harvester_command_duration_seconds_count{command="farm"} 2');
  });

  it('étiquette les composants par namespace', () => {
    observeComponentDuration('trade', 0.08);
    observeComponentDuration(OTHER_LABEL, 0.01);
    const text = metricsRegistry.render();
    expect(text).toContain('harvester_component_duration_seconds_bucket{namespace="trade",le="0.1"} 1');
    expect(text).toContain('harvester_component_duration_seconds_count{namespace="other"} 1');
  });

  it('expose les jauges du pool de rendu', () => {
    setRenderPoolGauges({ workers: 2, busy: 1, queued: 5 });
    const text = metricsRegistry.render();
    expect(text).toContain('# TYPE harvester_render_workers gauge');
    expect(text).toContain('\nharvester_render_workers 2\n');
    expect(text).toContain('\nharvester_render_busy 1\n');
    expect(text).toContain('\nharvester_render_queued 5\n');
  });

  it('produit un texte dont chaque ligne de sample est valide', () => {
    recordError('command', 'busy');
    observeCommandDuration('shop', 1.5);
    observeComponentDuration('coop', 0.4);
    setRenderPoolGauges({ workers: 1, busy: 0, queued: 0 });
    for (const line of samples(metricsRegistry.render())) {
      expect(line).toMatch(SAMPLE_LINE);
    }
  });

  it('reset remet les jauges à zéro et oublie les séries étiquetées', () => {
    recordError('command', 'busy');
    setRenderPoolGauges({ workers: 3, busy: 3, queued: 9 });
    metricsRegistry.reset();
    const text = metricsRegistry.render();
    expect(text).not.toContain('harvester_errors_total{');
    expect(text).toContain('\nharvester_render_queued 0\n');
  });
});
