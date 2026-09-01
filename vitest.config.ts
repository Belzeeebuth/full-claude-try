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
    // Les tests d'intégration ont leur propre configuration : ils exigent une
    // base PostgreSQL, ce que `npm test` ne doit jamais supposer.
    include: ['tests/*.test.ts'],
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
