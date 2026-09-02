import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client';
import { transactions } from '../db/schema';

/**
 * Almanach : lecture du grand livre, aucune règle de jeu.
 *
 * L'almanach n'a pas de table : l'achat d'une prévision est une ligne
 * `transactions` (`shop_purchase` / `almanac`, `metadata.day`), et la
 * prévision elle-même se recalcule (tirage déterministe). Ce dépôt ne sert
 * qu'à retrouver cette ligne quand le cache Redis l'a oubliée.
 */

/**
 * Identifiant d'objet porté par la ligne d'achat d'une prévision.
 *
 * Attention : ce n'est PAS une clé de catalogue. La prévision n'est ni un
 * objet d'`items.json`, ni un animal, ni un bâtiment — elle n'entre jamais en
 * inventaire, seule la ligne du grand livre atteste l'achat. Toute lecture qui
 * traduit un `item_key` en libellé (aujourd'hui `resolveItemLabel`, côté
 * `/history`) doit donc traiter cette clé explicitement : sans cela elle
 * retombe sur son repli « clé inconnue » et affiche l'identifiant interne,
 * identique en fr et en, au lieu d'un nom lisible.
 */
export const ALMANAC_ITEM_KEY = 'almanac';

/**
 * Achat de la prévision d'un jour donné, s'il existe.
 *
 * `since` borne la recherche par la date : une prévision pour le jour J ne
 * peut avoir été achetée que pendant J-1, et l'index `(user_id, created_at)`
 * rend alors la requête indépendante de la taille de l'historique du joueur.
 * Le filtre JSONB passe par un paramètre lié, jamais par interpolation.
 */
export async function findForecastPurchase(
  userId: string,
  day: string,
  since: Date,
  executor: Executor = getDb(),
): Promise<{ id: number; createdAt: Date } | undefined> {
  const [row] = await executor
    .select({ id: transactions.id, createdAt: transactions.createdAt })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.type, 'shop_purchase'),
        eq(transactions.itemKey, ALMANAC_ITEM_KEY),
        gte(transactions.createdAt, since),
        sql`${transactions.metadata} ->> 'day' = ${day}`,
      ),
    )
    .limit(1);
  return row;
}
