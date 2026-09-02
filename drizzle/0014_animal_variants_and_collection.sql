-- Variantes d'animaux (shiny, dorée) et collection du fermier (chantier S4).
--
-- `owned_animals` n'avait aucune notion de variante alors que les cultures ont
-- déjà qualité et mutation ; et le joueur n'avait aucune vue « ce que j'ai
-- déjà découvert ». Les variantes viennent UNIQUEMENT du jeu (tirage à
-- l'achat, hérédité à la reproduction) et leurs bonus restent modestes : rien
-- ici n'ouvre de source de pièces (voir `balance.animals.variants`).
-- Chaque bloc est idempotent : la migration peut être rejouée sans dommage.

-- ---------------------------------------------------------------------------
-- 1. Types énumérés.
--
-- L'ORDRE des valeurs compte : PostgreSQL compare un type énuméré par sa
-- position de déclaration, et la collection retient « la meilleure variante
-- vue » par un simple GREATEST. `quality` (normal < silver < gold < iridium)
-- existe déjà avec cette propriété.
-- PostgreSQL n'offre pas de `CREATE TYPE IF NOT EXISTS` : on attrape
-- `duplicate_object` pour rester rejouable.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE animal_variant AS ENUM ('normal', 'shiny', 'golden');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE discovery_kind AS ENUM ('crop', 'product', 'animal', 'fish', 'ore', 'variant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Variante d'un animal possédé.
--
-- NOT NULL DEFAULT 'normal' : le cheptel existant devient « normal » d'un
-- coup, sans réécriture ligne à ligne (valeur par défaut immuable, PG ≥ 11).
-- L'index est PARTIEL : les variantes rares sont ~2 % du cheptel, et un
-- classement « qui possède le plus de shiny » ne doit pas balayer le reste.
-- ---------------------------------------------------------------------------
ALTER TABLE owned_animals ADD COLUMN IF NOT EXISTS variant animal_variant NOT NULL DEFAULT 'normal';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS owned_animals_variant_idx
    ON owned_animals (variant, user_id)
    WHERE variant <> 'normal';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. La collection.
--
-- Une ligne par (joueur, famille, entrée). `entry_key` n'a pas de clé
-- étrangère : selon la famille il désigne une culture, un objet ou une
-- espèce (ou `<espèce>:<variante>`), et le service ne mappe que des clés de
-- `getConfig()`. `count` cumule les UNITÉS obtenues ; `best_*` gardent le
-- meilleur exemplaire vu, mis à jour par GREATEST sur les énumérations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discoveries (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         discovery_kind NOT NULL,
  entry_key    varchar(64) NOT NULL,
  first_at     timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1,
  best_quality quality,
  best_variant animal_variant,
  CONSTRAINT discoveries_pkey PRIMARY KEY (user_id, kind, entry_key),
  CONSTRAINT discoveries_count_positive CHECK (count > 0)
);
--> statement-breakpoint
-- « Combien de joueurs ont déjà vu une poule dorée ? » : statistiques et
-- classements futurs par entrée, la clé primaire servant la lecture par joueur.
CREATE INDEX IF NOT EXISTS discoveries_kind_entry_idx
    ON discoveries (kind, entry_key);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Nouveau type d'objectif : `discover_entry` (succès de collection).
--
-- Non bloquant depuis PostgreSQL 12 ; la valeur n'est utilisée par aucune
-- instruction de cette même transaction — le seed des succès qui l'emploie
-- tourne après les migrations.
-- ---------------------------------------------------------------------------
ALTER TYPE quest_objective ADD VALUE IF NOT EXISTS 'discover_entry';
