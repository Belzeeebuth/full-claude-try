import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Test d'intégration sur base réelle (dette technique #1 de la roadmap).
 *
 * Les 125 tests de `tests/**` couvrent la logique pure : ils ne prouvent PAS
 * que deux `/harvest` simultanés sur la même parcelle ne récoltent qu'une
 * fois. Cette garantie vient de `lockUserRow()` (`SELECT ... FOR UPDATE`,
 * isolation `read committed`) dans `farmService.harvest()` — un mécanisme
 * PostgreSQL réel, qu'aucun mock ni base en mémoire ne peut vérifier
 * honnêtement : le test doit taper une vraie base.
 *
 * `DATABASE_URL`/`REDIS_URL` sont fixées APRÈS le démarrage des conteneurs,
 * donc tout module applicatif est importé dynamiquement (`await import`) —
 * `src/config/env.ts` valide `process.env` une seule fois, à son premier
 * import, et il ne doit voir passer que la vraie URL de connexion.
 */

describe('récolte concurrente sur la même parcelle', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;

  beforeAll(async () => {
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'harvester', POSTGRES_PASSWORD: 'harvester', POSTGRES_DB: 'harvester' })
      .withExposedPorts(5432)
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    process.env.DISCORD_TOKEN = 'x'.repeat(60);
    process.env.DISCORD_CLIENT_ID = '123456789012345678';
    process.env.DATABASE_URL = `postgresql://harvester:harvester@${pg.getHost()}:${pg.getMappedPort(5432)}/harvester`;
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error';
    // Pas de scheduler/files pour un test qui ne vérifie qu'une transaction.
    process.env.QUEUES_ENABLED = 'false';
    process.env.SCHEDULER_ENABLED = 'false';
    process.env.RENDER_ENABLED = 'false';

    const { migrate } = await import('../../src/scripts/migrate');
    await migrate();

    // Les tables `*_config` (cultures, objets…) sont peuplées depuis
    // `src/config/gameplay/*.json` par le seed, séparément des migrations :
    // planter un blé échouerait sur une contrainte de clé étrangère sinon.
    const { seed } = await import('../../src/scripts/seed');
    await seed();
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../../src/db/client');
    const { closeRedis } = await import('../../src/db/redis');
    await closeDatabase();
    await closeRedis();
    await pg?.stop();
    await redis?.stop();
  });

  it('ne laisse aboutir qu\'une seule des deux récoltes simultanées', async () => {
    const { ensurePlayer } = await import('../../src/services/player.service');
    const { plant, harvest } = await import('../../src/services/farm.service');
    const { getDb } = await import('../../src/db/client');
    const { isGameError } = await import('../../src/utils/errors');
    const schema = await import('../../src/db/schema');
    const { and, eq, sql } = await import('drizzle-orm');

    const ensured = await ensurePlayer({
      discordId: '111222333444555666',
      username: 'concurrency-test',
      createIfMissing: true,
    });
    if (!ensured) throw new Error('joueur de test non créé');
    const { player } = ensured;

    await plant(player, { cropKey: 'wheat', slot: 1 });

    // La pousse est calculée à la lecture (voir farming.ts) : on force la
    // maturité immédiatement plutôt que d'attendre le vrai temps de croissance.
    // Alignée sur `planted_at` (et non une date arbitraire) pour respecter la
    // contrainte CHECK `ready_at >= planted_at`.
    const db = getDb();
    await db
      .update(schema.plantedCrops)
      .set({ readyAt: sql`${schema.plantedCrops.plantedAt}` })
      .where(eq(schema.plantedCrops.userId, player.id));

    const [first, second] = await Promise.allSettled([
      harvest(player, { slot: 1 }),
      harvest(player, { slot: 1 }),
    ]);

    const settled = [first, second];
    const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = settled.filter((outcome) => outcome.status === 'rejected');

    // Le point central : exactement une récolte a abouti, jamais deux, jamais zéro.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0];
    if (rejection?.status === 'rejected') {
      expect(isGameError(rejection.reason)).toBe(true);
      expect((rejection.reason as { code: string }).code).toBe('crop_not_ready');
    }

    const winner = fulfilled[0];
    const harvestedQuantity = winner?.status === 'fulfilled' ? winner.value.totalQuantity : 0;
    expect(harvestedQuantity).toBeGreaterThan(0);

    const rows = await db
      .select({ quantity: schema.inventory.quantity })
      .from(schema.inventory)
      .where(and(eq(schema.inventory.userId, player.id), eq(schema.inventory.itemKey, 'wheat')));
    const wheatQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);

    // La quantité en inventaire correspond à UNE récolte, pas à deux cumulées.
    expect(wheatQuantity).toBe(harvestedQuantity);
  });
});
