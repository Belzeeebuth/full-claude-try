import { REST, Routes } from 'discord.js';
import { env } from '../config/env';
import { commandPayloads, loadCommands, loadComponents } from '../framework/registry';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('deploy');

/**
 * Déploiement des commandes slash auprès de Discord.
 *
 * Deux portées :
 *  - GUILD (si `DISCORD_DEV_GUILD_ID` est défini) : propagation INSTANTANÉE.
 *    C'est la portée de développement, à utiliser en boucle.
 *  - GLOBAL : propagation en environ une heure, pour la production.
 *
 * `PUT` remplace intégralement le jeu de commandes : les commandes supprimées du
 * code disparaissent aussi côté Discord. C'est voulu — pas de commande fantôme
 * qui répondrait « commande inconnue ».
 *
 *   npm run commands:deploy          déploie
 *   npm run commands:clear           supprime tout (nettoyage)
 */
async function main(): Promise<void> {
  const clear = process.argv.includes('--clear');

  loadCommands();
  loadComponents();
  const payloads = clear ? [] : commandPayloads();

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  const route = env.DISCORD_DEV_GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_DEV_GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  log.info(
    {
      scope: env.DISCORD_DEV_GUILD_ID ? `serveur ${env.DISCORD_DEV_GUILD_ID}` : 'global',
      commands: payloads.length,
    },
    clear ? 'suppression des commandes' : 'déploiement des commandes',
  );

  const result = (await rest.put(route, { body: payloads })) as unknown[];

  log.info({ count: result.length }, clear ? '✅ commandes supprimées' : '✅ commandes déployées');

  if (!clear && !env.DISCORD_DEV_GUILD_ID) {
    log.warn('déploiement GLOBAL : la propagation peut prendre jusqu\'à une heure');
  }

  for (const payload of payloads) {
    log.debug({ name: payload.name }, 'commande déployée');
  }
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, '❌ déploiement impossible');
  process.exit(1);
});
