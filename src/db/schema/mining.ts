import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './core';

/**
 * Progression de mine : un seul puits par joueur, la profondeur ne recule
 * jamais. À la différence de la pêche (état de ferrage éphémère, sans valeur
 * d'audit, donc en Redis), c'est une progression DURABLE — elle vit en base.
 */
export const mineProgress = pgTable(
  'mine_progress',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentDepth: integer('current_depth').notNull().default(1),
    deepestReached: integer('deepest_reached').notNull().default(1),
    totalOresMined: bigint('total_ores_mined', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mine_progress_user_id_uq').on(t.userId),
    index('mine_progress_depth_idx').on(t.deepestReached.desc()),
    check('mine_progress_depth_valid', sql`${t.currentDepth} >= 1 AND ${t.deepestReached} >= ${t.currentDepth}`),
    check('mine_progress_ores_non_negative', sql`${t.totalOresMined} >= 0`),
  ],
);
