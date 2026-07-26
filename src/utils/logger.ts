import pino, { type Logger } from 'pino';

/**
 * Logs structurés (JSON en production, colorés en développement).
 *
 * Règles :
 *  - un `child` logger par domaine (`logger.child({ mod: 'market' })`) ;
 *  - jamais de secret : `redact` masque tokens et URLs de connexion ;
 *  - toujours passer un objet en premier argument (`log.info({ userId }, 'msg')`)
 *    afin que les champs soient indexables par un collecteur (Loki, Datadog…).
 *
 * Ce module lit `process.env` directement au lieu de dépendre de
 * `config/env.ts` : le logger doit fonctionner AVANT la validation de
 * l'environnement (pour justement pouvoir signaler qu'elle a échoué), et rester
 * importable depuis la logique de jeu pure sans traîner tout l'environnement.
 */
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const rawLevel = (process.env.LOG_LEVEL ?? '').toLowerCase() as LogLevel;
const level: LogLevel = LEVELS.includes(rawLevel) ? rawLevel : 'info';
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const pretty = ['1', 'true', 'yes', 'on'].includes((process.env.LOG_PRETTY ?? '').toLowerCase());

const transport =
  pretty && !isProduction
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{mod} | {msg}',
        },
      }
    : undefined;

export const logger: Logger = pino({
  // En test, on ne veut pas de bruit : seuls les avertissements remontent.
  level: isTest ? 'warn' : level,
  base: {
    service: 'harvester',
    shard: process.env.SHARDS ?? process.env.SHARD_ID ?? '0',
  },
  redact: {
    paths: [
      'token',
      'DISCORD_TOKEN',
      'env.DISCORD_TOKEN',
      'DATABASE_URL',
      'REDIS_URL',
      'TOPGG_TOKEN',
      '*.token',
      '*.password',
      'headers.authorization',
    ],
    censor: '[masqué]',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(transport ? { transport } : {}),
});

/** Logger dédié à un module ; à préférer systématiquement au logger racine. */
export function moduleLogger(mod: string): Logger {
  return logger.child({ mod });
}
