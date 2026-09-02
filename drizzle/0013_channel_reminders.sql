-- Rappels dans un salon du serveur (proposition E-03).
--
-- Toutes les notifications partaient en message privé, et beaucoup de joueurs
-- ferment leurs MP : l'erreur 50007 coupait alors `dm_notifications` en silence
-- et les rappels devenaient muets pour eux. Ces colonnes portent le DOUBLE
-- opt-in nécessaire pour mentionner quelqu'un publiquement sans nuisance :
-- le serveur désigne un salon, le joueur accepte d'y être mentionné.
-- Chaque bloc est idempotent : la migration peut être rejouée sans dommage.

-- ---------------------------------------------------------------------------
-- 1. Côté serveur : salon des rappels et espacement des lots.
-- ---------------------------------------------------------------------------
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS reminder_channel_id varchar(20);
--> statement-breakpoint
ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS reminder_batch_minutes smallint NOT NULL DEFAULT 10;
--> statement-breakpoint
-- PostgreSQL n'a pas de `ADD CONSTRAINT IF NOT EXISTS` : on passe par le
-- catalogue pour garder le bloc rejouable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'guild_settings_reminder_batch_range'
  ) THEN
    ALTER TABLE guild_settings
      ADD CONSTRAINT guild_settings_reminder_batch_range
      CHECK (reminder_batch_minutes BETWEEN 1 AND 1440);
  END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Côté joueur : accepter d'être mentionné dans le salon du serveur.
--
-- `users.last_guild_id` existe déjà (classements par serveur) et est mis à
-- jour à chaque interaction : c'est lui qui désigne le serveur destinataire.
-- ---------------------------------------------------------------------------
ALTER TABLE settings ADD COLUMN IF NOT EXISTS channel_reminders boolean NOT NULL DEFAULT false;
