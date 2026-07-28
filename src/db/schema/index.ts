/**
 * Point d'entrée du schéma Drizzle : `drizzle.config.ts` et `getDb()` ne
 * connaissent que ce fichier.
 *
 * Correspondance nom SQL → export TypeScript quand ils diffèrent :
 *   guilds              → coops            (coopératives de joueurs)
 *   guild_members       → coopMembers
 *   guild_objectives    → coopObjectives
 *   guild_treasury_log  → coopTreasuryLog
 *   guild_settings      → guildSettings    (configuration d'un serveur Discord)
 */
export * from './enums';
export * from './config';
export * from './core';
export * from './farming';
export * from './mining';
export * from './economy';
export * from './progression';
export * from './social';
export * from './system';
