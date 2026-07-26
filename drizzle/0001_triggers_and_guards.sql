-- ============================================================================
--  0001 — Déclencheurs, garde-fous et index avancés
--  Écrit à la main : ces objets ne sont pas exprimables dans le schéma ORM.
--  Appliqué par `npm run db:migrate` (voir src/scripts/migrate.ts).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. `updated_at` automatique
--    Toutes les tables métier portent `updated_at`. Le laisser à la charge de
--    l'application, c'est garantir qu'un UPDATE oublié quelque part produira une
--    donnée à l'horodatage faux. Un déclencheur rend l'oubli impossible.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'users', 'settings', 'farms', 'plots', 'bank_accounts', 'daily_streaks', 'cooldowns',
    'planted_crops', 'owned_buildings', 'owned_animals', 'inventory', 'crafting_queue',
    'market_prices', 'shop_stock', 'auction_listings', 'trades',
    'user_quests', 'user_achievements', 'user_season_pass', 'user_events',
    'guilds', 'guild_members', 'guild_objectives', 'guild_settings', 'scheduled_tasks',
    'crops_config', 'animals_config', 'buildings_config', 'items_config',
    'recipes_config', 'quests_config', 'achievements_config', 'events_config', 'season_pass'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I', target, target);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target, target
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 2. Journaux IMMUABLES
--    `transactions`, `audit_logs` et `guild_treasury_log` sont la comptabilité
--    et la traçabilité du jeu. Autoriser un UPDATE ou un DELETE, même pour un
--    administrateur, retirerait toute valeur probante à ces tables : on ne
--    pourrait plus affirmer « la somme du journal égale le solde ».
--    PostgreSQL refuse donc la modification au niveau du moteur.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La table % est immuable : ni UPDATE ni DELETE ne sont autorisés (opération %).',
    TG_TABLE_NAME, TG_OP
    USING HINT = 'Écrivez une nouvelle ligne compensatoire au lieu de modifier l''historique.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS transactions_immutable ON transactions;
--> statement-breakpoint
CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
--> statement-breakpoint
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS guild_treasury_log_immutable ON guild_treasury_log;
--> statement-breakpoint
CREATE TRIGGER guild_treasury_log_immutable
  BEFORE UPDATE OR DELETE ON guild_treasury_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- La suppression d'un joueur (RGPD) doit rester possible : les journaux liés
-- sont alors anonymisés plutôt que supprimés. `ON DELETE CASCADE` entrerait en
-- conflit avec l'immuabilité, on remplace donc par une mise à NULL contrôlée.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE transactions
  ADD CONSTRAINT transactions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 3. Index avancés (partiels et fonctionnels)
--    Drizzle génère les index simples ; ceux-ci ciblent les requêtes chaudes.
-- ----------------------------------------------------------------------------

-- Cultures prêtes à récolter : le job de notification ne lit que celles-là.
CREATE INDEX IF NOT EXISTS planted_crops_ready_partial_idx
  ON planted_crops (ready_at)
  WHERE withered = false;
--> statement-breakpoint

-- Annonces actives uniquement : 95 % des annonces sont clôturées.
CREATE INDEX IF NOT EXISTS auction_active_partial_idx
  ON auction_listings (expires_at, item_key)
  WHERE status = 'active';
--> statement-breakpoint

-- Notifications en attente : la file est courte, la table longue.
CREATE INDEX IF NOT EXISTS notifications_pending_partial_idx
  ON notifications (deliver_at)
  WHERE delivered = false;
--> statement-breakpoint

-- Quêtes actives d'un joueur : la table grossit de 7 lignes/joueur/jour.
CREATE INDEX IF NOT EXISTS user_quests_active_partial_idx
  ON user_quests (user_id, type)
  WHERE status IN ('active', 'completed');
--> statement-breakpoint

-- Recherche de quête par type d'objectif (JSONB) : utilisé à chaque action.
CREATE INDEX IF NOT EXISTS user_quests_objective_idx
  ON user_quests ((snapshot ->> 'objectiveType'))
  WHERE status = 'active';
--> statement-breakpoint

-- Recherche d'animaux à produire.
CREATE INDEX IF NOT EXISTS owned_animals_ready_partial_idx
  ON owned_animals (production_ready_at)
  WHERE is_alive = true;
--> statement-breakpoint

-- Inventaire non vide seulement.
CREATE INDEX IF NOT EXISTS inventory_positive_partial_idx
  ON inventory (user_id, item_key)
  WHERE quantity > 0;
--> statement-breakpoint

-- Classements : index couvrants pour éviter la lecture de la table.
CREATE INDEX IF NOT EXISTS users_leaderboard_wealth_idx
  ON users (coins DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS users_leaderboard_xp_idx
  ON users (total_xp DESC, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 4. Garde-fous économiques supplémentaires
-- ----------------------------------------------------------------------------

-- Un joueur ne peut pas être son propre parrain (déjà en CHECK), ni créer une
-- boucle de parrainage directe.
CREATE OR REPLACE FUNCTION reject_referral_loop() RETURNS trigger AS $$
DECLARE
  parent uuid;
BEGIN
  IF NEW.referred_by IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT referred_by INTO parent FROM users WHERE id = NEW.referred_by;
  IF parent = NEW.id THEN
    RAISE EXCEPTION 'Boucle de parrainage détectée entre % et %', NEW.id, NEW.referred_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS users_referral_loop_guard ON users;
--> statement-breakpoint
CREATE TRIGGER users_referral_loop_guard
  BEFORE INSERT OR UPDATE OF referred_by ON users
  FOR EACH ROW EXECUTE FUNCTION reject_referral_loop();
--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- 5. Vue de contrôle : écart entre solde et journal comptable
--    Interrogée par le job `economy:snapshot` et par `/admin stats`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW ledger_integrity AS
SELECT
  u.id                                   AS user_id,
  u.discord_id,
  u.coins                                AS wallet_balance,
  COALESCE(SUM(t.amount), 0)             AS ledger_balance,
  u.coins - COALESCE(SUM(t.amount), 0)   AS drift
FROM users u
LEFT JOIN transactions t
  ON t.user_id = u.id AND t.currency = 'coins'
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.discord_id, u.coins
HAVING u.coins <> COALESCE(SUM(t.amount), 0);
--> statement-breakpoint

COMMENT ON VIEW ledger_integrity IS
  'Joueurs dont le solde ne correspond pas à la somme de leur journal : doit toujours être vide.';
