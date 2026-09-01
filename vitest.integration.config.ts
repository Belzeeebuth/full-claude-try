import { defineConfig } from 'vitest/config';

/**
 * Suite d'INTÉGRATION : PostgreSQL et Redis réels requis.
 *
 *   npm run test:integration
 *
 * Elle est séparée de `npm test` à dessein — la suite unitaire doit rester
 * exécutable partout, y compris dans l'étape de build Docker, sans infrastructure.
 * Ici on cherche l'inverse : la vérité du moteur. Les bugs C-1 (sémantique de
 * `RETURNING`), C-2 (invariant du grand livre) et D-3 (clause `WHERE` incomplète)
 * de l'audit n'étaient visibles que contre un vrai PostgreSQL.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    environment: 'node',
    globals: false,
    // Une seule base partagée : les fichiers se marcheraient dessus en
    // parallèle, et chacun commence par un TRUNCATE.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
