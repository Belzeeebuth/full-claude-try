import type { Executor } from '../db/client';
import { PET_CATALOG, findPet, unlockedPetKeys } from '../game/pets';
import { gameError } from '../utils/errors';
import * as petRepo from '../repositories/pet.repo';
import type { PlayerContext } from '../types';

/**
 * Compagnons de ferme : purement cosmétiques (voir `game/pets.ts`).
 *
 * Déblocage automatique par niveau — pas de commande « réclamer », le
 * compagnon apparaît directement dans `/companion list` dès le niveau
 * atteint, comme un palier de progression plutôt qu'une récompense à
 * encaisser.
 */

export interface PetView {
  key: string;
  emoji: string;
  unlockLevel: number;
  owned: boolean;
  equipped: boolean;
}

export async function listPets(
  player: Pick<PlayerContext, 'id' | 'equippedPetKey'>,
): Promise<PetView[]> {
  const owned = new Set(await petRepo.listOwnedPetKeys(player.id));
  return PET_CATALOG.map((pet) => ({
    key: pet.key,
    emoji: pet.emoji,
    unlockLevel: pet.unlockLevel,
    owned: owned.has(pet.key),
    equipped: player.equippedPetKey === pet.key,
  }));
}

export async function equipPet(player: PlayerContext, petKey: string): Promise<void> {
  const pet = findPet(petKey);
  if (!pet) {
    throw gameError('not_found', 'Unknown companion.', { i18nKey: 'errors.pets.unknown' });
  }
  const owned = await petRepo.isPetOwned(player.id, petKey);
  if (!owned) {
    throw gameError('level_too_low', `Reach level ${pet.unlockLevel} to unlock this companion.`, {
      i18nKey: 'errors.pets.not_unlocked',
      params: { level: pet.unlockLevel },
    });
  }
  await petRepo.setEquippedPet(player.id, petKey);
}

export async function unequipPet(player: PlayerContext): Promise<void> {
  await petRepo.setEquippedPet(player.id, null);
}

/**
 * Débloque les compagnons nouvellement atteints par le niveau. Appelé depuis
 * `grantXp()` (montée de niveau) et la création de compte (compagnon de
 * niveau 1). Idempotent grâce à `onConflictDoNothing` côté dépôt : pas besoin
 * de savoir précisément quels paliers ont été franchis.
 */
export async function unlockPetsForLevel(
  userId: string,
  level: number,
  tx: Executor,
): Promise<string[]> {
  const owned = new Set(await petRepo.listOwnedPetKeys(userId, tx));
  const newlyUnlocked: string[] = [];
  for (const key of unlockedPetKeys(level)) {
    if (!owned.has(key)) {
      await petRepo.unlockPet(userId, key, tx);
      newlyUnlocked.push(key);
    }
  }
  return newlyUnlocked;
}
