import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { env } from '../config/env';
import { moduleLogger } from '../utils/logger';
import type { RenderInputs, RenderJob, RenderKind, RenderResult } from './dispatch';

const log = moduleLogger('render-pool');

/**
 * Pool de workers de rendu.
 *
 * POURQUOI — `@napi-rs/canvas` est synchrone. Une image de ferme bloque l'event
 * loop 200 à 800 ms selon la taille de la grille ; pendant ce temps le process
 * ne répond à RIEN, y compris aux battements de cœur de la passerelle Discord.
 * Déporter le dessin sur des threads dédiés rend au thread principal sa
 * disponibilité, ce que ni le cache ni le budget de temps ne pouvaient faire :
 * tous deux mesuraient une attente que le process subissait quand même.
 *
 * BUDGET ET ANNULATION — le budget de `render()` reste une attente côté appelant :
 * quand il expire, la commande répond en texte mais le worker POURSUIT le dessin
 * et le résultat tardif alimente le cache, si bien que l'affichage suivant est
 * immédiat. Annuler à cet instant gaspillerait le travail déjà fait. Le pool
 * n'interrompt que ce qui part réellement en vrille : au-delà du seuil dur
 * (4 × le budget), le worker est TERMINÉ puis remplacé, ce qui libère vraiment
 * le CPU — c'est la seule annulation qu'un thread séparé rend possible.
 *
 * SATURATION — la file a une borne. Au-delà, on refuse immédiatement plutôt que
 * d'accumuler des rendus dont plus personne n'attend le résultat ; l'appelant
 * répond en texte. Sans cette borne, un pic de `/farm` construirait une file que
 * le pool mettrait des minutes à digérer, chaque image arrivant trop tard.
 */

/** Le pool ne peut pas démarrer (workers désactivés ou worker introuvable). */
export class RenderPoolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderPoolUnavailableError';
  }
}

/** File pleine : la charge dépasse la capacité de dessin. */
export class RenderQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderQueueFullError';
  }
}

interface Task {
  id: number;
  kind: RenderKind;
  input: RenderInputs[RenderKind];
  resolve: (png: Buffer) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  current: Task | undefined;
  killTimer: NodeJS.Timeout | undefined;
  killed: boolean;
}

const slots: Slot[] = [];
const queue: Task[] = [];
let nextTaskId = 1;
let unavailable = false;
let closed = false;

function poolSize(): number {
  return env.RENDER_WORKERS;
}

/** Au-delà, on refuse : mieux vaut un embed texte qu'une image hors délai. */
function queueLimit(): number {
  return Math.max(4, poolSize() * 6);
}

/** Seuil de mise à mort : bien au-delà du budget, c'est un rendu parti en vrille. */
function hardTimeoutMs(): number {
  return Math.max(env.RENDER_TIMEOUT_MS * 4, 20_000);
}

/**
 * Le worker compilé (`dist/render/worker.js`) en production ; en développement
 * `tsx` exécute les sources et le thread enfant n'hérite PAS de son
 * compilateur — on l'y réinstalle par un préambule avant de charger le worker.
 */
function spawnWorker(): Worker {
  const compiled = join(__dirname, 'worker.js');
  if (existsSync(compiled)) return new Worker(compiled);

  const source = join(__dirname, 'worker.ts');
  if (!existsSync(source)) {
    throw new RenderPoolUnavailableError(`render worker not found in ${__dirname}`);
  }

  const bootstrap =
    `require(${JSON.stringify(require.resolve('tsx/cjs'))});` +
    `require(${JSON.stringify(source)});`;
  return new Worker(bootstrap, { eval: true });
}

function createSlot(): Slot {
  const slot: Slot = { worker: spawnWorker(), current: undefined, killTimer: undefined, killed: false };

  slot.worker.on('message', (result: RenderResult) => {
    const task = slot.current;
    // Un résultat sans tâche correspondante arrive après une mise à mort ou un
    // remplacement de slot : il n'a plus de destinataire.
    if (!task || task.id !== result.id) return;
    finishTask(slot);
    if (result.ok) {
      task.resolve(Buffer.from(result.png));
    } else {
      task.reject(new Error(result.error));
    }
    pump();
  });

  slot.worker.on('error', (error) => {
    log.error({ err: error }, 'worker de rendu en erreur');
    dropSlot(slot, error);
  });

  slot.worker.on('exit', (code) => {
    if (!closed) log.warn({ code, killed: slot.killed }, 'worker de rendu arrêté');
    dropSlot(slot, new Error(`render worker exited (code ${code})`));
  });

  // Un worker inoccupé ne doit pas maintenir le process en vie : il est
  // « ref » le temps d'une tâche seulement (voir `assign`).
  slot.worker.unref();
  slots.push(slot);
  return slot;
}

