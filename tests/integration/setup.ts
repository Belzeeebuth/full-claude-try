import { afterAll } from 'vitest';
import { applyTestEnv } from './env';

/**
 * Exécuté dans CHAQUE fichier de test, avant tout import de `src/**` : les
 * modules de configuration lisent `process.env` au chargement, l'aiguillage vers
 * la base de test doit donc être fait ici et pas dans un `beforeAll`.
 */
applyTestEnv();

afterAll(async () => {
  const { closeDatabase } = await import('../../src/db/client');
  const { closeRedis } = await import('../../src/db/redis');
  await closeDatabase();
  await closeRedis();
});
