import { createHash, randomBytes } from 'node:crypto';
import { balance as getBalance } from '../config';
import { gameError } from '../utils/errors';
import * as apiRepo from '../repositories/api.repo';
import * as playerRepo from '../repositories/player.repo';
import type { PlayerContext } from '../types';

/**
 * Clés d'API personnelles (v3.2 — API publique).
 *
 * Le jeton brut n'existe que le temps de la réponse à `/apikey create` : au-delà,
 * seul son hachage SHA-256 est consultable, exactement comme un mot de passe.
 * SHA-256 simple (pas de KDF lent type bcrypt/scrypt) est approprié ici parce que
 * le jeton est un secret à haute entropie généré par nos soins, pas un mot de
 * passe choisi par un humain — il n'y a pas d'attaque par dictionnaire à
 * ralentir.
 */

function generateRawKey(): string {
  return `hvst_${randomBytes(24).toString('hex')}`;
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface CreatedApiKey {
  rawKey: string;
  keyPrefix: string;
  label: string;
}

export async function createApiKey(player: PlayerContext, label = 'default'): Promise<CreatedApiKey> {
  const balance = getBalance();
  if (!balance.api.enabled) {
    throw gameError('forbidden', 'The public API is currently disabled.', {
      i18nKey: 'errors.api.disabled',
    });
  }

  const existing = await apiRepo.countActiveKeys(player.id);
  if (existing >= balance.api.maxKeysPerUser) {
    throw gameError(
      'forbidden',
      `You can have at most ${balance.api.maxKeysPerUser} active API keys.`,
      { i18nKey: 'errors.api.too_many_keys', params: { max: balance.api.maxKeysPerUser } },
    );
  }

  const rawKey = generateRawKey();
  await apiRepo.insertApiKey({
    userId: player.id,
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, 12),
    label: label.slice(0, 48),
  });

  return { rawKey, keyPrefix: rawKey.slice(0, 12), label };
}

export async function listApiKeys(player: PlayerContext) {
  return apiRepo.listActiveKeys(player.id);
}

export async function revokeApiKey(player: PlayerContext, keyPrefix: string): Promise<void> {
  const revoked = await apiRepo.revokeByPrefix(player.id, keyPrefix);
  if (!revoked) {
    throw gameError('not_found', 'No active key with that prefix.', {
      i18nKey: 'errors.api.key_not_found',
    });
  }
}

/** Résout un jeton brut reçu dans `Authorization: Bearer <key>`. `undefined` si invalide/révoqué. */
export async function authenticate(rawKey: string): Promise<{ keyId: string; userId: string } | undefined> {
  if (!rawKey.startsWith('hvst_')) return undefined;
  const row = await apiRepo.findActiveByHash(hashKey(rawKey));
  if (!row) return undefined;

  await apiRepo.touchLastUsed(row.id);
  return { keyId: row.id, userId: row.userId };
}

/** Charge le joueur associé à une clé authentifiée, pour construire les réponses de l'API. */
export async function loadAuthenticatedPlayer(userId: string) {
  return playerRepo.findUserById(userId);
}
