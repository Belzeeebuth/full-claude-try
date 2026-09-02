import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './core';
import { currencyEnum } from './enums';

/**
 * Soldes d'ouverture du journal comptable — ce qui rend `transactions` PURGEABLE.
 *
 * Le journal est immuable et ne faisait que croître : l'audit horaire comparait
 * `users.coins` à `SUM(amount)` DEPUIS L'ORIGINE, si bien qu'aucune ligne
 * ancienne ne pouvait disparaître sans fausser la vérification. Un checkpoint
 * fige, par joueur et par monnaie, le solde reconstitué à partir du journal
 * jusqu'à une ligne donnée (`transactions_through`). L'invariant « solde =
 * somme des écritures » devient « solde = ouverture + somme des écritures
 * postérieures à l'ouverture » : il reste vérifiable à tout instant, y compris
 * pendant et après une purge, et les lignes couvertes par un checkpoint plus
 * ancien que la rétention peuvent être supprimées.
 *
 * `opening_balance` est TOUJOURS dérivé du journal (checkpoint précédent +
 * somme des lignes intermédiaires), jamais copié depuis `users.coins` : c'est
 * ce qui en fait une compression du journal et non une seconde source de
 * vérité. `drift` mémorise l'écart constaté avec le solde réel au moment du
 * calcul, sous verrou de la ligne joueur — zéro dans tous les cas sains ; un
 * écart bloque la purge du joueur concerné tant qu'un checkpoint plus récent
 * n'est pas revenu à zéro.
 */
export const ledgerCheckpoints = pgTable(
  'ledger_checkpoints',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currency: currencyEnum('currency').notNull(),
    /** Premier jour de la période que ce solde ouvre (`yyyy-MM-dd`, UTC). */
    periodStart: date('period_start').notNull(),
    /** Solde reconstitué depuis le journal, jusqu'à `transactions_through` inclus. */
    openingBalance: bigint('opening_balance', { mode: 'number' }).notNull(),
    /** Identifiant de la dernière ligne `transactions` incluse ; 0 = aucune. */
    transactionsThrough: bigint('transactions_through', { mode: 'number' }).notNull(),
    /** `users.<currency>` − `opening_balance` au moment du calcul, sous verrou. */
    drift: bigint('drift', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.currency, t.periodStart] }),
    index('ledger_checkpoints_period_idx').on(t.periodStart),
    check('ledger_checkpoints_through_non_negative', sql`${t.transactionsThrough} >= 0`),
  ],
);
