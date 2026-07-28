import { defineConfig } from 'vitest/config';

/**
 * Suite d'intégration, séparée de la suite rapide (`vitest.config.ts`).
 *
 * Ces tests démarrent de vrais conteneurs PostgreSQL et Redis (Testcontainers)
 * et fixent eux-mêmes `DATABASE_URL`/`REDIS_URL` avant de charger le moindre
 * module applicatif — d'où l'absence de `setupFiles` : les placeholders de la
 * suite rapide écraseraient sinon une configuration déjà posée. Nécessite un
 * démon Docker accessible ; c'est le seul prérequis (aucune base ni aucun
 * Redis à démarrer à la main).
 *
 *   npm run test:integration
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
    // Démarrage de conteneurs : nettement plus lent qu'un test unitaire.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Un seul worker : deux suites qui démarrent chacune leurs conteneurs en
    // parallèle n'apportent rien ici (peu de fichiers) et compliquent le
    // diagnostic si Docker est lent à répondre.
    fileParallelism: false,
  },
});
