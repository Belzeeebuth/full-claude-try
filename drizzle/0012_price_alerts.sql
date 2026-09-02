-- Alertes de prix (proposition E-02) : le pendant VENDEUR des ordres d'achat
-- permanents. Un ordre (`/order`) achète tout seul quand une annonce passe sous
-- un prix ; une alerte (`/alert`) prévient le joueur quand le marché dynamique
-- franchit un seuil, pour qu'il vende au bon moment sans taper `/market` en
-- boucle. Elle ne crée ni ne détruit aucun objet — c'est ce qui la rend
-- acceptable là où un vrai « côté achat » du marché ouvrirait un puits d'objets.
-- Chaque bloc est idempotent : la migration peut être rejouée sans dommage.

-- ---------------------------------------------------------------------------
-- 1. Types énumérés.
--
-- PostgreSQL n'offre pas de `CREATE TYPE IF NOT EXISTS` : on attrape
-- `duplicate_object` pour rester rejouable, comme le reste du fichier.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE price_alert_direction AS ENUM ('above', 'below');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE price_alert_status AS ENUM ('active', 'triggered', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. La table.
--
-- `item_key` suit `items_config` en cascade comme `market_prices` : renommer un
-- objet dans la configuration ne doit pas orpheliner les alertes posées dessus.
-- `triggered_price` mémorise le prix qui a fait partir l'alerte : c'est ce que
-- le joueur relira dans son historique, pas le prix courant au moment où il
-- ouvre le message.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_alerts (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_key        varchar(48) NOT NULL REFERENCES items_config (key) ON UPDATE CASCADE,
  direction       price_alert_direction NOT NULL,
  threshold       bigint NOT NULL,
  status          price_alert_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  triggered_at    timestamptz,
  triggered_price bigint,
  CONSTRAINT price_alerts_threshold_positive CHECK (threshold > 0)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Index.
--
-- (status, item_key) : l'évaluation horaire ne lit que les alertes actives, et
-- la purge ne touche que celles-là. (user_id, status) : `/alert list`, le
-- plafond par joueur et la résolution d'un identifiant court, toujours
-- restreinte au propriétaire.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS price_alerts_status_item_idx
    ON price_alerts (status, item_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS price_alerts_user_status_idx
    ON price_alerts (user_id, status);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Nouveau type de notification.
--
-- Non bloquant depuis PostgreSQL 12 ; la valeur n'est utilisée par aucune
-- instruction de cette même transaction, ce qui est la seule restriction.
-- ---------------------------------------------------------------------------
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'price_alert';
