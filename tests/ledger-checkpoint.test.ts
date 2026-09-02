import { describe, expect, it } from 'vitest';
import { balance as getBalance } from '../src/config';
import {
  driftOf,
  expectedBalance,
  nextCheckpoint,
  periodStartFor,
  purgeBoundary,
  retentionCutoff,
  type CheckpointRef,
  type CheckpointSummary,
} from '../src/services/ledger.service';

/**
 * Rétention du journal comptable : tout ce qui est décidable sans base.
 *
 * Le SQL de `ledger.repo.ts` implémente ces mêmes règles ; ce sont elles que
 * l'on fige ici, avec l'invariant qui justifie toute la mécanique : le solde
 * reste égal à « ouverture + écritures postérieures » avant, pendant et après
 * une purge.
 */

const utc = (iso: string): Date => new Date(iso);

describe('journal : périodes et coupure', () => {
  it('ouvre la période au jour de checkpoint du mois courant, ou du précédent', () => {
    expect(periodStartFor(utc('2026-09-02T04:00:00Z'), 1)).toBe('2026-09-01');
    expect(periodStartFor(utc('2026-09-01T05:00:00Z'), 1)).toBe('2026-09-01');
    // Le 2, un jour de checkpoint au 15 n'est pas encore arrivé : période d'août.
    expect(periodStartFor(utc('2026-09-02T04:00:00Z'), 15)).toBe('2026-08-15');
    expect(periodStartFor(utc('2026-09-15T00:00:00Z'), 15)).toBe('2026-09-15');
  });

  it('raisonne en UTC et survit aux fins de mois', () => {
    // 23:30 à Paris le 31 août, mais déjà le 1er septembre… non : 21:30 UTC le 31.
    expect(periodStartFor(utc('2026-08-31T21:30:00Z'), 1)).toBe('2026-08-01');
    // Le 1er mars, un jour au 28 renvoie au 28 février — qui existe toujours.
    expect(periodStartFor(utc('2026-03-01T00:00:00Z'), 28)).toBe('2026-02-28');
    expect(periodStartFor(utc('2026-03-31T12:00:00Z'), 28)).toBe('2026-03-28');
  });

  it('recule la coupure de N mois calendaires et garde les deux bornes', () => {
    const cutoff = retentionCutoff(utc('2026-09-02T04:00:00Z'), 12, 1);
    expect(cutoff.period).toBe('2025-09-01');
    expect(cutoff.instant.toISOString()).toBe('2025-09-02T04:00:00.000Z');

    const short = retentionCutoff(utc('2026-09-02T04:00:00Z'), 4, 1);
    expect(short.period).toBe('2026-05-01');
  });

  it('respecte les bornes de la configuration livrée', () => {
    // La fenêtre de `/history` (90 jours) doit tenir dans la rétention : un
    // joueur qui consulte trois mois d'historique ne doit jamais voir un trou.
    const { ledger } = getBalance().economy;
    expect(ledger.retentionMonths * 28).toBeGreaterThanOrEqual(90);
    expect(ledger.checkpointDay).toBeGreaterThanOrEqual(1);
    expect(ledger.checkpointDay).toBeLessThanOrEqual(28);
  });
});

describe('journal : solde d\'ouverture et écart', () => {
  it('sans checkpoint, le solde attendu est la somme depuis l\'origine', () => {
    expect(expectedBalance(undefined, 1_250)).toBe(1_250);
    expect(expectedBalance(undefined, 0)).toBe(0);
  });

  it('avec checkpoint, le solde attendu est ouverture + écritures postérieures', () => {
    const checkpoint: CheckpointRef = { openingBalance: 4_000, transactionsThrough: 120 };
    expect(expectedBalance(checkpoint, -350)).toBe(3_650);
    expect(expectedBalance(checkpoint, 0)).toBe(4_000);
  });

  it('enchaîne les checkpoints : ouverture = précédent + delta, borne = dernière écriture', () => {
    const first = nextCheckpoint(undefined, { sum: 1_500, lastId: 42 });
    expect(first).toEqual({ openingBalance: 1_500, transactionsThrough: 42 });

    const second = nextCheckpoint(first, { sum: -300, lastId: 90 });
    expect(second).toEqual({ openingBalance: 1_200, transactionsThrough: 90 });
  });

  it('un mois sans écriture ne fait ni bouger l\'ouverture ni reculer la borne', () => {
    const previous: CheckpointRef = { openingBalance: 1_200, transactionsThrough: 90 };
    expect(nextCheckpoint(previous, { sum: 0, lastId: null })).toEqual(previous);
  });

  it('un compte neuf sans aucune écriture démarre à zéro, borne à zéro', () => {
    expect(nextCheckpoint(undefined, { sum: 0, lastId: null })).toEqual({
      openingBalance: 0,
      transactionsThrough: 0,
    });
  });

  it('détecte un écart signé entre solde réel et solde attendu', () => {
    expect(driftOf(1_200, 1_200)).toBe(0);
    expect(driftOf(1_250, 1_200)).toBe(50);
    expect(driftOf(1_000, 1_200)).toBe(-200);
  });
});

