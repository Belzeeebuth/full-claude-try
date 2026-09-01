import 'dotenv/config';

/**
 * Environnement des tests d'intégration.
 *
 * Ces tests parlent à un VRAI PostgreSQL : c'est tout leur intérêt. Les bugs
 * qu'ils attrapent — sémantique de `RETURNING`, invariant du grand livre,
 * clauses `WHERE` incomplètes — sont précisément ceux qu'aucun test unitaire ni
 * aucune relecture ne voit, parce qu'ils vivent dans le comportement du moteur,
 * pas dans la logique de jeu.
 *
 * La base de test est SÉPARÉE et recréée par `global-setup.ts`. Elle n'est
 * jamais celle du bot : `assertTestDatabase()` refuse de démarrer si le nom ne
 * contient pas « test », parce que la remise à zéro entre deux tests fait un
 * TRUNCATE de toutes les tables.
 */

function readUrl(): { url: string; admin: string; database: string } {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? defaultUrl();
  const parsed = new URL(base);
  const database = parsed.pathname.replace(/^\//, '');

  // La base d'administration sert uniquement à créer la base de test.
  const admin = new URL(base);
  admin.pathname = '/postgres';

  return { url: base, admin: admin.toString(), database };
}

function defaultUrl(): string {
  // Reconstruit depuis les variables du docker-compose : le `.env` du projet
  // donne les identifiants réels, et la base de test en dérive par suffixe.
  const user = encodeURIComponent(process.env.POSTGRES_USER ?? 'harvester');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? 'harvester');
  const host = process.env.TEST_DATABASE_HOST ?? '127.0.0.1';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const name = `${process.env.POSTGRES_DB ?? 'harvester'}_test`;
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

const resolved = readUrl();

export const TEST_DATABASE_URL = resolved.url;
export const ADMIN_DATABASE_URL = resolved.admin;
export const TEST_DATABASE_NAME = resolved.database;
export const TEST_REDIS_PREFIX = process.env.TEST_REDIS_PREFIX ?? 'harvester-itest';

function testRedisUrl(): string {
  if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
  // Le port publié par docker-compose peut différer du 6379 par défaut.
  const port = process.env.REDIS_PORT ?? '6379';
  return `redis://127.0.0.1:${port}`;
}

/**
 * Garde-fou : une base dont le nom ne contient pas « test » est refusée. Sans
 * cela, un `.env` mal rempli ferait passer la suite sur la base de production —
 * et `resetDatabase()` la viderait.
 */
export function assertTestDatabase(): void {
  if (!/test/i.test(TEST_DATABASE_NAME)) {
    throw new Error(
      `Base de test refusée : « ${TEST_DATABASE_NAME} » ne contient pas « test ». ` +
        'Les tests d\'intégration effacent les tables ; ils ne tourneront pas sur cette base.',
    );
  }
}

/** À appeler AVANT tout import de `src/**` : `config/env` fige l'environnement. */
export function applyTestEnv(): void {
  assertTestDatabase();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = testRedisUrl();
  process.env.REDIS_PREFIX = TEST_REDIS_PREFIX;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL ??= 'error';
  process.env.LOG_PRETTY = 'false';

  // Aucun test ne dessine ni ne planifie : on coupe ce qui démarrerait des
  // threads ou des files sans être sollicité.
  process.env.RENDER_ENABLED = 'false';
  process.env.RENDER_WORKERS = '0';
  process.env.QUEUES_ENABLED = 'false';
  process.env.SCHEDULER_ENABLED = 'false';

  // `config/env` valide ces champs même sans Discord en face.
  process.env.DISCORD_TOKEN ??= 'test.placeholder.token.not-a-real-discord-token.00000000000';
  process.env.DISCORD_CLIENT_ID ??= '000000000000000000';
}
