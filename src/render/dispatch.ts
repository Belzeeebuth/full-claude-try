import type { AnimalsRenderInput } from './animals';
import { renderAnimals } from './animals';
import type { ChartInput } from './chart';
import { renderMarketChart } from './chart';
import type { FarmRenderInput } from './farm';
import { renderFarm } from './farm';
import type { FishingRenderInput } from './fishing';
import { renderFishing } from './fishing';
import type { LeaderboardRenderInput } from './leaderboard';
import { renderLeaderboard } from './leaderboard';
import type { MiningRenderInput } from './mining';
import { renderMining } from './mining';
import type { PostcardRenderInput } from './postcard';
import { renderPostcard } from './postcard';
import type { ProfileRenderInput } from './profile';
import { renderProfile } from './profile';

/**
 * Table d'aiguillage partagée entre le thread principal et les workers.
 *
 * Un seul endroit connaît la correspondance « nom de rendu → fonction », et les
 * deux côtés du pool s'en servent : le worker pour exécuter le travail, le
 * thread principal pour le repli en ligne quand le pool est indisponible.
 * `RenderInputs` sert aussi de contrat de sérialisation — tout ce qui passe par
 * `postMessage` doit être clonable par l'algorithme de clonage structuré
 * (objets simples, tableaux, `Date`, `null`), ce que respectent les vues
 * construites par les services.
 */

export interface RenderInputs {
  farm: FarmRenderInput;
  profile: ProfileRenderInput;
  chart: ChartInput;
  leaderboard: LeaderboardRenderInput;
  fishing: FishingRenderInput;
  mining: MiningRenderInput;
  animals: AnimalsRenderInput;
  postcard: PostcardRenderInput;
}

export type RenderKind = keyof RenderInputs;

/** Message thread principal → worker. */
export interface RenderJob {
  id: number;
  kind: RenderKind;
  input: RenderInputs[RenderKind];
}

/** Message worker → thread principal. Le PNG voyage en `ArrayBuffer` transféré. */
export type RenderResult =
  | { id: number; ok: true; png: ArrayBuffer; durationMs: number }
  | { id: number; ok: false; error: string };

/** Exécute le rendu dans le thread courant (worker, repli, ou script de preview). */
export async function renderInline<K extends RenderKind>(
  kind: K,
  input: RenderInputs[K],
): Promise<Buffer> {
  switch (kind) {
    case 'farm':
      return renderFarm(input as FarmRenderInput);
    case 'profile':
      return renderProfile(input as ProfileRenderInput);
    case 'chart':
      return renderMarketChart(input as ChartInput);
    case 'leaderboard':
      return renderLeaderboard(input as LeaderboardRenderInput);
    case 'fishing':
      return renderFishing(input as FishingRenderInput);
    case 'mining':
      return renderMining(input as MiningRenderInput);
    case 'animals':
      return renderAnimals(input as AnimalsRenderInput);
    case 'postcard':
      return renderPostcard(input as PostcardRenderInput);
    default: {
      // `kind` est typé `never` ici : ajouter une entrée à `RenderInputs` sans
      // la traiter au-dessus devient une erreur de compilation.
      const exhaustive: never = kind;
      throw new Error(`unknown render kind: ${String(exhaustive)}`);
    }
  }
}
