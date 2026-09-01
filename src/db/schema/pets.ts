import { timestamp, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './core';

/**
 * Compagnons débloqués. Purement déclaratif (« ce joueur a débloqué ce
 * compagnon ») ; lequel est affiché sur `/farm` vit sur `users.equipped_pet_key`.
 * `petKey` n'a pas de clé étrangère : le catalogue (`game/pets.ts`) est un
 * tableau TypeScript, pas une table `*_config` — validé par le service.
 */
export const ownedPets = pgTable(
  'owned_pets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    petKey: varchar('pet_key', { length: 48 }).notNull(),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('owned_pets_user_pet_uq').on(t.userId, t.petKey)],
);
