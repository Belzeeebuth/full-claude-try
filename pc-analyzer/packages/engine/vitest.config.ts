import { defineConfig } from 'vitest/config';

/**
 * Le moteur est pur : aucune base, aucun réseau, aucun navigateur. Les tests
 * s'exécutent sur les fixtures de `src/fixtures/` et doivent rester rapides —
 * c'est ce qui permet d'exécuter le même code côté navigateur (comparaison
 * instantanée) et côté API.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
