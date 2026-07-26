import { Queue, Worker, type Job } from 'bullmq';
import type { Client } from 'discord.js';
import { env } from '../config/env';
import { getQueueConnection } from '../db/redis';
import { moduleLogger } from '../utils/logger';
import { toError } from '../utils/errors';
import * as systemRepo from '../repositories/system.repo';
import { jobs, type JobDefinition } from './definitions';
import { startNotificationWorker } from './notifications';

const log = moduleLogger('scheduler');

/**
 * ---------------------------------------------------------------------------
 * ORDONNANCEUR
 * ---------------------------------------------------------------------------
 * BullMQ (Redis) porte l'exécution : jobs répétables par cron, réessais avec
 * back-off, et surtout DÉDOUBLONNAGE ENTRE PROCESS. Avec plusieurs shards, tous
 * exécutent ce code, mais un job répétable n'est enregistré qu'une fois dans
 * Redis : la mise à jour du marché ne peut donc pas se produire quatre fois.
 *
 * Repli sans Redis (`QUEUES_ENABLED=false`) : un simple `setInterval` par job,
 * réservé au développement local. En production, Redis est requis — c'est écrit
 * dans le README.
 *
 * Chaque exécution est journalisée dans `scheduled_tasks` : `/admin stats`
 * affiche la dernière exécution, sa durée et son éventuelle erreur.
 */

const QUEUE_NAME = 'harvestbot:jobs';

let queue: Queue | undefined;
let worker: Worker | undefined;
const timers: NodeJS.Timeout[] = [];

export async function startScheduler(client: Client): Promise<void> {
  if (!env.SCHEDULER_ENABLED) {
    log.info('ordonnanceur désactivé (SCHEDULER_ENABLED=false)');
    return;
  }

  // Enregistre les tâches en base : elles survivent à une purge de Redis.
  for (const definition of jobs) {
    await systemRepo.registerTask({
      taskKey: definition.key,
      kind: 'cron',
      cron: definition.cron,
      runAt: new Date(),
      payload: { description: definition.description },
    });
  }

  if (env.QUEUES_ENABLED) {
    await startWithBullMq();
  } else {
    startWithTimers();
  }

  startNotificationWorker(client);
  log.info({ jobs: jobs.length, mode: env.QUEUES_ENABLED ? 'bullmq' : 'timers' }, 'ordonnanceur démarré');
}

async function startWithBullMq(): Promise<void> {
  const connection = getQueueConnection();
  queue = new Queue(QUEUE_NAME, { connection });

  // On repart d'une base propre : si un cron a changé dans le code, l'ancien
  // job répétable resterait sinon programmé indéfiniment.
  const existing = await queue.getRepeatableJobs();
  for (const repeatable of existing) {
    await queue.removeRepeatableByKey(repeatable.key);
  }

  for (const definition of jobs) {
    await queue.add(
      definition.key,
      { key: definition.key },
      {
        repeat: { pattern: definition.cron, tz: 'UTC' },
        jobId: definition.key,
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      },
    );
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job: Job<{ key: string }>) => {
      const definition = jobs.find((entry) => entry.key === job.data.key);
      if (!definition) throw new Error(`job inconnu : ${job.data.key}`);
      return runJob(definition);
    },
    { connection, concurrency: 2 },
  );

  worker.on('failed', (job, error) => {
    log.error({ err: error, job: job?.name }, 'job en échec');
  });
}

function startWithTimers(): void {
  // Repli minimaliste : on approxime le cron par un intervalle. Suffisant en
  // développement, jamais recommandé en production (pas de coordination).
  const intervals: Record<string, number> = {
    '*/5 * * * *': 5 * 60_000,
    '*/10 * * * *': 10 * 60_000,
    '*/15 * * * *': 15 * 60_000,
    '0 * * * *': 60 * 60_000,
    '15 * * * *': 60 * 60_000,
    '30 * * * *': 60 * 60_000,
    '0 */2 * * *': 2 * 60 * 60_000,
    '30 */2 * * *': 2 * 60 * 60_000,
    '0 */3 * * *': 3 * 60 * 60_000,
  };

  for (const definition of jobs) {
    const interval = intervals[definition.cron] ?? 24 * 60 * 60_000;
    timers.push(
      setInterval(() => {
        void runJob(definition).catch((error: unknown) =>
          log.error({ err: error, job: definition.key }, 'job en échec'),
        );
      }, interval),
    );
  }
}

async function runJob(definition: JobDefinition): Promise<string> {
  const started = Date.now();
  log.debug({ job: definition.key }, 'job démarré');

  try {
    const result = await definition.run();
    const durationMs = Date.now() - started;
    await systemRepo.completeTask(definition.key, {
      durationMs,
      nextRunAt: new Date(Date.now() + 60_000),
    });
    log.info({ job: definition.key, durationMs, result }, 'job terminé');
    return result;
  } catch (error) {
    const normalized = toError(error);
    await systemRepo.completeTask(definition.key, {
      durationMs: Date.now() - started,
      error: normalized.message,
      nextRunAt: new Date(Date.now() + 300_000),
    });
    log.error({ err: normalized, job: definition.key }, 'job en échec');
    throw normalized;
  }
}

/** Déclenche un job à la demande (utile en exploitation). */
export async function runJobNow(key: string): Promise<string> {
  const definition = jobs.find((entry) => entry.key === key);
  if (!definition) throw new Error(`job inconnu : ${key}`);
  return runJob(definition);
}

export async function stopScheduler(): Promise<void> {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  await worker?.close();
  await queue?.close();
  log.info('ordonnanceur arrêté');
}

export { jobs };
