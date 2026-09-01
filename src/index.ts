import { Events } from 'discord.js';
import { createClient, login } from './client';
import { getConfig, reloadConfig } from './config';
import { env } from './config/env';
import { closeDatabase, pingDatabase } from './db/client';
import { closeRedis } from './db/redis';
import { registerProcessHandlers } from './events/error-reporter';
import { registerGuildHandlers } from './events/guild';
import { registerInteractionHandler } from './events/interaction-create';
import { loadCommands, loadComponents, getRegistry } from './framework/registry';
import { startHealthServer } from './http/health';
import { startScheduler, stopScheduler } from './jobs/scheduler';
import { stopNotificationWorker } from './jobs/notifications';
import { reloadCatalogs } from './i18n';
import { closeRenderPool, warmRenderPool } from './render';
import { subscribeToCluster } from './services/cluster';
import { applyMaintenanceLocally } from './services/misc.service';
import { ensureMarketRows } from './services/market.service';
import { ensureSeasonCalendar } from './services/world.service';
import { moduleLogger } from './utils/logger';

const log = moduleLogger('boot');

/**
 * Point d'entrée d'un process Harvester (un shard, ou le bot entier en
 * mono-process). Séquence de démarrage, dans l'ordre :
 *
 *   1. Charger et VALIDER la configuration de gameplay (échec = pas de démarrage).
 *   2. Vérifier la base de données (échec = pas de démarrage : un bot sans base
 *      ne peut rien faire d'utile et afficherait des erreurs à chaque commande).
 *   3. Charger commandes et composants (échec = pas de démarrage).
 *   4. Brancher les gestionnaires d'événements AVANT la connexion, pour ne
 *      manquer aucune interaction dès la première seconde.
 *   5. Se connecter à Discord.
 *   6. Démarrer l'ordonnanceur et le serveur de santé.
 *
 * L'arrêt est propre : on cesse d'accepter des interactions, on ferme les files,
 * puis les connexions. Un `SIGTERM` de Docker laisse le temps de terminer les
 * transactions en cours.
 */
async function main(): Promise<void> {
  log.info(
    { env: env.NODE_ENV, node: process.version, shard: process.env.SHARDS ?? 'mono' },
    'démarrage de Harvester',
  );

  // 1. Configuration de gameplay
  const config = getConfig();
  log.info(
    {
      crops: config.cropList.length,
      animals: config.animalList.length,
      items: config.itemList.length,
      recipes: config.recipeList.length,
      buildings: config.buildingList.length,
    },
    'contenu de jeu chargé',
  );

  // 2. Base de données
  const dbLatency = await pingDatabase();
  log.info({ latencyMs: dbLatency }, 'base de données joignable');

  // 3. Commandes et composants
  loadCommands();
  loadComponents();
  const registry = getRegistry();
  if (registry.commands.size === 0) {
    throw new Error('aucune commande chargée : vérifiez src/commands');
  }

  // 4. Client et événements
  const client = createClient();
  let httpServer: ReturnType<typeof startHealthServer>;
  let shuttingDown = false;

  /**
   * Arrêt propre. Défini AVANT `registerProcessHandlers` pour que le filet de
   * sécurité des exceptions non capturées puisse s'en servir : un process qui
   * survit à une exception inattendue peut porter une transaction déchirée ou un
   * client du pool jamais relâché, ce qui n'a pas sa place dans du code qui
   * manipule de la monnaie.
   */
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal, exitCode }, 'arrêt demandé');
    try {
      stopNotificationWorker();
      await stopScheduler();
      httpServer?.close();
      client.removeAllListeners();
      await client.destroy();
      await closeRenderPool();
      await closeRedis();
      await closeDatabase();
      log.info('arrêt terminé');
      process.exit(exitCode);
    } catch (error) {
      log.error({ err: error }, "échec de l'arrêt propre");
      process.exit(1);
    }
  };

  // L'abonnement inter-shards précède la connexion : un ordre de maintenance
  // envoyé pendant le démarrage doit être capté, pas manqué.
  subscribeToCluster((message) => {
    if (message.type === 'maintenance') {
      applyMaintenanceLocally(message.enabled, message.message);
      return;
    }
    if (message.type === 'reload-config') {
      reloadConfig();
      reloadCatalogs();
      log.warn('configuration rechargée (ordre inter-shards)');
    }
  });

  registerProcessHandlers(client, {
    onFatal: (reason) => void shutdown(reason, 1),
  });
  registerInteractionHandler(client);
  registerGuildHandlers(client);

  client.once(Events.ClientReady, (ready) => {
    log.info(
      {
        tag: ready.user.tag,
        guilds: ready.guilds.cache.size,
        commands: registry.commands.size,
      },
      '✅ Harvester est en ligne',
    );
  });

  // 5. Connexion
  await login(client);

  // 6. Services de fond — après la connexion, pour que les notifications
  // puissent réellement partir.
  await ensureMarketRows();
  await ensureSeasonCalendar();
  await startScheduler(client);
  // Les workers de rendu démarrent maintenant : le premier joueur à taper
  // `/ferme` ne paie ni le lancement du thread ni le chargement des polices.
  warmRenderPool();
  httpServer = startHealthServer(client);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'démarrage impossible');
  process.exit(1);
});
