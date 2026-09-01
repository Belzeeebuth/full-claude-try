import { defineConfig } from 'vitest/config';

/**
 * Suite d'INTÉGRATION : elle tape une vraie base PostgreSQL.
 *
 *   npm run test:integration
 *
 * Séparée de `npm test` à dessein — la suite rapide doit rester exécutable
 * partout, y compris dans l'étape de build Docker, sans infrastructure. Ici on
 * cherche l'inverse : la vérité du moteur. Les bugs C-1 (sémantique de
 * `RETURNING`), C-2 (invariant du grand livre) et D-3 (clause `WHERE`
 * incomplète), comme la garantie de `SELECT ... FOR UPDATE` sur une récolte
 * concurrente, ne sont visibles que là.
 *
 * DEUX MÉCANIQUES COHABITENT, volontairement :
 *
 *  - la majorité des fichiers utilise la base de test créée par
 *    `global-setup.ts` à partir des identifiants du `.env` — rapide, et elle
 *    rejoue les migrations en attente à chaque exécution ;
 *  - `harvest-concurrency.test.ts` démarre ses PROPRES conteneurs
 *    (Testcontainers) et fixe `DATABASE_URL`/`REDIS_URL` dans son `beforeAll`
 *    avant tout import applicatif. Il est donc hermétique et ne dépend que d'un
 *    démon Docker.
 *
 * Les deux sont compatibles : `setup.ts` ne fait que poser des variables
 * d'environnement, que le second écrase pour lui-même avant de charger quoi que
 * ce soit de `src/`.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    environment: 'node',
    globals: false,
    // Une seule base partagée : les fichiers se marcheraient dessus en
    // parallèle, et chacun commence par un TRUNCATE. Démarrer plusieurs jeux de
    // conteneurs en même temps n'apporterait rien non plus.
    fileParallelism: false,
    // Démarrage de conteneurs compris : nettement plus lent qu'un test unitaire.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
