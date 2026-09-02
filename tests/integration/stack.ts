import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Pile HERMÉTIQUE pour les scénarios Testcontainers : un PostgreSQL et un Redis
 * propres à chaque fichier, démarrés dans son `beforeAll`.
 *
 * Même mécanique que `harvest-concurrency.test.ts`, mise en commun pour que les
 * scénarios ne recopient ni le démarrage des conteneurs ni l'aiguillage de
 * l'environnement. La règle qui rend le tout possible ne change pas :
 * `DATABASE_URL`/`REDIS_URL` sont écrites AVANT le moindre import de `src/**`,
 * parce que `src/config/env.ts` fige `process.env` à son premier chargement.
 * L'appelant importe donc tout module applicatif — et `./helpers`, qui en
 * dépend — dynamiquement, APRÈS `startIsolatedStack()`.
 *
 * `setup.ts` (fichier de préparation de la suite) a déjà posé les variables
 * qui ne désignent pas l'infrastructure ; elles sont réécrites ici à
 * l'identique de `harvest-concurrency.test.ts`, pour qu'un scénario reste
 * lisible seul et n'hérite rien par accident.
 *
 * Pourquoi ne pas réutiliser la base partagée de `global-setup.ts` : ces
 * scénarios vérifient des courses (deux dons simultanés, deux passages d'un
 * job) et des clôtures qui remboursent de l'argent — un état de départ hors de
 * tout doute vaut les quelques secondes de démarrage. Les migrations sont
 * rejouées par le vrai runner et les tables de configuration peuplées par le
 * vrai seed : sans lui, planter un blé ou inscrire un objet à l'hôtel des ventes
 * échouerait sur une clé étrangère.
 */

export interface IsolatedStack {
  /** Ferme les connexions applicatives PUIS arrête les conteneurs, dans cet ordre. */
  stop(): Promise<void>;
}

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
// Le tirage d'image à la première exécution peut dépasser la minute par défaut.
const STARTUP_TIMEOUT_MS = 120_000;

export async function startIsolatedStack(): Promise<IsolatedStack> {
  const pg = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_USER: 'harvester', POSTGRES_PASSWORD: 'harvester', POSTGRES_DB: 'harvester' })
    .withExposedPorts(5432)
    // Le port est ouvert avant que le serveur n'accepte les connexions, et
    // l'image démarre un serveur TEMPORAIRE pour créer la base : le message
    // « ready » apparaît deux fois, seule la seconde occurrence désigne le
    // serveur définitif. Attendre le port seul expose le premier `connect` du
    // runner de migrations à « the database system is starting up ».
    .withWaitStrategy(
      Wait.forAll([
        Wait.forListeningPorts(),
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      ]),
    )
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  let redis: StartedTestContainer;
  try {
    redis = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();
  } catch (error) {
    // Ryuk finirait par le faucher, mais un conteneur orphelin pendant tout
    // le reste de la suite ralentit les fichiers suivants pour rien.
    await pg.stop();
    throw error;
  }

  process.env.DISCORD_TOKEN = 'x'.repeat(60);
  process.env.DISCORD_CLIENT_ID = '123456789012345678';
  process.env.DATABASE_URL = `postgresql://harvester:harvester@${pg.getHost()}:${pg.getMappedPort(5432)}/harvester`;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
  // Pas de scheduler, de files ni de rendu : les scénarios ne vérifient que des
  // transactions, rien ne doit démarrer de thread ou de worker en arrière-plan.
  process.env.QUEUES_ENABLED = 'false';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.RENDER_ENABLED = 'false';

  const stop = async (): Promise<void> => {
    // Les connexions se ferment AVANT les conteneurs : `quit()` sur un Redis
    // déjà arrêté relance la stratégie de reconnexion au lieu de rendre la main.
    const { closeDatabase } = await import('../../src/db/client');
    const { closeRedis } = await import('../../src/db/redis');
    await closeDatabase();
    await closeRedis();
    await pg.stop();
    await redis.stop();
  };

  try {
    // Imports différés : l'environnement pointe désormais sur les conteneurs.
    const { migrate } = await import('../../src/scripts/migrate');
    await migrate();

    // Les tables `*_config` (cultures, objets…) sont peuplées depuis
    // `src/config/gameplay/*.json` par le seed, séparément des migrations :
    // l'inventaire et les annonces y sont rattachés par clé étrangère.
    const { seed } = await import('../../src/scripts/seed');
    await seed();
  } catch (error) {
    await stop();
    throw error;
  }

  return { stop };
}

/**
 * Code de la `GameError` par laquelle `promise` est rejetée.
 *
 * Une promesse résolue ou une erreur technique font échouer le test : un
 * scénario qui attend `inventory_full` ne doit pas se contenter de « ça a
 * échoué » — une erreur de connexion aurait exactement le même effet.
 */
export async function gameErrorCodeOf(promise: Promise<unknown>): Promise<string> {
  const { isGameError } = await import('../../src/utils/errors');
  try {
    await promise;
  } catch (error) {
    if (isGameError(error)) return error.code;
    throw error;
  }
  throw new Error('la promesse aurait dû être rejetée par une GameError');
}
