import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import { env } from '../config/env';
import { pingDatabase } from '../db/client';
import { pingRedis } from '../db/redis';
import { getConfig } from '../config';
import { getRegistry } from '../framework/registry';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('http');

/**
 * Serveur HTTP d'observabilité.
 *
 *   GET /health   → 200 si le bot est connecté ET la base joignable ; 503 sinon.
 *                   C'est ce que doivent interroger Docker, Kubernetes ou un
 *                   superviseur : un process vivant mais déconnecté de Discord
 *                   n'est PAS sain, et il faut le redémarrer.
 *   GET /ready    → 200 dès que les commandes sont chargées (démarrage).
 *   GET /metrics  → métriques au format Prometheus (texte).
 *
 * Aucun framework HTTP : trois routes ne justifient pas Express, et une
 * dépendance de moins, c'est une surface d'attaque de moins.
 */

interface Metrics {
  commandsTotal: number;
  commandErrors: number;
  interactionsTotal: number;
  startedAt: number;
}

const metrics: Metrics = {
  commandsTotal: 0,
  commandErrors: 0,
  interactionsTotal: 0,
  startedAt: Date.now(),
};

export function recordCommand(success: boolean): void {
  metrics.commandsTotal += 1;
  if (!success) metrics.commandErrors += 1;
}

export function recordInteraction(): void {
  metrics.interactionsTotal += 1;
}

export function startHealthServer(client: Client): Server | undefined {
  if (env.HTTP_PORT <= 0) return undefined;

  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (url === '/health' || url === '/healthz') {
      void handleHealth(client, response);
      return;
    }

    if (url === '/ready') {
      const ready = getRegistry().commands.size > 0;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready, commands: getRegistry().commands.size }));
      return;
    }

    if (url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(renderMetrics(client));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  server.listen(env.HTTP_PORT, () => {
    log.info({ port: env.HTTP_PORT }, 'serveur de santé démarré');
  });

  return server;
}

async function handleHealth(client: Client, response: import('node:http').ServerResponse): Promise<void> {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  checks.discord = {
    ok: client.isReady() && client.ws.status === 0,
    latencyMs: Math.max(0, Math.round(client.ws.ping)),
  };

  try {
    checks.database = { ok: true, latencyMs: await pingDatabase() };
  } catch (error) {
    checks.database = { ok: false, error: (error as Error).message };
  }

  try {
    checks.redis = { ok: true, latencyMs: await pingRedis() };
  } catch (error) {
    // Redis dégradé n'est pas fatal : le bot fonctionne sans cache.
    checks.redis = { ok: false, error: (error as Error).message };
  }

  const healthy = checks.discord.ok && checks.database.ok;
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1_000),
      checks,
    }),
  );
}

function renderMetrics(client: Client): string {
  const config = getConfig();
  const lines = [
    '# HELP harvester_uptime_seconds Temps depuis le démarrage',
    '# TYPE harvester_uptime_seconds gauge',
    `harvester_uptime_seconds ${Math.round((Date.now() - metrics.startedAt) / 1_000)}`,
    '# HELP harvester_commands_total Commandes exécutées',
    '# TYPE harvester_commands_total counter',
    `harvester_commands_total ${metrics.commandsTotal}`,
    '# HELP harvester_command_errors_total Commandes en erreur',
    '# TYPE harvester_command_errors_total counter',
    `harvester_command_errors_total ${metrics.commandErrors}`,
    '# HELP harvester_interactions_total Interactions traitées',
    '# TYPE harvester_interactions_total counter',
    `harvester_interactions_total ${metrics.interactionsTotal}`,
    '# HELP harvester_guilds Serveurs Discord connectés (ce shard)',
    '# TYPE harvester_guilds gauge',
    `harvester_guilds ${client.guilds.cache.size}`,
    '# HELP harvester_ws_ping_ms Latence WebSocket Discord',
    '# TYPE harvester_ws_ping_ms gauge',
    `harvester_ws_ping_ms ${Math.max(0, Math.round(client.ws.ping))}`,
    '# HELP harvester_config_items Objets chargés en configuration',
    '# TYPE harvester_config_items gauge',
    `harvester_config_items ${config.itemList.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

export { metrics };
