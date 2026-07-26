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

/**
 * Traduit les erreurs Discord courantes en instruction actionnable.
 *
 * Par défaut, `DiscordAPIError` embarque le corps complet de la requête : sur un
 * déploiement de 62 commandes, cela noie l'unique information utile — le code —
 * sous plusieurs milliers de lignes de JSON. On extrait donc le diagnostic, et
 * on ne journalise l'erreur brute qu'en `debug`.
 */
function explain(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: number }).status;
  const guild = env.DISCORD_DEV_GUILD_ID;

  // Discord ne renseigne pas toujours `code` : un jeton invalide renvoie un 403
  // au corps vide. On se rabat donc sur le statut HTTP.
  if (code === 50001 || status === 403) {
    return guild
      ? `Accès refusé au serveur ${guild}. Le bot n'y est pas présent, ou il y a été `
        + 'invité sans le scope `applications.commands`. Réinvitez-le avec les deux '
        + 'scopes `bot` et `applications.commands`, ou videz DISCORD_DEV_GUILD_ID '
        + 'pour un déploiement global.'
      : 'Accès refusé. Vérifiez que DISCORD_CLIENT_ID correspond bien au jeton utilisé.';
  }
  if (code === 50035) {
    return 'Payload refusé par Discord : une commande dépasse une limite (nom > 32 '
      + 'caractères, description > 100, plus de 25 options ou choix). Le détail figure '
      + 'dans le champ `errors` de la réponse.';
  }
  if (code === 0 || status === 401) {
    return 'Jeton invalide. DISCORD_TOKEN ne correspond à aucune application.';
  }
  return undefined;
}

main().catch((error: unknown) => {
  const hint = explain(error);
  if (hint) {
    log.fatal({ code: (error as { code?: unknown }).code }, `❌ déploiement impossible — ${hint}`);
    log.debug({ err: error }, 'erreur Discord brute');
  } else {
    log.fatal({ err: error }, '❌ déploiement impossible');
  }
  process.exit(1);
});
