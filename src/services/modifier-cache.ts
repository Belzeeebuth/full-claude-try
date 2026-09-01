import { cacheDelete, cacheGet, cacheSet, key as redisKey } from '../db/redis';
import type { FarmModifiers } from '../game/modifiers';

/**
 * Cache des modificateurs de ferme.
 *
 * Vit dans son propre module, et non dans `player.service`, pour une raison
 * précise : les services qui doivent INVALIDER le cache (consommables,
 * bâtiments, élevage) sont aussi ceux que `player.service` utilise. Le loger ici
 * casse le cycle d'imports au lieu de le contourner par des `import()`
 * dynamiques disséminés dans les chemins chauds.
 *
 * Le niveau de coopérative fait partie de la VALEUR, pas de la clé : une seule
 * clé par joueur suffit donc à l'invalidation, et un changement de niveau de
 * coop se comporte comme un défaut de cache plutôt que de laisser une entrée
 * orpheline par niveau.
 */

const TTL_SECONDS = 60;

interface CachedModifiers {
  coopLevel: number;
  modifiers: FarmModifiers;
}

function cacheKey(userId: string): string {
  return redisKey('mods', userId);
}

export async function readCachedModifiers(
  userId: string,
  coopLevel: number,
): Promise<FarmModifiers | undefined> {
  const hit = await cacheGet<CachedModifiers>(cacheKey(userId));
  if (!hit || hit.coopLevel !== coopLevel) return undefined;
  return hit.modifiers;
}

export async function writeCachedModifiers(
  userId: string,
  coopLevel: number,
  modifiers: FarmModifiers,
): Promise<void> {
  await cacheSet(cacheKey(userId), { coopLevel, modifiers }, TTL_SECONDS);
}

/**
 * Invalide les modificateurs d'un joueur.
 *
 * À appeler après toute action qui change ses bonus : construction ou
 * amélioration de bâtiment, achat, vente ou naissance d'un animal, consommation
 * d'un booster. Sans cela, un joueur qui boit une potion attendrait jusqu'à une
 * minute avant qu'elle ne fasse effet — exactement le genre de latence qui fait
 * croire à un bug.
 */
export async function invalidateFarmModifiers(userId: string): Promise<void> {
  await cacheDelete(cacheKey(userId));
}
