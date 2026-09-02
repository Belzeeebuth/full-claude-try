import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './core';
import { animalVariantEnum, discoveryKindEnum, qualityEnum } from './enums';

/**
 * Collection du fermier : ce que chaque joueur a déjà obtenu au moins une fois.
 *
 * Une ligne par (joueur, famille, entrée). `entry_key` est une clé de
 * configuration (culture, objet, espèce) ou, pour la famille `variant`,
 * `<espèce>:<variante>` ; pas de clé étrangère parce que les familles
 * pointent vers des tables `*_config` différentes — la validité est garantie
 * par le service, qui ne mappe que des clés issues de `getConfig()`.
 *
 * `count` cumule les unités obtenues (pas les lignes d'inventaire) : c'est le
 * « ×248 » affiché à côté d'une culture. `best_quality` et `best_variant`
 * gardent le meilleur exemplaire vu, comparé par l'ordre des énumérations —
 * c'est pour cela que ces types sont déclarés du plus commun au plus rare.
 */
export const discoveries = pgTable(
  'discoveries',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: discoveryKindEnum('kind').notNull(),
    entryKey: varchar('entry_key', { length: 64 }).notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    count: integer('count').notNull().default(1),
    bestQuality: qualityEnum('best_quality'),
    bestVariant: animalVariantEnum('best_variant'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.entryKey] }),
    // « Combien de joueurs ont déjà vu une poule dorée ? » : statistiques
    // globales et classements futurs par entrée, sans balayer par joueur.
    index('discoveries_kind_entry_idx').on(t.kind, t.entryKey),
    check('discoveries_count_positive', sql`${t.count} > 0`),
  ],
);
