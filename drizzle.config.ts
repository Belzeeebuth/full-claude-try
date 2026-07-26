import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Configuration drizzle-kit.
 *
 * `npm run db:generate` compare le schéma TypeScript (src/db/schema) à l'état
 * des migrations déjà générées et écrit un nouveau fichier SQL versionné dans
 * `drizzle/`. Les migrations sont ensuite appliquées par notre runner maison
 * (`npm run db:migrate`, cf. src/scripts/migrate.ts) qui journalise chaque
 * fichier appliqué dans la table `migrations`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://harvest:harvest@localhost:5432/harvester',
  },
  verbose: true,
  strict: true,
});
