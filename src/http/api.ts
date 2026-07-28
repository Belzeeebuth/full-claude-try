import type { IncomingMessage, ServerResponse } from 'node:http';
import { balance as getBalance } from '../config';
import { consumeRate } from '../framework/cooldown';
import * as playerRepo from '../repositories/player.repo';
import * as apiService from '../services/api.service';
import * as coopService from '../services/coop.service';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('api');

/**
 * API publique en lecture seule (v3.2 — roadmap « La plateforme »).
 *
 *   GET /api/v1/me       → profil et statistiques du titulaire de la clé.
 *   GET /api/v1/me/coop  → sa coopérative, si membre (404 sinon).
 *
 * Authentification par `Authorization: Bearer <clé>` (voir `/apikey`),
 * limitation de débit par clé (`balance.api.rateLimitPerMinute`), au même
 * mécanisme `consumeRate()` que les commandes Discord.
 *
 * Documentation destinée aux intégrateurs tiers : docs/07-api-publique.md.
 */

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const balance = getBalance();
  if (!balance.api.enabled) {
    sendJson(response, 503, { error: 'api_disabled' });
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  const token = readBearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: 'missing_api_key' });
    return;
  }

  const auth = await apiService.authenticate(token);
  if (!auth) {
    sendJson(response, 401, { error: 'invalid_api_key' });
    return;
  }

  const rate = await consumeRate(auth.keyId, 'api', balance.api.rateLimitPerMinute, 60);
  if (rate.limited) {
    sendJson(
      response,
      429,
      { error: 'rate_limited', retryAfterMs: rate.resetInMs },
      { 'retry-after': String(Math.max(1, Math.ceil(rate.resetInMs / 1_000))) },
    );
    return;
  }

  const url = new URL(request.url ?? '/', 'http://internal');

  try {
    if (url.pathname === '/api/v1/me') {
      await handleMe(auth.userId, response);
      return;
    }
    if (url.pathname === '/api/v1/me/coop') {
      await handleMeCoop(auth.userId, response);
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    log.error({ err: error }, "erreur de l'API publique");
    sendJson(response, 500, { error: 'internal_error' });
  }
}

async function handleMe(userId: string, response: ServerResponse): Promise<void> {
  const user = await playerRepo.findUserById(userId);
  if (!user) {
    sendJson(response, 404, { error: 'player_not_found' });
    return;
  }

  sendJson(response, 200, {
    discordId: user.discordId,
    username: user.username,
    level: user.level,
    xp: user.xp,
    totalXp: user.totalXp,
    prestige: user.prestige,
    coins: user.coins,
    gems: user.gems,
    title: user.title,
    badges: user.badges,
    stats: {
      totalHarvests: user.totalHarvests,
      totalPlanted: user.totalPlanted,
      totalCoinsEarned: user.totalCoinsEarned,
      totalCoinsSpent: user.totalCoinsSpent,
      totalAnimalsRaised: user.totalAnimalsRaised,
      totalCrafts: user.totalCrafts,
      totalWatered: user.totalWatered,
      totalHelpGiven: user.totalHelpGiven,
      bestHarvestValue: user.bestHarvestValue,
      playtimeSeconds: user.playtimeSeconds,
    },
  });
}

async function handleMeCoop(userId: string, response: ServerResponse): Promise<void> {
  const user = await playerRepo.findUserById(userId);
  if (!user) {
    sendJson(response, 404, { error: 'player_not_found' });
    return;
  }

  const bundle = await playerRepo.loadPlayerBundle(user.discordId);
  if (!bundle?.coop) {
    sendJson(response, 404, { error: 'not_in_a_coop' });
    return;
  }

  const info = await coopService.getCoopInfo(bundle.coop.id, userId);
  sendJson(response, 200, info);
}
