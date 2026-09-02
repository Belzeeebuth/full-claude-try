import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import {
  apiKeys,
  auctionListings,
  farms,
  inventory,
  mineProgress,
  notifications,
  ownedAnimals,
  ownedPets,
  settings,
  standingOrders,
  trades,
  userAchievements,
  userQuests,
  userSeasonPass,
  users,
  webhookSubscriptions,
} from '../db/schema';

/**
 * Export et suppression de compte à l'initiative du joueur (RGPD).
 *
 * Les lectures propres à l'export vivent ici plutôt que dans les repositories
 * de domaine : elles n'ont aucun autre appelant, et elles portent des bornes
 * (`LIMIT`) qui n'auraient aucun sens pour le gameplay — un export doit tenir
 * dans une pièce jointe Discord, une vue de ferme non.
 *
 * Les écritures de suppression sont toutes conditionnées par `user_id` et
 * renvoient le nombre de lignes touchées : c'est ce que le service journalise
 * dans l'audit, pour qu'une demande d'effacement soit vérifiable après coup.
 */

export type InventoryRow = typeof inventory.$inferSelect;
export type UserQuestRow = typeof userQuests.$inferSelect;
export type UserAchievementRow = typeof userAchievements.$inferSelect;
export type UserSeasonPassRow = typeof userSeasonPass.$inferSelect;
export type OwnedPetRow = typeof ownedPets.$inferSelect;
export type MineProgressRow = typeof mineProgress.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;

// ---------------------------------------------------------------------------
// Lectures de l'export
// ---------------------------------------------------------------------------

export async function listInventoryRows(
  userId: string,
  limit: number,
  executor: Executor = getDb(),
): Promise<InventoryRow[]> {
  return executor
    .select()
    .from(inventory)
    .where(and(eq(inventory.userId, userId), gt(inventory.quantity, 0)))
    .orderBy(asc(inventory.itemKey), asc(inventory.quality), asc(inventory.mutation))
    .limit(limit);
}

export async function listQuestRows(
  userId: string,
  limit: number,
  executor: Executor = getDb(),
): Promise<UserQuestRow[]> {
  return executor
    .select()
    .from(userQuests)
    .where(eq(userQuests.userId, userId))
    .orderBy(desc(userQuests.assignedAt))
    .limit(limit);
}

export async function listAchievementRows(
  userId: string,
  limit: number,
  executor: Executor = getDb(),
): Promise<UserAchievementRow[]> {
  return executor
    .select()
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId))
    .orderBy(asc(userAchievements.achievementKey))
    .limit(limit);
}

export async function listSeasonPassRows(
  userId: string,
  executor: Executor = getDb(),
): Promise<UserSeasonPassRow[]> {
  return executor
    .select()
    .from(userSeasonPass)
    .where(eq(userSeasonPass.userId, userId))
    .orderBy(asc(userSeasonPass.seasonPassId));
}

export async function listOwnedPetRows(
  userId: string,
  executor: Executor = getDb(),
): Promise<OwnedPetRow[]> {
  return executor
    .select()
    .from(ownedPets)
    .where(eq(ownedPets.userId, userId))
    .orderBy(asc(ownedPets.unlockedAt));
}

export async function getMineProgress(
  userId: string,
  executor: Executor = getDb(),
): Promise<MineProgressRow | undefined> {
  const [row] = await executor
    .select()
    .from(mineProgress)
    .where(eq(mineProgress.userId, userId))
    .limit(1);
  return row;
}

