-- Rétention du journal comptable par soldes d'ouverture (constat F-15 de l'audit).
--
-- `transactions` est immuable et ne faisait que croître : l'audit horaire
-- comparait `users.coins` à la somme du journal DEPUIS L'ORIGINE, donc aucune
-- ligne ancienne ne pouvait être supprimée sans fausser la vérification. Un
-- checkpoint mensuel fige, par joueur et par monnaie, le solde reconstitué
-- jusqu'à une ligne donnée ; l'invariant devient « solde = ouverture + somme
-- des lignes postérieures » et les lignes couvertes par un checkpoint plus
-- ancien que la rétention deviennent purgeables sans rien perdre de la
-- vérifiabilité.
-- Chaque bloc est idempotent : la migration peut être rejouée sans dommage.

-- ---------------------------------------------------------------------------
-- 1. La table.
--
-- `opening_balance` est toujours dérivé du journal, jamais recopié depuis
-- `users` : c'est une compression du journal, pas une seconde source de
-- vérité. `drift` garde l'écart constaté avec le solde réel au moment du
-- calcul ; un écart non nul sur le dernier checkpoint interdit la purge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  currency             currency NOT NULL,
  period_start         date NOT NULL,
  opening_balance      bigint NOT NULL,
  transactions_through bigint NOT NULL,
  drift                bigint NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_checkpoints_pkey PRIMARY KEY (user_id, currency, period_start),
  CONSTRAINT ledger_checkpoints_through_non_negative CHECK (transactions_through >= 0)
);
--> statement-breakpoint
-- La purge cherche « le dernier checkpoint sous la coupure » : la clé primaire
-- sert la lecture par joueur, cet index sert le filtre par période.
CREATE INDEX IF NOT EXISTS ledger_checkpoints_period_idx
    ON ledger_checkpoints (period_start);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Immuabilité de `transactions` : la purge doit s'ANNONCER.
--
-- Le trigger `transactions_immutable` rejetait tout DELETE, y compris celui de
-- la rétention. On ne le désactive pas (ce serait un `ALTER TABLE` sous verrou
-- exclusif, à chaque nuit) : la fonction laisse passer un DELETE uniquement
-- quand la transaction courante a posé `SET LOCAL harvester.ledger_purge = 'on'`.
-- Un `DELETE` manuel, une cascade ou un script oublié restent refusés ; seul
-- le job de purge, qui sait ce qu'il fait et le journalise, franchit la garde.
-- L'UPDATE reste interdit sans exception : une ligne de journal ne se corrige
-- jamais, elle se compense.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('harvester.ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'La table % est immuable : ni UPDATE ni DELETE ne sont autorisés (opération %).',
    TG_TABLE_NAME, TG_OP
    USING HINT = 'Écrivez une nouvelle ligne compensatoire au lieu de modifier l''historique ; seule la purge de rétention (job maintenance:cleanup) peut supprimer.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transactions_immutable ON transactions;
--> statement-breakpoint
CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Vue `ledger_integrity` : bornée par le dernier checkpoint.
--
-- Après une première purge, la somme depuis l'origine ne vaut plus le solde
-- pour AUCUN joueur purgé : la vue aurait signalé tout le monde. Elle repart
-- désormais du dernier solde d'ouverture, et retombe sur la somme complète pour
-- un joueur sans checkpoint. Mêmes colonnes, mêmes types (`numeric` issu de
-- `SUM`) : `CREATE OR REPLACE` l'exige.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ledger_integrity AS
SELECT
  u.id                                                                   AS user_id,
  u.discord_id,
  u.coins                                                                AS wallet_balance,
  COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0)            AS ledger_balance,
  u.coins - (COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0)) AS drift
FROM users u
LEFT JOIN LATERAL (
  SELECT lc.opening_balance, lc.transactions_through
  FROM ledger_checkpoints lc
  WHERE lc.user_id = u.id AND lc.currency = 'coins'
  ORDER BY lc.period_start DESC
  LIMIT 1
) c ON true
LEFT JOIN transactions t
  ON t.user_id = u.id
 AND t.currency = 'coins'
 AND t.id > COALESCE(c.transactions_through, 0)
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.discord_id, u.coins, c.opening_balance
HAVING u.coins <> COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0);
--> statement-breakpoint
COMMENT ON VIEW ledger_integrity IS
  'Joueurs dont le solde ne correspond pas à leur dernier solde d''ouverture plus les écritures postérieures : doit toujours être vide.';
