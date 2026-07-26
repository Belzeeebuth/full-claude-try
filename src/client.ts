import { ActivityType, Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { env } from './config/env';
import { moduleLogger } from './utils/logger';

const log = moduleLogger('client');

/**
 * Client Discord.
 *
 * INTENTS : uniquement `Guilds`. Le bot ne lit AUCUN message (tout passe par les
 * commandes slash), n'a donc pas besoin de `MessageContent` ni de
 * `GuildMembers` — ce sont des intents privilégiés, soumis à vérification par
 * Discord au-delà de 100 serveurs. Demander le minimum, c'est un déploiement à
 * grande échelle sans dossier de vérification et une empreinte mémoire réduite.
 *
 * CACHE : discord.js met tout en cache par défaut (membres, messages,
 * présences), ce qui fait exploser la mémoire sur des milliers de serveurs. On
 * désactive tout ce dont on ne se sert pas ; le bot tient alors dans ~120 Mo par
 * shard, même à 2 500 serveurs.
 */
/**
 * Neutralise un `SHARD_COUNT` / `SHARDS` invalide hérité de l'environnement.
 *
 * Ces deux noms appartiennent au protocole interne de discord.js : c'est ainsi
 * que `ShardingManager` transmet son découpage aux processus enfants, et
 * `new Client()` les relit quand l'option correspondante n'est pas fournie
 * (Client.js §50-62). Une valeur non numérique — un `SHARD_COUNT=auto` laissé
 * dans un ancien `.env`, par exemple — devient `NaN` et fait échouer le
 * démarrage avec « shardCount must be a number greater than or equal to 1 ».
 *
 * Sous ShardingManager (`SHARDING_MANAGER=true`), les valeurs sont posées par
 * le manager et forcément correctes : on n'y touche pas. Hors sharding, on
 * retire ce qui est inexploitable plutôt que de laisser le bot en boucle de
 * redémarrage.
 */
function sanitizeShardEnv(): void {
  if (process.env.SHARDING_MANAGER === 'true') return;

  for (const key of ['SHARD_COUNT', 'SHARDS'] as const) {
    const raw = process.env[key];
    if (raw === undefined) continue;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      log.warn(
        { variable: key, value: raw },
        'variable réservée à discord.js ignorée : utilisez SHARDING_TOTAL / SHARDING_LIST',
      );
      delete process.env[key];
    }
  }
}

export function createClient(): Client {
  sanitizeShardEnv();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel], // nécessaire pour envoyer des MP
    allowedMentions: { parse: ['users'], repliedUser: false },
    failIfNotExists: false,
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      GuildMemberManager: { maxSize: 1, keepOverLimit: (member) => member.id === member.client.user.id },
      UserManager: { maxSize: 200 },
      PresenceManager: 0,
      ReactionManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
      AutoModerationRuleManager: 0,
      ThreadManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      users: { interval: 3_600, filter: () => (user) => user.id !== user.client.user.id },
    },
    presence: {
      status: 'online',
      activities: [{ name: '/start — 🌾 cultiver sa ferme', type: ActivityType.Playing }],
    },
  });

  client.on('warn', (message) => log.warn({ message }, 'avertissement discord.js'));
  client.on('shardReady', (shardId) => log.info({ shardId }, 'shard prêt'));
  client.on('shardDisconnect', (_event, shardId) => log.warn({ shardId }, 'shard déconnecté'));
  client.on('shardReconnecting', (shardId) => log.info({ shardId }, 'shard en reconnexion'));
  client.on('shardResume', (shardId) => log.info({ shardId }, 'shard repris'));

  return client;
}

export async function login(client: Client): Promise<void> {
  await client.login(env.DISCORD_TOKEN);
}