/** Révoquées comprises : l'export doit montrer tout ce qui a existé, pas seulement ce qui sert encore. */
export async function listApiKeysIncludingRevoked(
  userId: string,
  executor: Executor = getDb(),
): Promise<ApiKeyRow[]> {
  return executor
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

// ---------------------------------------------------------------------------
// Contrôles préalables à la suppression
// ---------------------------------------------------------------------------

/**
 * Annonces encore en vie à l'hôtel des ventes.
 *
 * Le filtre sur `expires_at` n'est pas cosmétique : une annonce échue mais pas
 * encore clôturée par le job (cinq minutes au pire) ne peut plus être annulée
 * par le joueur — la compter le bloquerait sur quelque chose qu'il ne peut pas
 * régler.
 */
export async function countActiveListings(
  userId: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(auctionListings)
    .where(
      and(
        eq(auctionListings.sellerId, userId),
        eq(auctionListings.status, 'active'),
        gt(auctionListings.expiresAt, now),
      ),
    );
  return row?.count ?? 0;
}

/** Échanges directs ouverts où le joueur est l'une des deux parties. Même logique d'échéance que les annonces. */
export async function countPendingTrades(
  userId: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(trades)
    .where(
      and(
        eq(trades.status, 'pending'),
        gt(trades.expiresAt, now),
        sql`(${trades.initiatorId} = ${userId} OR ${trades.partnerId} = ${userId})`,
      ),
    );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Écritures de la suppression
// ---------------------------------------------------------------------------

/**
 * Suppression logique et anonymisation de la ligne `users`.
 *
 * `discord_id` est conservé : l'index unique est partiel (`WHERE deleted_at IS
 * NULL`), donc un `/start` ultérieur recrée un compte neuf, et le journal
 * comptable reste rattaché à une ligne existante. Le `WHERE deleted_at IS NULL`
 * rend l'opération idempotente : un second clic ne touche rien et renvoie
 * `false`, ce qui permet au service de répondre « déjà supprimé » plutôt que de
 * ré-auditer une suppression.
 */
export async function anonymizeUser(
  userId: string,
  username: string,
  now: Date,
  executor: Executor,
): Promise<boolean> {
  const result = await executor
    .update(users)
    .set({
      username,
      displayName: null,
      avatarHash: null,
      lastGuildId: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Réaffirme l'anonymisation sur une ligne DÉJÀ supprimée.
 *
 * Le pipeline d'interaction lance `touchUser` (pseudo, nom d'affichage, avatar
 * lus sur Discord) sans l'attendre, juste avant d'exécuter le bouton de
 * confirmation — et sans filtrer `deleted_at`. Si cet UPDATE attend le verrou
 * de ligne pris par la transaction de suppression, il s'applique juste après
 * son commit et ré-identifie la ligne. Rejoué après le commit, cet ordre passe
 * derrière lui (PostgreSQL sert les verrous en attente dans l'ordre d'arrivée)
 * et remet la ligne dans l'état voulu.
 */
export async function reassertAnonymization(
  userId: string,
  username: string,
  executor: Executor = getDb(),
): Promise<void> {
  await executor
    .update(users)
    .set({ username, displayName: null, avatarHash: null, lastGuildId: null })
    .where(and(eq(users.id, userId), sql`${users.deletedAt} IS NOT NULL`));
}

/**
 * Réglages ramenés à un état muet : plus aucune notification, ferme privée,
 * ni visites ni échanges. Ce n'est pas la valeur par défaut d'un compte neuf
 * (qui accepte visites et échanges) — un compte supprimé ne doit plus être
 * contacté ni exposé, même par les jobs qui liraient encore ses réglages.
 */
export async function neutralizeSettings(
  userId: string,
  now: Date,
  executor: Executor,
): Promise<void> {
  await executor
    .update(settings)
    .set({
      dmNotifications: false,
      notifyCrops: false,
      notifyAnimals: false,
      notifyEnergy: false,
      notifyMarket: false,
      notifyCoop: false,
      dailyReminder: false,
      locale: 'fr',
      timezone: 'Europe/Paris',
      theme: 'classic',
      privacy: 'private',
      compactMode: false,
      confirmDestructive: true,
      allowVisits: false,
      allowTrades: false,
      updatedAt: now,
    })
    .where(eq(settings.userId, userId));
}

/** Le nom de ferme est un texte libre saisi par le joueur : il retombe sur la valeur par défaut de la colonne. */
export async function resetFarmIdentity(
  userId: string,
  now: Date,
  executor: Executor,
): Promise<void> {
  await executor
    .update(farms)
    .set({ name: sql`DEFAULT`, deletedAt: now, updatedAt: now })
    .where(eq(farms.userId, userId));
}

/** Surnoms d'animaux : même raison que le nom de ferme, c'est du texte libre. */
export async function clearAnimalNicknames(userId: string, executor: Executor): Promise<number> {
  const result = await executor
    .update(ownedAnimals)
    .set({ nickname: null })
    .where(and(eq(ownedAnimals.userId, userId), sql`${ownedAnimals.nickname} IS NOT NULL`));
  return result.rowCount ?? 0;
}

export async function revokeAllApiKeys(
  userId: string,
  now: Date,
  executor: Executor,
): Promise<number> {
  const result = await executor
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  return result.rowCount ?? 0;
}

/** Les évènements en file partent en cascade avec l'abonnement (clé étrangère `ON DELETE CASCADE`). */
export async function deleteAllWebhooks(userId: string, executor: Executor): Promise<number> {
  const result = await executor
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.userId, userId));
  return result.rowCount ?? 0;
}

export async function cancelAllStandingOrders(
  userId: string,
  now: Date,
  executor: Executor,
): Promise<number> {
  const result = await executor
    .update(standingOrders)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(and(eq(standingOrders.buyerId, userId), eq(standingOrders.status, 'active')));
  return result.rowCount ?? 0;
}

/**
 * Notifications non encore livrées : sans cette purge, le worker de MP
 * enverrait encore « votre culture est prête » à quelqu'un qui vient de
 * demander qu'on ne le contacte plus. Les livrées restent (historique).
 */
export async function deletePendingNotifications(
  userId: string,
  executor: Executor,
): Promise<number> {
  const result = await executor
    .delete(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.delivered, false)));
  return result.rowCount ?? 0;
}
