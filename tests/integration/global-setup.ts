import { Client } from 'pg';
import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME, applyTestEnv } from './env';

/**
 * Préparation unique de la suite d'intégration : créer la base de test si elle
 * n'existe pas, puis y appliquer TOUTES les migrations avec le runner du projet.
 *
 * Faire tourner le vrai runner ici a un second effet, volontaire : chaque
 * exécution de la suite est une répétition générale des migrations en attente.
 * Une migration qui ne s'applique pas sur une base vierge échoue ici, pas en
 * production.
 */
export default async function setup(): Promise<void> {
  applyTestEnv();

  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DATABASE_NAME,
    ]);
    if (existing.rowCount === 0) {
      // Le nom vient de la configuration, pas d'une entrée utilisateur, et
      // `assertTestDatabase` l'a déjà contrôlé — mais on le cite quand même.
      await admin.query(`CREATE DATABASE "${TEST_DATABASE_NAME.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  // Import différé : ces modules lisent l'environnement à l'import, il doit
  // déjà pointer sur la base de test.
  const { migrate } = await import('../../src/scripts/migrate');
  const { seed } = await import('../../src/scripts/seed');
  const { closeDatabase } = await import('../../src/db/client');
  const { closeRedis } = await import('../../src/db/redis');
  try {
    const result = await migrate();
    if (result.applied.length > 0) {
      process.stdout.write(
        `[integration] ${result.applied.length} migration(s) appliquée(s) sur ${TEST_DATABASE_NAME}\n`,
      );
    }
    // Les tables de configuration sont des données de RÉFÉRENCE : l'inventaire
    // et les cultures y sont rattachés par clé étrangère, un joueur ne peut pas
    // exister sans elles. Elles survivent au TRUNCATE entre deux tests.
    await seed();
  } finally {
    await closeRedis();
    await closeDatabase();
  }
}
