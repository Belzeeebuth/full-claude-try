import { parentPort } from 'node:worker_threads';
import { ensureFonts } from './canvas';
import { renderInline, type RenderJob, type RenderResult } from './dispatch';

/**
 * Worker de rendu.
 *
 * `@napi-rs/canvas` travaille de façon SYNCHRONE dans le thread qui l'appelle :
 * dessiner puis encoder une ferme 8×8 immobilise l'event loop pendant plusieurs
 * centaines de millisecondes. Sur le thread principal, cela retarde tout le
 * reste — les battements de cœur de la passerelle Discord, les autres
 * interactions en cours, la réponse au healthcheck HTTP. Ici, le blocage reste
 * confiné : le thread principal continue de répondre pendant le dessin.
 *
 * Le worker est PERSISTANT. Il charge une fois la configuration, les traductions
 * et les polices, puis traite les demandes en série. Un worker par rendu aurait
 * payé ~100 ms de démarrage et un rechargement complet des modules à chaque
 * image.
 */

const parent = parentPort;
if (!parent) {
  throw new Error('render worker started outside of a worker thread');
}

// Enregistrement des polices au démarrage : la première image n'attend pas.
ensureFonts();

parent.on('message', (job: RenderJob) => {
  void handle(job);
});

async function handle(job: RenderJob): Promise<void> {
  const started = Date.now();
  try {
    const png = await renderInline(job.kind, job.input as never);
    // On détache une copie exacte du PNG pour la TRANSFÉRER : sans transfert,
    // `postMessage` clonerait les ~300 Ko une seconde fois.
    const detached = png.buffer.slice(
      png.byteOffset,
      png.byteOffset + png.byteLength,
    ) as ArrayBuffer;
    const message: RenderResult = {
      id: job.id,
      ok: true,
      png: detached,
      durationMs: Date.now() - started,
    };
    parent!.postMessage(message, [detached]);
  } catch (error) {
    const message: RenderResult = {
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parent!.postMessage(message);
  }
}
