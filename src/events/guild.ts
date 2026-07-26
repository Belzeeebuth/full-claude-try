import type { Client, Guild } from 'discord.js';
import * as systemRepo from '../repositories/system.repo';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('guilds');

/**
 * Suivi des serveurs Discord.
 *
 * On enregistre l'arrivée et le départ pour deux raisons : afficher un compteur
 * fiable dans `/admin stats` (le cache discord.js ment quand le bot est shardé),
 * et conserver la configuration d'un serveur si le bot y revient — un
 * administrateur qui réinvite le bot retrouve ses réglages.
 */
export function registerGuildHandlers(client: Client): void {
  client.on('guildCreate', (guild: Guild) => {
    void systemRepo
      .ensureGuildSettings(guild.id, {
        name: guild.name,
        memberCount: guild.memberCount,
        locale: guild.preferredLocale.startsWith('fr') ? 'fr' : 'en',
      })
      .then(() => log.info({ guildId: guild.id, name: guild.name, members: guild.memberCount }, 'serveur rejoint'))
      .catch((error: unknown) => log.error({ err: error, guildId: guild.id }, 'enregistrement du serveur échoué'));
  });

  client.on('guildDelete', (guild: Guild) => {
    void systemRepo
      .markGuildLeft(guild.id)
      .then(() => log.info({ guildId: guild.id }, 'serveur quitté'))
      .catch((error: unknown) => log.error({ err: error, guildId: guild.id }, 'sortie de serveur non enregistrée'));
  });
}
