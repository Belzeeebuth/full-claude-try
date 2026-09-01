import { getRedis, getSubscriber, key as redisKey } from '../db/redis';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('cluster');

/**
 * Diffusion d'ordres d'administration entre shards.
 *
 * `getSubscriber()` existait depuis l'origine, documentée « pub/sub inter-shards
 * (invalidation de cache, reload config) », et n'avait aucun appelant. La
 * conséquence était concrète : `maintenanceState` étant une variable de module
 * et `reloadConfig()` n'agissant que sur son process, `/admin maintenance on`
 * n'éteignait qu'un shard sur quatre — les trois autres continuaient
 * tranquillement d'accepter les commandes.
 *
 * Redis pub/sub est « au plus une fois » et sans persistance : un shard
 * redémarré ne rejoue pas les messages manqués. C'est acceptable ici parce que
 * l'état de maintenance est aussi lu depuis l'environnement au démarrage, et
 * qu'un rechargement de configuration se refait à la demande.
 */

export type ClusterMessage =
  | { type: 'maintenance'; enabled: boolean; message: string }
  | { type: 'reload-config' };

const CHANNEL = redisKey('cluster');

export async function broadcast(message: ClusterMessage): Promise<void> {
  try {
    await getRedis().publish(CHANNEL, JSON.stringify(message));
  } catch (error) {
    // La diffusion échoue : le shard local a déjà appliqué l'ordre, les autres
    // ne le recevront pas. On le signale fort plutôt que d'échouer l'action.
    log.error({ err: error, type: message.type }, 'diffusion inter-shards impossible');
  }
}

export function subscribeToCluster(handler: (message: ClusterMessage) => void): void {
  const subscriber = getSubscriber();

  subscriber.subscribe(CHANNEL).catch((error: unknown) => {
    log.error({ err: error }, 'abonnement au canal inter-shards impossible');
  });

  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== CHANNEL) return;
    try {
      handler(JSON.parse(raw) as ClusterMessage);
    } catch (error) {
      log.warn({ err: error, raw }, 'message inter-shards illisible');
    }
  });

  log.info({ channel: CHANNEL }, 'canal inter-shards à l\'écoute');
}
