/**
 * Environnement de test.
 *
 * `src/config/env.ts` valide l'environnement à l'import et refuse de démarrer
 * s'il manque un champ — comportement voulu en production. Les tests qui
 * chargent le registre de commandes traversent cette validation sans avoir
 * besoin d'une vraie infrastructure : on fournit donc des valeurs de
 * remplacement, et uniquement si elles sont absentes, pour qu'un `.env` local
 * reste prioritaire.
 */

const PLACEHOLDERS: Record<string, string> = {
  DISCORD_TOKEN: 'test.placeholder.token.not-a-real-discord-token.00000000000',
  DISCORD_CLIENT_ID: '000000000000000000',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[key]) process.env[key] = value;
}

// Marque le fichier comme module : sans cela TypeScript le traite comme un
// script global, et deux préambules déclarant `PLACEHOLDERS` entrent en conflit.
export {};
