import { createHmac, randomBytes } from 'node:crypto';
import { balance as getBalance } from '../config';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as webhookRepo from '../repositories/webhook.repo';
import type { PlayerContext } from '../types';

const log = moduleLogger('webhook');

/**
 * Webhooks sortants (v3.2 — API publique).
 *
 * Le déclenchement d'un évènement de jeu (`enqueueEvent`) se contente d'écrire
 * une ligne en base, dans la MÊME transaction que l'action qui le cause : un
 * appel HTTP sortant vers un serveur tiers ne doit jamais faire échouer ni
 * ralentir une récolte ou la clôture d'une enchère. La livraison réelle est
 * un travail séparé (`dispatchPending`, appelé par le job planifié
 * `webhooks:dispatch`), une tentative unique par évènement — pas de reprise
 * avec attente exponentielle, la fiabilité vient plutôt de la désactivation
 * automatique d'un abonnement qui échoue en boucle (`webhookMaxFailures`).
 */

export const WEBHOOK_EVENT_TYPES = ['crop_ready', 'auction_won'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

function generateSecret(): string {
  return randomBytes(24).toString('hex');
}

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function isValidWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function subscribe(
  player: PlayerContext,
  url: string,
  events: string[],
): Promise<{ id: string; secret: string }> {
  const balance = getBalance();
  if (!balance.api.enabled) {
    throw gameError('forbidden', 'The public API is currently disabled.', {
      i18nKey: 'errors.api.disabled',
    });
  }

  if (!isValidWebhookUrl(url) || url.length > 500) {
    throw gameError('target_invalid', 'Invalid webhook URL.', { i18nKey: 'errors.webhook.invalid_url' });
  }
  const uniqueEvents = [...new Set(events)];
  if (uniqueEvents.length === 0 || uniqueEvents.some((event) => !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType))) {
    throw gameError('target_invalid', 'Unknown event type.', {
      i18nKey: 'errors.webhook.invalid_event',
      params: { events: WEBHOOK_EVENT_TYPES.join(', ') },
    });
  }

  const existing = await webhookRepo.countSubscriptions(player.id);
  if (existing >= balance.api.maxWebhooksPerUser) {
    throw gameError(
      'forbidden',
      `You can have at most ${balance.api.maxWebhooksPerUser} webhooks.`,
      { i18nKey: 'errors.webhook.too_many', params: { max: balance.api.maxWebhooksPerUser } },
    );
  }

  const secret = generateSecret();
  const row = await webhookRepo.insertSubscription({
    userId: player.id,
    url,
    secret,
    events: uniqueEvents,
  });
  return { id: row.id, secret };
}

export async function listSubscriptions(player: PlayerContext) {
  return webhookRepo.listSubscriptions(player.id);
}

export async function unsubscribe(player: PlayerContext, id: string): Promise<void> {
  const removed = await webhookRepo.deleteSubscription(player.id, id);
  if (!removed) {
    throw gameError('not_found', 'Webhook not found.', { i18nKey: 'errors.webhook.not_found' });
  }
}

interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  error?: string;
}

async function deliver(url: string, secret: string, eventType: string, payload: unknown): Promise<DeliveryOutcome> {
  const balance = getBalance();
  const body = JSON.stringify({ event: eventType, data: payload, sentAt: new Date().toISOString() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), balance.api.webhookTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-harvester-event': eventType,
        'x-harvester-signature': signPayload(secret, body),
      },
      body,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

/** Envoi immédiat, hors file, pour que le joueur vérifie son point de terminaison. */
export async function sendTestPing(player: PlayerContext, id: string): Promise<DeliveryOutcome> {
  const subscription = await webhookRepo.findSubscription(player.id, id);
  if (!subscription) {
    throw gameError('not_found', 'Webhook not found.', { i18nKey: 'errors.webhook.not_found' });
  }
  return deliver(subscription.url, subscription.secret, 'ping', { message: 'Test delivery from Harvester.' });
}

/** Met en file un évènement pour chaque abonnement actif du joueur qui l'écoute. */
export async function enqueueEvent(
  userId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const subscriptions = await webhookRepo.findEnabledSubscriptionsForEvent(userId, eventType);
  for (const subscription of subscriptions) {
    await webhookRepo.enqueueEvent({ subscriptionId: subscription.id, eventType, payload });
  }
}

/** Appelé par le job planifié `webhooks:dispatch`. Une tentative par évènement en attente. */
export async function dispatchPending(limit: number): Promise<{ delivered: number; failed: number }> {
  const balance = getBalance();
  const pending = await webhookRepo.claimPendingEvents(limit);
  let delivered = 0;
  let failed = 0;

  for (const { event, subscription } of pending) {
    if (!subscription.enabled) {
      await webhookRepo.markEventFailed(event.id, 'subscription disabled');
      failed += 1;
      continue;
    }

    const outcome = await deliver(subscription.url, subscription.secret, event.eventType, event.payload);
    const { consecutiveFailures } = await webhookRepo.recordDeliveryOutcome(subscription.id, outcome.ok);

    if (outcome.ok) {
      await webhookRepo.markEventDelivered(event.id);
      delivered += 1;
    } else {
      await webhookRepo.markEventFailed(event.id, outcome.error ?? `HTTP ${outcome.status}`);
      failed += 1;
      if (consecutiveFailures >= balance.api.webhookMaxFailures) {
        await webhookRepo.disableSubscription(subscription.id);
        log.warn(
          { subscriptionId: subscription.id, consecutiveFailures },
          'webhook désactivé après trop d\'échecs consécutifs',
        );
      }
    }
  }

  return { delivered, failed };
}
