import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { balance as getBalance } from '../config';
import { env } from '../config/env';
import { consumeRate } from '../framework/cooldown';
import * as playerRepo from '../repositories/player.repo';
import * as apiService from '../services/api.service';
import * as coopService from '../services/coop.service';
import * as miscService from '../services/misc.service';
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

/** Corps JSON d'une requête entrante, plafonné pour ne pas servir de puits mémoire. */
async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 16_384,
): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Comparaison à temps constant : une égalité naïve fuit le secret octet par octet. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook de vote top.gg.
 *
 * Toute la boucle manquait : `/vote` affichait un lien et un montant, mais rien
 * ne créditait jamais, `TOPGG_WEBHOOK_SECRET` n'était lu nulle part et la voie
 * premium du passe restait inatteignable. top.gg authentifie ses appels par un
 * secret partagé dans l'en-tête `Authorization`, et relivre en cas de réponse
 * lente — d'où l'idempotence côté service.
 */
async function handleTopggWebhook(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!env.TOPGG_WEBHOOK_SECRET) {
    sendJson(response, 503, { error: 'topgg_not_configured' });
    return;
  }
  if (!secretMatches(request.headers.authorization, env.TOPGG_WEBHOOK_SECRET)) {
    log.warn({ ip: request.socket.remoteAddress }, 'webhook top.gg : secret invalide');
    sendJson(response, 401, { error: 'invalid_signature' });
    return;
  }

  const body = (await readJsonBody(request)) as
    | { user?: string; type?: string; isWeekend?: boolean }
    | undefined;
  if (!body?.user || !/^\d{15,20}$/.test(body.user)) {
    sendJson(response, 400, { error: 'invalid_payload' });
    return;
  }

  // Le bouton « tester » de top.gg envoie `type: 'test'` : on acquitte sans payer.
  if (body.type === 'test') {
    sendJson(response, 200, { ok: true, test: true });
    return;
  }

  const result = await miscService.recordVote(body.user, {
    weekend: body.isWeekend === true,
    // top.gg ne fournit pas d'identifiant de vote : la fenêtre d'idempotence du
    // service retombe alors sur (joueur, jour), ce qui suffit à absorber les
    // relivraisons sans jamais bloquer un vote légitime du lendemain.
  });

  // On acquitte même quand le joueur n'a pas de compte ou a déjà été payé :
  // un 4xx ferait réessayer top.gg en boucle pour rien.
  sendJson(response, 200, { ok: true, rewarded: result !== null });
}

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://internal');

  // Le webhook top.gg précède l'authentification par clé : il porte la sienne.
  if (url.pathname === '/api/v1/topgg') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    try {
      await handleTopggWebhook(request, response);
    } catch (error) {
      log.error({ err: error }, 'webhook top.gg en échec');
      sendJson(response, 500, { error: 'internal_error' });
    }
    return;
  }

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
