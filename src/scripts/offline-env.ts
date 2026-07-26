/**
 * Valeurs de remplacement pour les scripts qui tournent SANS infrastructure.
 *
 * `src/config/env.ts` valide l'environnement à l'import et échoue si un champ
 * obligatoire manque — c'est voulu : le bot ne doit jamais démarrer à moitié
 * configuré. Mais `render:preview`, `brand` et `balance:report` ne joignent ni
 * Discord, ni PostgreSQL, ni Redis : exiger un vrai token pour dessiner un PNG
 * n'aurait aucun sens.
 *
 * Ce module remplit donc les seules variables obligatoires, **uniquement si
 * elles sont absentes**. Un `.env` réel est toujours prioritaire, et le point
 * d'entrée du bot n'importe jamais ce fichier : la garantie de démarrage strict
 * reste entière en production.
 *
 * À importer EN PREMIER, avant toute chose qui remonte jusqu'à `config/env`.
 */

const PLACEHOLDERS: Record<string, string> = {
  // Le schéma exige au moins 50 caractères (un vrai token en fait ~70).
  DISCORD_TOKEN: 'offline.placeholder.token.not-a-real-discord-token.0000000000',
  DISCORD_CLIENT_ID: '000000000000000000',
  DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:5432/offline',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[key]) process.env[key] = value;
}

// Un script hors-ligne ne doit pas polluer la sortie avec des journaux JSON :
// c'est le rendu ou le rapport qu'on veut lire.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

// Marque le fichier comme module : sans cela TypeScript le traite comme un
// script global, et deux préambules déclarant `PLACEHOLDERS` entrent en conflit.
export {};