function finishTask(slot: Slot): void {
  if (slot.killTimer) clearTimeout(slot.killTimer);
  slot.killTimer = undefined;
  slot.current = undefined;
  slot.worker.unref();
}

/** Retire le slot du pool et fait échouer la tâche qu'il portait. */
function dropSlot(slot: Slot, error: Error): void {
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);

  const task = slot.current;
  finishTask(slot);
  if (task) task.reject(error);

  // Un slot perdu est remplacé au prochain besoin, pas immédiatement : inutile
  // de relancer un worker si plus personne ne demande d'image.
  if (!closed) pump();
}

function assign(slot: Slot, task: Task): void {
  slot.current = task;
  slot.worker.ref();
  slot.killTimer = setTimeout(() => {
    log.error(
      { kind: task.kind, hardTimeoutMs: hardTimeoutMs() },
      'rendu bloqué au-delà du seuil dur, worker terminé',
    );
    slot.killed = true;
    void slot.worker.terminate();
  }, hardTimeoutMs());
  // `unref` sur le timer : lui non plus ne doit pas retenir le process.
  slot.killTimer.unref();

  const job: RenderJob = { id: task.id, kind: task.kind, input: task.input };
  slot.worker.postMessage(job);
}

/** Distribue la file aux slots libres, en créant des workers jusqu'à la taille cible. */
function pump(): void {
  while (queue.length > 0) {
    let slot = slots.find((candidate) => !candidate.current);
    if (!slot) {
      if (slots.length >= poolSize()) return;
      try {
        slot = createSlot();
      } catch (error) {
        // Un worker qui refuse de démarrer ne se réparera pas tout seul :
        // on bascule définitivement en rendu direct pour ce process.
        unavailable = true;
        const failure =
          error instanceof RenderPoolUnavailableError
            ? error
            : new RenderPoolUnavailableError(
                `render worker failed to start: ${(error as Error).message}`,
              );
        log.error({ err: error }, 'pool de rendu indisponible, repli sur le rendu direct');
        while (queue.length > 0) queue.shift()?.reject(failure);
        return;
      }
    }
    const task = queue.shift();
    if (!task) return;
    assign(slot, task);
  }
}

/** Le pool est-il utilisable ? Faux si désactivé par configuration ou en panne. */
export function renderPoolAvailable(): boolean {
  return !closed && !unavailable && poolSize() > 0;
}

/**
 * Soumet un rendu au pool. Rejette avec `RenderPoolUnavailableError` si le pool
 * ne peut pas travailler — l'appelant doit alors dessiner lui-même — ou avec
 * `RenderQueueFullError` sous saturation, auquel cas il ne doit PAS insister.
 */
export function submitRender<K extends RenderKind>(
  kind: K,
  input: RenderInputs[K],
): Promise<Buffer> {
  if (!renderPoolAvailable()) {
    return Promise.reject(new RenderPoolUnavailableError('render pool disabled'));
  }
  if (queue.length >= queueLimit()) {
    return Promise.reject(
      new RenderQueueFullError(`render queue saturated (${queue.length} waiting)`),
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    queue.push({ id: nextTaskId++, kind, input, resolve, reject });
    pump();
  });
}

/**
 * Démarre les workers à l'avance. Sans cela, le premier joueur paie le
 * démarrage du thread et le chargement de la configuration (~150 ms).
 */
export function warmRenderPool(): void {
  if (!renderPoolAvailable()) return;
  try {
    while (slots.length < poolSize()) createSlot();
    log.info({ workers: slots.length }, 'pool de rendu prêt');
  } catch (error) {
    unavailable = true;
    log.error({ err: error }, 'pool de rendu indisponible, repli sur le rendu direct');
  }
}

export function renderPoolStats(): { workers: number; busy: number; queued: number } {
  return {
    workers: slots.length,
    busy: slots.filter((slot) => slot.current).length,
    queued: queue.length,
  };
}

export async function closeRenderPool(): Promise<void> {
  closed = true;
  while (queue.length > 0) {
    queue.shift()?.reject(new RenderPoolUnavailableError('render pool shut down'));
  }
  const workers = slots.splice(0, slots.length);
  await Promise.all(
    workers.map(async (slot) => {
      if (slot.killTimer) clearTimeout(slot.killTimer);
      slot.current?.reject(new RenderPoolUnavailableError('render pool shut down'));
      slot.current = undefined;
      await slot.worker.terminate();
    }),
  );
}
