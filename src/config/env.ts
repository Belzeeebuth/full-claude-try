import 'dotenv/config';
import { z } from 'zod';

/**
 * Validation de l'environnement au démarrage (fail-fast).
 *
 * Un bot qui démarre avec `DATABASE_URL` absente et qui plante trois minutes
 * plus tard sur la première commande est ingérable en production : on préfère
 * refuser de démarrer avec un message explicite listant TOUTES les variables
 * manquantes. Aucun secret n'est jamais loggé.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on', 'y'].includes(value.trim().toLowerCase());
  });

const intFromEnv = (min: number, max: number, fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    })
    .pipe(z.number().int().min(min).max(max));

const floatFromEnv = (min: number, max: number, fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    })
    .pipe(z.number().min(min).max(max));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

const snowflake = z
  .string()
  .regex(/^\d{15,20}$/, 'doit être un identifiant Discord (15 à 20 chiffres)');

const optionalSnowflake = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined))
  .refine((value) => value === undefined || /^\d{15,20}$/.test(value), {
    message: 'doit être un identifiant Discord (15 à 20 chiffres) ou être vide',
  });

const envSchema = z.object({
  // --- Discord ---
  DISCORD_TOKEN: z.string().min(50, 'token Discord manquant ou tronqué'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_DEV_GUILD_ID: optionalSnowflake,
  DISCORD_ERROR_CHANNEL_ID: optionalSnowflake,
  DISCORD_ANNOUNCE_CHANNEL_ID: optionalSnowflake,
  BOT_OWNER_IDS: csv,

  // --- Données ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  DATABASE_POOL_MAX: intFromEnv(1, 100, 12),
  DATABASE_POOL_IDLE_TIMEOUT_MS: intFromEnv(1_000, 600_000, 30_000),
  DATABASE_STATEMENT_TIMEOUT_MS: intFromEnv(1_000, 120_000, 15_000),
  DATABASE_SSL: booleanish.default(false),
  REDIS_URL: z.string().min(1, 'REDIS_URL est obligatoire'),
  REDIS_PREFIX: z.string().default('harvester'),
  QUEUES_ENABLED: booleanish.default(true),
  SCHEDULER_ENABLED: booleanish.default(true),

  // --- Runtime ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanish.default(false),
  HTTP_PORT: intFromEnv(0, 65_535, 3_001),
  MAINTENANCE_MODE: booleanish.default(false),
  MAINTENANCE_MESSAGE: z
    .string()
    .default('Harvester est en maintenance, revenez dans quelques minutes.'),
  // ⚠ NE JAMAIS nommer ces variables SHARD_COUNT ni SHARDS : ces deux noms
  // appartiennent au protocole interne de discord.js. `ShardingManager` les
  // pose sur l'environnement de chaque processus enfant, et `new Client()` les
  // relit (Client.js §50-62). Une variable `SHARD_COUNT=auto` définie par nous
  // était donc convertie par `Number('auto')` → NaN, et le client refusait de
  // démarrer avec « shardCount must be a number greater than or equal to 1 ».
  SHARDING_TOTAL: z.string().default('auto'),
  SHARDING_LIST: z.string().default('auto'),

  // --- Gameplay ---
  SEASON_LENGTH_DAYS: intFromEnv(1, 365, 14),
  GLOBAL_GROWTH_MULTIPLIER: floatFromEnv(0.05, 100, 1),
  GLOBAL_ECONOMY_MULTIPLIER: floatFromEnv(0.05, 100, 1),
  ENERGY_SYSTEM_ENABLED: booleanish.default(true),
  MARKET_UPDATE_MINUTES: intFromEnv(5, 1_440, 60),

  // --- Rendu ---
  RENDER_ENABLED: booleanish.default(true),
  RENDER_CACHE_TTL: intFromEnv(0, 86_400, 120),
  RENDER_TIMEOUT_MS: intFromEnv(250, 30_000, 4_000),
  ASSETS_DIR: z.string().default('./assets'),

  // --- Intégrations ---
  TOPGG_TOKEN: z.string().optional(),
  TOPGG_WEBHOOK_SECRET: z.string().optional(),
  TOPGG_VOTE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Charge et valide l'environnement. Idempotent : le résultat est mémorisé.
 * En cas d'erreur, on imprime la liste complète des problèmes puis on sort
 * avec le code 1 — jamais de démarrage « à moitié configuré ».
 */
export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    // eslint-disable-next-line no-console -- le logger n'existe pas encore à ce stade
    console.error(
      `\n❌ Configuration invalide. Corrigez votre fichier .env :\n${issues}\n\n` +
        `Référez-vous à .env.example pour la liste complète des variables.\n`,
    );
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
