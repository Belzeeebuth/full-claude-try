import { defineConfig } from 'vitest/config';

/**
 * Les tests couvrent `src/game/**` (logique pure), `src/utils/**` et la
 * validation de la configuration. Ils ne nécessitent NI base de données NI
 * Redis NI token Discord : c'est le bénéfice direct de la séparation
 * commandes → services → repositories, la logique de jeu ne dépend d'aucune I/O.
 */
export default defineConfig({
  test: {
    // Renseigne les variables obligatoires avant que src/config/env.ts ne les
    // valide : les tests chargent le registre sans infrastructure réelle.
    setupFiles: ['tests/setup-env.ts'],
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Les tests d'intégration (tests/integration/**) démarrent leurs propres
    // conteneurs Postgres/Redis et fixent `DATABASE_URL`/`REDIS_URL` eux-mêmes ;
    // les mélanger à cette suite rapide et sans I/O leur ferait hériter des
    // faux placeholders de `setup-env.ts`. Suite dédiée : `npm run test:integration`.
    exclude: ['**/node_modules/**', 'tests/integration/**'],
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/game/**', 'src/utils/**', 'src/config/index.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
