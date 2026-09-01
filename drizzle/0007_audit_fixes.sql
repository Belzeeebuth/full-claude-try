-- Correctifs issus de la revue de code du 30/08/2026.
-- Chaque bloc est idempotent : la migration peut être rejouée sans dommage.

-- ---------------------------------------------------------------------------
-- 1. Ancre temporelle du désherbage.
--
-- Le niveau d'herbes est dérivé du temps écoulé depuis `last_harvest_at`.
-- `/weed` remettait `weed_level` à zéro sans déplacer cette origine : la
-- pénalité de rendement revenait intégralement dès la lecture suivante, et une
-- parcelle jamais récoltée était irrécupérable. On amorce la colonne à
-- `last_harvest_at` (ou au déblocage) pour ne pas infliger d'un coup tout
-- l'historique aux parcelles existantes.
-- ---------------------------------------------------------------------------
ALTER TABLE plots ADD COLUMN IF NOT EXISTS last_weeded_at timestamptz;
--> statement-breakpoint
UPDATE plots
   SET last_weeded_at = COALESCE(last_harvest_at, unlocked_at, created_at)
 WHERE last_weeded_at IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Unicité de `discord_id` limitée aux comptes vivants.
--
-- `/admin reset` fait une suppression logique (`deleted_at`), mais l'unique
-- couvrait aussi les comptes supprimés : le `/start` suivant violait la
-- contrainte et le joueur ne pouvait plus jamais rejouer.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS users_discord_id_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_uq
    ON users (discord_id)
 WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Réservation des notifications.
--
-- La distribution des MP est un `setInterval` présent sur CHAQUE shard, non
-- dédoublonné par BullMQ, et la sélection était un `SELECT` nu : tous les
-- shards envoyaient le même message. Ces colonnes permettent une réservation
-- atomique par `FOR UPDATE SKIP LOCKED`.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS claimed_by varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_claimable_idx
    ON notifications (deliver_at)
 WHERE delivered = false;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Achats en boutique, par joueur et par article.
--
-- `per_user_limit` n'était comparé qu'à la quantité d'UN achat : la limite
-- « 1 par joueur » des cosmétiques et du marché noir se contournait en achetant
-- dix fois de suite. Ce compteur la rend réelle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_purchases (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  shop_stock_id uuid NOT NULL REFERENCES shop_stock (id) ON DELETE CASCADE,
  quantity      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_purchases_quantity_positive CHECK (quantity >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS shop_purchases_user_stock_uq
    ON shop_purchases (user_id, shop_stock_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Index de l'audit comptable.
--
-- `findLedgerMismatches` agrégeait toute la table `transactions` chaque heure.
-- La vérification ne porte plus que sur les joueurs actifs récemment ; cet index
-- rend l'agrégation par joueur indexable.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS transactions_user_currency_idx
    ON transactions (user_id, currency);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Parcelles bloquées en `withered`.
--
-- Le prestige ne réinitialisait que l'état `planted` : une parcelle fanée au
-- mauvais moment restait affichée comme libre mais refusée par `plant()`. On
-- répare les fermes déjà touchées (aucune culture associée = parcelle orpheline).
-- ---------------------------------------------------------------------------
UPDATE plots p
   SET state = 'empty', pest_type = NULL, pest_appeared_at = NULL, pest_deadline_at = NULL
 WHERE p.state = 'withered'
   AND NOT EXISTS (SELECT 1 FROM planted_crops c WHERE c.plot_id = p.id);
