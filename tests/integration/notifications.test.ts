import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client';
import * as systemRepo from '../../src/repositories/system.repo';
import type { PlayerContext } from '../../src/types';
import { createTestPlayer, resetDatabase, resetRedis } from './helpers';

/**
 * FILE DE NOTIFICATIONS — la réservation atomique.
 *
 * La distribution des messages privés est un `setInterval` présent sur CHAQUE
 * shard, hors BullMQ : une simple lecture faisait envoyer le même message par
 * tous les shards à la fois, et un lot plus lent que l'intervalle le faisait
 * repartir au tick suivant du même process. La correction repose entièrement sur
 * des garanties du moteur — `FOR UPDATE SKIP LOCKED` et une colonne de
 * réservation — donc seul un vrai PostgreSQL peut la vérifier.
 */

async function enqueue(userId: string, dedupeKey: string, deliverAt = new Date()): Promise<void> {
  await systemRepo.enqueueNotification({
    userId,
    type: 'admin_message',
    title: 'Test',
    body: 'Test',
    deliverAt,
    dedupeKey,
  });
}

async function ageClaim(dedupeKey: string, minutes: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE notifications SET claimed_at = now() - (${minutes} * interval '1 minute')
         WHERE dedupe_key = ${dedupeKey}`,
  );
}

describe('file de notifications', () => {
  let player: PlayerContext;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    player = await createTestPlayer('destinataire');
  });

  it('deux distributeurs concurrents se partagent la file sans doublon', async () => {
    for (let index = 0; index < 6; index += 1) {
      await enqueue(player.id, `test-${index}`);
    }

    const first = await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0');
    const second = await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-1');

    expect(first).toHaveLength(6);
    // Le second distributeur ne doit RIEN recevoir : tout est déjà réservé.
    expect(second).toHaveLength(0);

    const ids = new Set(first.map((entry) => entry.notification.id));
    expect(ids.size).toBe(6);
  });

  it('respecte la limite demandée et sert les plus anciennes d\'abord', async () => {
    const now = Date.now();
    await enqueue(player.id, 'ancienne', new Date(now - 60_000));
    await enqueue(player.id, 'récente', new Date(now - 1_000));

    const claimed = await systemRepo.claimPendingNotifications(new Date(), 1, 'shard-0');
    expect(claimed).toHaveLength(1);

    const rows = await getDb().execute<{ dedupe_key: string }>(
      sql`SELECT dedupe_key FROM notifications WHERE id = ${claimed[0]!.notification.id}`,
    );
    expect(rows.rows[0]?.dedupe_key).toBe('ancienne');
  });

  it('ne sert pas une notification programmée dans le futur', async () => {
    await enqueue(player.id, 'plus-tard', new Date(Date.now() + 3_600_000));
    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0')).toHaveLength(0);
  });

  it('rend une réservation abandonnée par un process mort', async () => {
    await enqueue(player.id, 'orpheline');
    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0')).toHaveLength(1);
    // Toujours réservée : personne d'autre ne doit la prendre.
    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-1')).toHaveLength(0);

    // Le process qui la tenait est mort il y a dix minutes.
    await ageClaim('orpheline', 10);
    const recovered = await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-1');
    expect(recovered).toHaveLength(1);
  });

  it('une notification relâchée repart immédiatement', async () => {
    await enqueue(player.id, 'relâchée');
    const claimed = await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0');
    await systemRepo.releaseNotificationClaim(claimed[0]!.notification.id);

    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-1')).toHaveLength(1);
  });

  it('une notification livrée ne revient jamais', async () => {
    await enqueue(player.id, 'livrée');
    const claimed = await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0');
    await systemRepo.markNotificationDelivered(claimed[0]!.notification.id);

    await ageClaim('livrée', 10);
    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-1')).toHaveLength(0);
  });

  it('la clé de dédoublonnage empêche le double empilement', async () => {
    expect(await systemRepo.enqueueNotification({
      userId: player.id, type: 'admin_message', title: 'A', body: 'A',
      deliverAt: new Date(), dedupeKey: 'unique',
    })).toBe(true);
    expect(await systemRepo.enqueueNotification({
      userId: player.id, type: 'admin_message', title: 'B', body: 'B',
      deliverAt: new Date(), dedupeKey: 'unique',
    })).toBe(false);

    expect(await systemRepo.claimPendingNotifications(new Date(), 10, 'shard-0')).toHaveLength(1);
  });
});
