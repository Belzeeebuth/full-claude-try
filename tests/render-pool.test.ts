import { afterAll, describe, expect, it } from 'vitest';
import type { ChartInput } from '../src/render/chart';
import { renderInline } from '../src/render/dispatch';
import {
  RenderQueueFullError,
  closeRenderPool,
  renderPoolAvailable,
  renderPoolStats,
  submitRender,
  warmRenderPool,
} from '../src/render/pool';

/**
 * Pool de rendu : le dessin doit sortir du thread principal sans rien changer
 * au résultat.
 *
 * Le graphique de marché est le sujet idéal : il ne dépend d'aucun sprite ni
 * d'aucune police optionnelle, donc son PNG est reproductible d'une exécution à
 * l'autre — ce qui permet de comparer octet pour octet le rendu direct et le
 * rendu par worker.
 */

function chartInput(seed: number): ChartInput {
  const now = Date.UTC(2026, 0, 1);
  return {
    locale: 'fr',
    title: `Melon ${seed}`,
    emoji: '🍈',
    points: Array.from({ length: 24 }, (_, index) => ({
      price: 90 + Math.round(Math.sin((index + seed) / 3) * 20),
      recordedAt: new Date(now - (24 - index) * 3_600_000),
    })),
    basePrice: 90,
    currentPrice: 112,
    trend: 0.08,
    demandIndex: 1.1,
  } as ChartInput;
}

function isPng(buffer: Buffer): boolean {
  return buffer.length > 1_000 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === 'PNG';
}

describe('pool de rendu', () => {
  afterAll(async () => {
    await closeRenderPool();
  });

  it('produit exactement la même image que le rendu direct', async () => {
    expect(renderPoolAvailable()).toBe(true);
    const input = chartInput(1);
    const [direct, pooled] = await Promise.all([
      renderInline('chart', input),
      submitRender('chart', input),
    ]);
    expect(isPng(pooled)).toBe(true);
    expect(pooled.equals(direct)).toBe(true);
  }, 60_000);

  it('laisse le thread principal disponible pendant le dessin', async () => {
    warmRenderPool();
    // Un timer de 10 ms qui dérive de plus de 150 ms signale un event loop
    // bloqué. Le rendu direct dépasse largement ce seuil, d'où le pool.
    let worst = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last - 10);
      last = now;
    }, 10);

    try {
      await Promise.all([0, 1, 2].map((seed) => submitRender('chart', chartInput(seed))));
    } finally {
      clearInterval(ticker);
    }
    expect(worst).toBeLessThan(150);
  }, 60_000);

  it('refuse les rendus au-delà de la file plutôt que de les accumuler', async () => {
    const flood = Array.from({ length: 40 }, (_, index) => submitRender('chart', chartInput(index)));
    const results = await Promise.allSettled(flood);
    const refused = results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof RenderQueueFullError,
    );
    expect(refused.length).toBeGreaterThan(0);
    // Ce qui est accepté est bien rendu : la saturation ne corrompt rien.
    for (const result of results) {
      if (result.status === 'fulfilled') expect(isPng(result.value)).toBe(true);
    }
  }, 120_000);

  it('survit à une erreur de rendu', async () => {
    const broken = { ...chartInput(0), points: undefined } as unknown as ChartInput;
    await expect(submitRender('chart', broken)).rejects.toThrow();

    // Le worker n'est pas tombé avec l'erreur : le rendu suivant aboutit.
    const next = await submitRender('chart', chartInput(7));
    expect(isPng(next)).toBe(true);
    expect(renderPoolStats().workers).toBeGreaterThan(0);
  }, 60_000);
});
