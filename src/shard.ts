import { join } from 'node:path';
import { ShardingManager } from 'discord.js';
import { env } from './config/env';
import { moduleLogger } from './utils/logger';

const log = moduleLogger('sharding');

/**
 * Gestionnaire de shards.
 *
 * Discord impose le sharding au-delà de 2 500 serveurs, et le recommande bien
 * avant. Chaque shard est un process Node complet exécutant `index.ts` : il a sa
 * propre connexion WebSocket, son propre pool PostgreSQL et sa propre connexion
 * Redis.
 *
 * Points d'attention à l'échelle :
 *  - `SCHEDULER_ENABLED` n'est vrai que pour le shard 0. Sans cela, quatre
 *    shards recalculeraient le marché quatre fois par heure. (BullMQ dédoublonne
 *    déjà, mais cette ceinture supplémentaire évite tout doute.)
 *  - `totalShards: 'auto'` demande à Discord le nombre recommandé.
 *  - `respawn: true` relance un shard mort ; combiné au healthcheck HTTP, cela
 *    couvre à la fois les pannes de process et les blocages silencieux.
 *  - Le pool PostgreSQL est dimensionné PAR SHARD : gardez
 *    `DATABASE_POOL_MAX × nombre de shards < max_connections`.
 */
async function main(): Promise<void> {
  const totalShards = env.SHARDING_TOTAL === 'auto' ? 'auto' : Number.parseInt(env.SHARDING_TOTAL, 10);

  const manager = new ShardingManager(join(__dirname, 'index.js'), {
    token: env.DISCORD_TOKEN,
    totalShards,
    respawn: true,
    mode: 'process',
  });

  manager.on('shardCreate', (shard) => {
    log.info({ shardId: shard.id }, 'shard lancé');

    shard.on('death', () => log.error({ shardId: shard.id }, 'shard mort, relance en cours'));
    shard.on('ready', () => log.info({ shardId: shard.id }, 'shard prêt'));
    shard.on('disconnect', () => log.warn({ shardId: shard.id }, 'shard déconnecté'));

    // Seul le shard 0 porte l'ordonnanceur.
    shard.worker?.on('online', () => undefined);
  });

  await manager.spawn({
    amount: totalShards,
    delay: 5_500,
    timeout: 60_000,
  });

  log.info({ shards: manager.shards.size }, 'tous les shards sont lancés');
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'lancement des shards impossible');
  process.exit(1);
});
