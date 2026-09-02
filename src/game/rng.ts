/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 *
 * Deux usages, et c'est la raison d'être de ce module :
 *  1. TESTS : la logique de jeu (qualité de récolte, mutations, météo) doit être
 *     vérifiable. Avec `Math.random()` on ne peut qu'espérer ; avec une graine on
 *     affirme « cette graine produit une récolte iridium », et le test ne
 *     devient jamais instable.
 *  2. REPRODUCTIBILITÉ SERVEUR : la météo du jour est tirée depuis la graine
 *     `date + secret`. Tous les shards calculent la même météo sans se parler,
 *     et un incident peut être rejoué à l'identique pour comprendre un rapport
 *     de bug (« hier ma récolte a été détruite »).
 *
 * mulberry32 : 32 bits d'état, période 2^32, distribution uniforme suffisante
 * pour du gameplay. Ce n'est PAS cryptographique — aucun usage sécuritaire.
 */

export interface Rng {
  /** Flottant dans [0, 1). */
  next(): number;
  /** Entier dans [min, max] inclus. */
  int(min: number, max: number): number;
  /** Vrai avec la probabilité `probability` (0-1). */
  chance(probability: number): boolean;
  /** Élément aléatoire du tableau (`undefined` si vide). */
  pick<T>(items: readonly T[]): T | undefined;
  /** Tirage pondéré : `[{value, weight}]`. */
  weighted<T>(entries: ReadonlyArray<{ value: T; weight: number }>): T | undefined;
  /** Copie mélangée (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
  /** Flottant dans [min, max). */
  float(min: number, max: number): number;
}

export function createRng(seed: number | string): Rng {
  let state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const rng: Rng = {
    next,
    float(min, max) {
      return min + next() * (max - min);
    },
    int(min, max) {
      if (max < min) return min;
      return Math.floor(next() * (max - min + 1)) + min;
    },
    chance(probability) {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    weighted(entries) {
      const positive = entries.filter((entry) => entry.weight > 0);
      if (positive.length === 0) return undefined;
      const total = positive.reduce((sum, entry) => sum + entry.weight, 0);
      let roll = next() * total;
      for (const entry of positive) {
        roll -= entry.weight;
        if (roll <= 0) return entry.value;
      }
      return positive[positive.length - 1]?.value;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const swap = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = swap;
      }
      return copy;
    },
  };

  return rng;
}

/**
 * ---------------------------------------------------------------------------
 * GRAINE DU MONDE
 * ---------------------------------------------------------------------------
 * Elle valait auparavant la constante littérale `'harvest'`, écrite dans un
 * dépôt que tout le monde peut lire : la météo du lendemain, la rotation de la
 * boutique et le stock du marché noir étaient donc calculables par n'importe
 * qui — un avantage réel sur un jeu dont l'économie est le cœur.
 *
 * Elle est INJECTÉE et non lue ici : `game/` n'importe rien d'autre que
 * lui-même, et c'est ce qui permet aux tests de la logique de jeu de tourner
 * sans configuration ni infrastructure. `src/config/index.ts` appelle
 * `setWorldSeed(env.WORLD_SEED)` au chargement, et tout consommateur de
 * `dailyRng` passe par ce module — la graine est donc toujours posée avant le
 * premier tirage, en production comme dans les scripts.
 */
let worldSeed = 'harvest';

export function setWorldSeed(seed: string): void {
  worldSeed = seed;
}

/** FNV-1a 32 bits : transforme une graine textuelle en entier. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * RNG « live » (non déterministe) pour les actions joueur ponctuelles.
 * On mélange l'horloge haute résolution afin que deux actions dans la même
 * milliseconde ne partagent pas la même graine.
 */
export function liveRng(salt = ''): Rng {
  return createRng(`${Date.now()}:${process.hrtime.bigint()}:${salt}`);
}

/**
 * RNG déterministe par entité et par jour : deux appels le même jour pour la
 * même entité donnent le même résultat. Utilisé pour la météo et les rotations
 * de boutique, afin que tous les shards soient d'accord sans coordination.
 */
export function dailyRng(scope: string, day: string, secret = worldSeed): Rng {
  return createRng(`${scope}|${day}|${secret}`);
}
