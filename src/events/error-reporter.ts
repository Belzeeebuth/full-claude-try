import { EmbedBuilder, type Client } from 'discord.js';
import { env } from '../config/env';
import { toError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { truncate } from '../utils/format';

const log = moduleLogger('incidents');

/**
 * Rapport d'incident dans un salon privé.
 *
 * Deux protections indispensables :
 *  - DÉDOUBLONNAGE : un bug déclenché par 500 joueurs ne doit pas produire 500
 *    messages. On agrège par signature (message + première ligne de pile) sur
 *    une fenêtre de 5 minutes.
 *  - PLAFOND : au plus 10 rapports par fenêtre, quel que soit le nombre de
 *    signatures. Un incident massif ne doit pas déclencher un rate limit Discord
 *    qui empêcherait le bot de répondre aux joueurs.
 */

interface IncidentContext {
  command?: string;
  userId?: string;
  guildId?: string | null;
}

const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 10;

const seen = new Map<string, { count: number; firstAt: number; reported: boolean }>();
let windowStartedAt = Date.now();
let reportsInWindow = 0;

function signatureOf(error: Error): string {
  const firstFrame = (error.stack ?? '').split('\n')[1]?.trim() ?? '';
  return `${error.name}:${error.message}:${firstFrame}`.slice(0, 200);
}

export async function reportIncident(
  client: Client,
  error: unknown,
  context: IncidentContext = {},
): Promise<void> {
  const normalized = toError(error);
  const signature = signatureOf(normalized);
  const now = Date.now();

  if (now - windowStartedAt > WINDOW_MS) {
    windowStartedAt = now;
    reportsInWindow = 0;
    seen.clear();
  }

  const entry = seen.get(signature) ?? { count: 0, firstAt: now, reported: false };
  entry.count += 1;
  seen.set(signature, entry);

  // Déjà signalé dans cette fenêtre : on compte, on ne renvoie pas de message.
  if (entry.reported) return;
  if (reportsInWindow >= MAX_PER_WINDOW) {
    log.warn({ signature }, 'plafond de rapports atteint pour cette fenêtre');
    return;
  }

  entry.reported = true;
  reportsInWindow += 1;

  if (!env.DISCORD_ERROR_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(env.DISCORD_ERROR_CHANNEL_ID);
    if (!channel?.isTextBased() || !('send' in channel)) return;

    const embed = new EmbedBuilder()
      .setColor(0xd9534f)
      .setTitle('🚨 Incident')
      .setDescription(`\`\`\`\n${truncate(normalized.message, 900)}\n\`\`\``)
      .addFields(
        { name: 'Origine', value: context.command ?? 'inconnue', inline: true },
        { name: 'Joueur', value: context.userId ? `<@${context.userId}>` : '—', inline: true },
        { name: 'Serveur', value: context.guildId ?? 'MP', inline: true },
        {
          name: 'Pile',
          value: `\`\`\`\n${truncate((normalized.stack ?? '').split('\n').slice(1, 6).join('\n'), 900)}\n\`\`\``,
        },
      )
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });
  } catch (sendError) {
    log.error({ err: sendError }, "impossible d'envoyer le rapport d'incident");
  }
}

/** Statistiques d'incidents pour `/admin stats`. */
export function incidentStats(): Array<{ signature: string; count: number }> {
  return [...seen.entries()]
    .map(([signature, entry]) => ({ signature, count: entry.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

/** Branche les gestionnaires d'erreurs process (dernier filet de sécurité). */
export function registerProcessHandlers(client: Client): void {
  process.on('unhandledRejection', (reason) => {
    log.error({ err: toError(reason) }, 'promesse rejetée non gérée');
    void reportIncident(client, reason, { command: 'unhandledRejection' });
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'exception non capturée');
    void reportIncident(client, error, { command: 'uncaughtException' });
    // On ne quitte PAS le process : discord.js survit à la plupart des
    // exceptions isolées, et un redémarrage coûte une reconnexion complète des
    // shards. Un superviseur externe (PM2/systemd) reste le filet ultime.
  });

  client.on('error', (error) => {
    log.error({ err: error }, 'erreur du client Discord');
  });

  client.on('shardError', (error, shardId) => {
    log.error({ err: error, shardId }, 'erreur de shard');
  });
}