describe('journal : sélection de la borne de purge', () => {
  const cutoff = retentionCutoff(utc('2026-09-02T04:00:00Z'), 12, 1);
  const checkpoint = (
    periodStart: string,
    transactionsThrough: number,
    overrides: Partial<CheckpointSummary> = {},
  ): CheckpointSummary => ({
    periodStart,
    transactionsThrough,
    drift: 0,
    computedAt: utc(`${periodStart}T05:00:00Z`),
    ...overrides,
  });

  it('ne purge jamais sans checkpoint', () => {
    expect(purgeBoundary([], cutoff)).toBeNull();
  });

  it('choisit le plus récent des checkpoints sous la coupure, pas le plus ancien', () => {
    const boundary = purgeBoundary(
      [
        checkpoint('2025-06-01', 100),
        checkpoint('2025-09-01', 400),
        checkpoint('2026-08-01', 900),
      ],
      cutoff,
    );
    expect(boundary?.periodStart).toBe('2025-09-01');
    expect(boundary?.transactionsThrough).toBe(400);
  });

  it('refuse tout quand le DERNIER checkpoint porte une dérive, même ancien et sain', () => {
    expect(
      purgeBoundary(
        [checkpoint('2025-06-01', 100), checkpoint('2026-08-01', 900, { drift: 25 })],
        cutoff,
      ),
    ).toBeNull();
  });

  it('tolère une dérive ancienne si le dernier checkpoint est revenu à zéro', () => {
    const boundary = purgeBoundary(
      [checkpoint('2025-06-01', 100, { drift: 25 }), checkpoint('2026-08-01', 900)],
      cutoff,
    );
    expect(boundary?.periodStart).toBe('2025-06-01');
  });

  it('ignore un checkpoint calculé après l\'instant de coupure, malgré son étiquette', () => {
    // Étiqueté du 1er septembre 2025 mais calculé le 20 : ses écritures
    // peuvent avoir moins de douze mois, on retombe sur le précédent.
    const boundary = purgeBoundary(
      [
        checkpoint('2025-06-01', 100),
        checkpoint('2025-09-01', 400, { computedAt: utc('2025-09-20T10:00:00Z') }),
        checkpoint('2026-08-01', 900),
      ],
      cutoff,
    );
    expect(boundary?.periodStart).toBe('2025-06-01');
  });

  it('ne purge rien tant qu\'aucune période n\'a l\'âge de la rétention', () => {
    expect(
      purgeBoundary([checkpoint('2025-10-01', 400), checkpoint('2026-08-01', 900)], cutoff),
    ).toBeNull();
  });

  it('accepte une liste réduite aux deux extrémités (pré-sélection SQL)', () => {
    // Le dépôt ne rapatrie que le dernier checkpoint et le dernier sous la
    // coupure ; la décision doit être la même que sur la liste complète.
    const full = [
      checkpoint('2025-03-01', 10),
      checkpoint('2025-06-01', 100),
      checkpoint('2025-09-01', 400),
      checkpoint('2026-05-01', 700),
      checkpoint('2026-08-01', 900),
    ];
    const reduced = [checkpoint('2025-09-01', 400), checkpoint('2026-08-01', 900)];
    expect(purgeBoundary(reduced, cutoff)).toEqual(purgeBoundary(full, cutoff));
  });
});

describe('journal : l\'invariant tient à travers checkpoints et purge', () => {
  interface Entry {
    id: number;
    amount: number;
  }

  /** Solde attendu à partir du journal restant et du dernier checkpoint : ce que fait l'audit horaire. */
  function audit(journal: readonly Entry[], latest: CheckpointRef | undefined): number {
    const through = latest?.transactionsThrough ?? 0;
    const sumAfter = journal
      .filter((entry) => entry.id > through)
      .reduce((total, entry) => total + entry.amount, 0);
    return expectedBalance(latest, sumAfter);
  }

  it('solde = ouverture + écritures postérieures, avant, pendant et après purge', () => {
    // Trois « mois » d'écritures, identifiants croissants comme un bigserial.
    const months: Entry[][] = [
      [
        { id: 1, amount: 500 },
        { id: 2, amount: -120 },
        { id: 3, amount: 900 },
      ],
      [
        { id: 4, amount: -300 },
        { id: 5, amount: 45 },
      ],
      [
        { id: 6, amount: 2_000 },
        { id: 7, amount: -1_999 },
      ],
    ];
    const balance = months.flat().reduce((total, entry) => total + entry.amount, 0);

    let journal: Entry[] = [];
    let latest: CheckpointRef | undefined;
    const chain: CheckpointRef[] = [];

    for (const month of months) {
      journal = [...journal, ...month];
      const sinceLast = month.filter((entry) => entry.id > (latest?.transactionsThrough ?? 0));
      latest = nextCheckpoint(latest, {
        sum: sinceLast.reduce((total, entry) => total + entry.amount, 0),
        lastId: sinceLast.at(-1)?.id ?? null,
      });
      chain.push(latest);
      // Le checkpoint du mois est exactement le solde à ce moment-là.
      expect(driftOf(journal.reduce((t, e) => t + e.amount, 0), latest.openingBalance)).toBe(0);
    }

    expect(audit(journal, latest)).toBe(balance);
    expect(audit(journal, undefined)).toBe(balance);

    // Purge progressive de tout ce que couvre le PREMIER checkpoint, une ligne
    // à la fois : à chaque étape l'audit, calé sur le dernier checkpoint,
    // trouve encore le bon solde.
    const boundary = chain[0]!;
    while (journal.some((entry) => entry.id <= boundary.transactionsThrough)) {
      const victim = journal.find((entry) => entry.id <= boundary.transactionsThrough)!;
      journal = journal.filter((entry) => entry !== victim);
      expect(audit(journal, latest)).toBe(balance);
    }
    expect(journal.map((entry) => entry.id)).toEqual([4, 5, 6, 7]);

    // Et un écart injecté hors journal est vu, purge ou pas.
    expect(driftOf(balance + 1, audit(journal, latest))).toBe(1);
  });
});
