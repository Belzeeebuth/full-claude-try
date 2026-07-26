import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeDatabase, withRawClient } from '../db/client';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('migrate');

/**
 * Runner de migrations SQL.
 *
 * Pourquoi un runner maison plutôt que `drizzle-kit migrate` :
 *  - il enregistre le HASH de chaque fichier appliqué. Si un fichier déjà
 *    appliqué est modifié (erreur classique en équipe), le runner REFUSE de
 *    continuer au lieu de laisser deux environnements diverger silencieusement ;
 *  - chaque fichier s'exécute dans SA transaction : une migration qui échoue à
 *    mi-parcours n'en laisse pas la moitié appliquée ;
 *  - la table `migrations` fait partie du schéma documenté du projet.
 *
 * Les fichiers sont dans `drizzle/` (générés par `npm run db:generate`) et
 * appliqués par ordre alphabétique — le préfixe numérique de drizzle-kit garantit
 * le bon ordre.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle');

interface AppliedMigration {
  name: string;
  hash: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await withRawClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id serial PRIMARY KEY,
        name varchar(128) NOT NULL,
        hash varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL DEFAULT 0,
        applied_by varchar(64)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS migrations_name_uq ON migrations (name);
    `);
  });
}

async function loadApplied(): Promise<Map<string, string>> {
  return withRawClient(async (client) => {
    const result = await client.query<AppliedMigration>('SELECT name, hash FROM migrations');
    return new Map(result.rows.map((row) => [row.name, row.hash]));
  });
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 64);
}

export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `Dossier de migrations introuvable : ${MIGRATIONS_DIR}\n` +
        'Générez-les d\'abord avec `npm run db:generate`.',
    );
  }

  await ensureMigrationsTable();
  const applied = await loadApplied();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  let skipped = 0;

  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const hash = hashOf(content);
    const previousHash = applied.get(file);

    if (previousHash) {
      if (previousHash !== hash) {
        throw new Error(
          `La migration « ${file} » a déjà été appliquée mais son contenu a changé.\n` +
            'Ne modifiez jamais une migration appliquée : créez-en une nouvelle.',
        );
      }
      skipped += 1;
      continue;
    }

    const started = Date.now();
    await withRawClient(async (client) => {
      try {
        await client.query('BEGIN');
        // drizzle-kit sépare les instructions par `--> statement-breakpoint`.
        for (const statement of content.split('--> statement-breakpoint')) {
          const trimmed = statement.trim();
          if (trimmed.length > 0) await client.query(trimmed);
        }
        await client.query(
          'INSERT INTO migrations (name, hash, execution_ms, applied_by) VALUES ($1, $2, $3, $4)',
          [file, hash, Date.now() - started, process.env.USER ?? 'system'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration « ${file} » en échec : ${(error as Error).message}`);
      }
    });

    newlyApplied.push(file);
    log.info({ file, ms: Date.now() - started }, 'migration appliquée');
  }

  return { applied: newlyApplied, skipped };
}

if (require.main === module) {
  migrate()
    .then(async (result) => {
      if (result.applied.length === 0) {
        log.info({ skipped: result.skipped }, '✅ base de données déjà à jour');
      } else {
        log.info(
          { applied: result.applied, skipped: result.skipped },
          `✅ ${result.applied.length} migration(s) appliquée(s)`,
        );
      }
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      log.fatal({ err: error }, '❌ migration impossible');
      await closeDatabase();
      process.exit(1);
    });
}
