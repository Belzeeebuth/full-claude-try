-- =============================================================================
--  PC Analyzer — schéma initial (PostgreSQL 16)
--
--  Quatre domaines :
--   1. RÉFÉRENTIEL   : composants canoniques, alias marchands, benchmarks,
--                      et le SUPPORT LINUX de chaque composant (le cœur du projet).
--   2. PRODUITS      : configurations (PC), leurs composants, les annonces
--                      marchandes qui y mènent, l'historique des prix.
--   3. JEUX          : catalogue, synthèse ProtonDB, bancs de mesure par OS.
--   4. EXPLOITATION  : jobs de scraping, file de revue humaine, comparaisons
--                      partagées, résultats d'analyse mis en cache.
--
--  Conventions : identifiants uuid (gen_random_uuid, natif depuis PG 13),
--  versions de noyau/Mesa/pilote en TEXT comparées par l'application
--  (compareVersions du moteur), horodatages en timestamptz.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- similarité trigramme pour le matching des alias
-- CREATE EXTENSION IF NOT EXISTS vector; -- optionnel : embeddings des descriptions marchandes

-- -----------------------------------------------------------------------------
--  Énumérations (miroir de packages/engine/src/types.ts)
-- -----------------------------------------------------------------------------

CREATE TYPE component_family AS ENUM
  ('cpu', 'gpu', 'wifi', 'bluetooth', 'audio', 'webcam', 'fingerprint', 'storage',
   'ethernet', 'touchpad', 'display', 'chipset', 'other');

CREATE TYPE component_role AS ENUM
  ('cpu', 'gpu_integrated', 'gpu_discrete', 'wifi', 'bluetooth', 'audio', 'webcam',
   'fingerprint', 'storage', 'ethernet', 'touchpad', 'display', 'other');

CREATE TYPE vendor AS ENUM
  ('intel', 'amd', 'nvidia', 'apple', 'qualcomm', 'mediatek', 'realtek', 'broadcom', 'other');

CREATE TYPE segment AS ENUM ('desktop', 'laptop', 'embedded', 'both');

CREATE TYPE linux_support_status AS ENUM
  ('plug_and_play', 'tweaks_required', 'partial', 'unsupported', 'unknown');

CREATE TYPE driver_type AS ENUM ('in_tree', 'in_tree_firmware', 'dkms', 'proprietary', 'none');
CREATE TYPE secure_boot_impact AS ENUM ('none', 'mok_enrollment', 'must_disable');
CREATE TYPE issue_severity AS ENUM ('minor', 'major', 'blocking');

CREATE TYPE pc_kind AS ENUM ('laptop', 'desktop', 'mini_pc', 'all_in_one');
CREATE TYPE ram_type AS ENUM ('ddr3', 'ddr4', 'ddr5', 'lpddr4x', 'lpddr5', 'lpddr5x', 'unified');
CREATE TYPE storage_type AS ENUM ('nvme', 'sata_ssd', 'hdd', 'emmc');

CREATE TYPE retailer AS ENUM
  ('amazon', 'fnac', 'boulanger', 'cdiscount', 'darty', 'ldlc', 'materiel_net', 'rue_du_commerce', 'other');
CREATE TYPE scrape_status AS ENUM ('queued', 'fetching', 'parsed', 'matched', 'needs_review', 'failed');
CREATE TYPE match_method AS ENUM ('alias_exact', 'regex', 'fuzzy', 'llm', 'manual');
CREATE TYPE alias_kind AS ENUM ('marketing', 'retailer', 'oem', 'pci_id', 'codename', 'typo');

CREATE TYPE target_os AS ENUM ('windows', 'linux_native', 'linux_proton');
CREATE TYPE resolution AS ENUM ('1080p', '1440p', '2160p');
CREATE TYPE preset AS ENUM ('low', 'medium', 'high', 'ultra');
CREATE TYPE graphics_api AS ENUM ('dx9', 'dx11', 'dx12', 'vulkan', 'opengl');
CREATE TYPE proton_tier AS ENUM ('platinum', 'gold', 'silver', 'bronze', 'borked', 'pending');
CREATE TYPE proton_confidence AS ENUM ('low', 'moderate', 'good', 'strong');
CREATE TYPE steam_deck_status AS ENUM ('verified', 'playable', 'unsupported', 'unknown');
CREATE TYPE anti_cheat_kind AS ENUM ('none', 'vac', 'eac', 'battleye', 'vanguard', 'ricochet', 'gameguard', 'other');
CREATE TYPE anti_cheat_linux AS ENUM ('supported', 'blocked', 'unknown');
CREATE TYPE upscaling_mode AS ENUM ('none', 'quality', 'balanced', 'performance');
CREATE TYPE benchmark_source_type AS ENUM ('review_site', 'phoronix', 'user_report', 'computed', 'manual');

CREATE TYPE distro_family AS ENUM ('debian', 'ubuntu', 'fedora', 'arch', 'suse', 'other');
CREATE TYPE nvidia_install AS ENUM ('bundled', 'easy', 'manual', 'none');
CREATE TYPE secure_boot_support AS ENUM ('out_of_the_box', 'mok', 'unsupported');

-- -----------------------------------------------------------------------------
--  Fonction utilitaire : updated_at automatique
-- -----------------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =============================================================================
--  1. RÉFÉRENTIEL
-- =============================================================================

CREATE TABLE components (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family          component_family NOT NULL,
  vendor          vendor NOT NULL,
  -- Nom canonique affiché : "Intel Core i7-13700H", "NVIDIA GeForce RTX 4060 Laptop".
  name            text NOT NULL,
  -- Forme normalisée (minuscules, sans accents ni ponctuation) : clé de matching.
  canonical_name  text NOT NULL UNIQUE,
  segment         segment NOT NULL DEFAULT 'both',
  launch_date     date,
  -- Identifiants PCI/USB "vendor:device" : clé de jointure vers linux-hardware.org.
  device_ids      text[] NOT NULL DEFAULT '{}',
  -- Spécifications propres à la famille (fréquences, bus, normes Wi-Fi…).
  specs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE components IS 'Composants canoniques : la vérité vers laquelle les descriptions marchandes sont rapprochées.';
COMMENT ON COLUMN components.device_ids IS 'IDs PCI/USB (ex. 10ec:b852) pour croiser les sondes linux-hardware.org.';

CREATE INDEX components_canonical_trgm ON components USING gin (canonical_name gin_trgm_ops);
CREATE INDEX components_family_vendor ON components (family, vendor);
CREATE TRIGGER components_updated_at BEFORE UPDATE ON components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Spécifications typées lues par le moteur (1-1 avec components).
CREATE TABLE cpu_specs (
  component_id   uuid PRIMARY KEY REFERENCES components (id) ON DELETE CASCADE,
  cores          smallint NOT NULL,
  threads        smallint NOT NULL,
  tdp_w          smallint,
  has_npu        boolean NOT NULL DEFAULT false,
  -- Indices normalisés (meilleur CPU de bureau grand public = 100), dérivés des benchmarks importés.
  gaming_index   numeric(5, 1) NOT NULL,
  multi_index    numeric(5, 1) NOT NULL
);

CREATE TABLE gpu_specs (
  component_id     uuid PRIMARY KEY REFERENCES components (id) ON DELETE CASCADE,
  integrated       boolean NOT NULL,
  vram_gb          numeric(5, 1) NOT NULL DEFAULT 0,
  architecture     text,
  -- Indice de rastérisation normalisé (GeForce RTX 4090 de bureau = 100).
  perf_index       numeric(6, 2) NOT NULL,
  -- Portables : plage de TGP et TGP auquel perf_index a été mesuré (généralement le max).
  tgp_min_w        smallint,
  tgp_max_w        smallint,
  ray_tracing      boolean NOT NULL DEFAULT false,
  rt_efficiency    numeric(4, 3),
  upscalers        text[] NOT NULL DEFAULT '{}',   -- dlss | fsr | xess
  encoders         text[] NOT NULL DEFAULT '{}',   -- nvenc | vcn | qsv
  compute_apis     text[] NOT NULL DEFAULT '{}',   -- cuda | rocm | oneapi
  rocm_official    boolean NOT NULL DEFAULT false,
  CONSTRAINT gpu_specs_tgp_range CHECK (tgp_min_w IS NULL OR tgp_max_w IS NULL OR tgp_min_w <= tgp_max_w)
);

-- Alias : toutes les façons dont un marchand écrit un composant.
CREATE TABLE component_aliases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id      uuid NOT NULL REFERENCES components (id) ON DELETE CASCADE,
  alias             text NOT NULL,
  alias_normalized  text NOT NULL,
  kind              alias_kind NOT NULL DEFAULT 'marketing',
  -- D'où vient l'alias : 'manual', 'amazon', 'fnac', 'auto:regex', 'auto:llm'…
  source            text NOT NULL DEFAULT 'manual',
  confidence        numeric(3, 2) NOT NULL DEFAULT 1.00 CHECK (confidence BETWEEN 0 AND 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_normalized, component_id)
);
COMMENT ON TABLE component_aliases IS 'Table de correspondance description marchande → composant réel (matching exact puis trigramme).';
CREATE INDEX component_aliases_trgm ON component_aliases USING gin (alias_normalized gin_trgm_ops);

-- Benchmarks bruts importés (PassMark, Geekbench, 3DMark, Notebookcheck…) : source des indices.
CREATE TABLE component_benchmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id  uuid NOT NULL REFERENCES components (id) ON DELETE CASCADE,
  benchmark     text NOT NULL,          -- ex. '3dmark_timespy_graphics', 'passmark_cpu_single'
  score         numeric(12, 2) NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- TGP, résolution, version de pilote…
  source_url    text,
  measured_at   date,
  sample_size   integer,
  UNIQUE (component_id, benchmark, config)
);

-- -----------------------------------------------------------------------------
--  Support Linux (critères principaux du projet)
-- -----------------------------------------------------------------------------

CREATE TABLE linux_support (
  component_id            uuid PRIMARY KEY REFERENCES components (id) ON DELETE CASCADE,
  status                  linux_support_status NOT NULL DEFAULT 'unknown',
  -- Premier noyau où le composant fonctionne, et noyau à partir duquel le support est mûr.
  kernel_min              text,
  kernel_recommended      text,
  driver_name             text NOT NULL,
  driver_type             driver_type NOT NULL,
  firmware_package        text,
  -- GPU : Mesa minimal (RADV/ANV/NVK) ; NVIDIA : version minimale du pilote propriétaire.
  mesa_min                text,
  proprietary_driver_min  text,
  secure_boot_impact      secure_boot_impact NOT NULL DEFAULT 'none',
  -- Qualité de la donnée : sondes linux-hardware.org, changelog noyau, vérification manuelle.
  confidence              numeric(3, 2) NOT NULL DEFAULT 0.50 CHECK (confidence BETWEEN 0 AND 1),
  probe_count             integer,      -- nombre de sondes linux-hardware.org agrégées
  source_url              text,
  notes                   text,
  verified_at             date,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE linux_support IS 'Statut Linux par composant : vert (plug_and_play), orange (tweaks_required / partial), rouge (unsupported).';
COMMENT ON COLUMN linux_support.kernel_min IS 'Version de noyau minimale, comparée numériquement par le moteur (6.10 > 6.8).';
CREATE TRIGGER linux_support_updated_at BEFORE UPDATE ON linux_support
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE linux_known_issues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id     uuid NOT NULL REFERENCES components (id) ON DELETE CASCADE,
  summary          text NOT NULL,
  severity         issue_severity NOT NULL,
  workaround       text,
  fixed_in_kernel  text,
  source_url       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX linux_known_issues_component ON linux_known_issues (component_id);

-- Distributions : ce que chacune LIVRE réellement (rafraîchi par job).
CREATE TABLE distributions (
  id                     text PRIMARY KEY,           -- slug : 'ubuntu-24.04', 'fedora-43', 'arch'
  name                   text NOT NULL,
  version                text NOT NULL,
  family                 distro_family NOT NULL,
  kernel_version         text NOT NULL,
  kernel_hwe_version     text,
  rolling                boolean NOT NULL DEFAULT false,
  lts                    boolean NOT NULL DEFAULT false,
  mesa_version           text NOT NULL,
  nvidia_driver_version  text,
  nvidia_install         nvidia_install NOT NULL DEFAULT 'manual',
  secure_boot            secure_boot_support NOT NULL DEFAULT 'unsupported',
  audience               text[] NOT NULL DEFAULT '{}',   -- beginner | gaming | developer | workstation | enthusiast
  release_date           date,
  eol_date               date,
  refreshed_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE distributions IS 'Versions de noyau, Mesa et pilote NVIDIA livrées : entrée du calcul « cette distribution supporte-t-elle ce matériel ? ».';

-- =============================================================================
--  2. PRODUITS
-- =============================================================================

CREATE TABLE pcs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                     pc_kind NOT NULL,
  brand                    text NOT NULL,
  model_name               text NOT NULL,
  sku                      text,
  release_year             smallint,
  -- Mémoire
  ram_total_gb             numeric(6, 1) NOT NULL,
  ram_type                 ram_type NOT NULL,
  ram_speed_mt             integer,
  ram_channels             smallint NOT NULL DEFAULT 2 CHECK (ram_channels IN (1, 2, 4, 8)),
  ram_soldered             boolean NOT NULL DEFAULT false,
  ram_slots_free           smallint,
  ram_max_gb               numeric(6, 1),
  -- Stockage : [{"type":"nvme","capacity_gb":512,"interface":"pcie4"}], emplacements libres
  storage                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_slots_free       smallint,
  -- Écran : {"size_in":15.6,"width":2560,"height":1600,"refresh_hz":165,"panel":"IPS","srgb_pct":100,"nits":400,"hdr":false,"touch":false}
  display                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Châssis, ports, batterie / alimentation
  chassis                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ports                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  battery_wh               numeric(5, 1),
  psu_w                    smallint,
  -- Firmware
  secure_boot_default      boolean NOT NULL DEFAULT true,
  intel_vmd_raid_default   boolean NOT NULL DEFAULT false,
  tpm                      boolean,
  -- Certifications Linux : 'ubuntu-certified', 'linux-first-oem', 'redhat-certified'
  linux_vendor_certified   text[] NOT NULL DEFAULT '{}',
  -- Réparabilité : {"french_index":7.2,"ifixit_score":8,"manual_url":"…","spare_parts_years":7}
  repairability            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand, model_name, sku)
);
COMMENT ON COLUMN pcs.repairability IS 'Indice de réparabilité français (obligatoire en rayon) et données iFixit.';
CREATE INDEX pcs_brand_model_trgm ON pcs USING gin ((brand || ' ' || model_name) gin_trgm_ops);
CREATE TRIGGER pcs_updated_at BEFORE UPDATE ON pcs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pc_components (
  pc_id             uuid NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
  component_id      uuid NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  role              component_role NOT NULL,
  quantity          smallint NOT NULL DEFAULT 1,
  -- GPU de portable : TGP configuré par le constructeur (35-175 W), s'il est connu.
  tgp_w             smallint,
  -- Provenance du rapprochement : comment et avec quelle certitude ce composant a été identifié.
  match_method      match_method NOT NULL DEFAULT 'manual',
  match_confidence  numeric(3, 2) NOT NULL DEFAULT 1.00 CHECK (match_confidence BETWEEN 0 AND 1),
  raw_text          text,
  PRIMARY KEY (pc_id, role, component_id)
);
CREATE INDEX pc_components_component ON pc_components (component_id);

-- Particularités Linux au niveau d'un MODÈLE (pas d'un composant) : firmware audio d'un
-- Legion précis, caméra IPU6 d'un XPS, touches Fn d'un ROG… Rattachées à un PC ou à un
-- motif (marque + expression régulière sur le modèle) pour couvrir toute une gamme.
CREATE TABLE pc_linux_quirks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_id            uuid REFERENCES pcs (id) ON DELETE CASCADE,
  brand            text,
  model_pattern    text,
  summary          text NOT NULL,
  severity         issue_severity NOT NULL,
  workaround       text,
  fixed_in_kernel  text,
  source_url       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pc_linux_quirks_target CHECK (pc_id IS NOT NULL OR (brand IS NOT NULL AND model_pattern IS NOT NULL))
);

-- Annonces marchandes : ce que l'utilisateur colle, et ce qu'on en a extrait.
CREATE TABLE retailer_listings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer             retailer NOT NULL,
  external_id          text NOT NULL,        -- ASIN, référence Fnac, code Boulanger, SKU Cdiscount…
  url                  text NOT NULL,
  title                text,
  -- Paires clé/valeur extraites de la fiche (tableau de caractéristiques, puces, JSON-LD).
  raw_specs            jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_cents          integer,
  currency             char(3) NOT NULL DEFAULT 'EUR',
  in_stock             boolean,
  repairability_index  numeric(3, 1),        -- indice de réparabilité affiché par le marchand
  -- Clé de l'instantané HTML archivé (S3/R2) : permet de re-parser sans re-scraper.
  html_snapshot_key    text,
  pc_id                uuid REFERENCES pcs (id) ON DELETE SET NULL,
  scraped_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retailer, external_id)
);
CREATE INDEX retailer_listings_pc ON retailer_listings (pc_id);

CREATE TABLE price_history (
  id           bigserial PRIMARY KEY,
  listing_id   uuid NOT NULL REFERENCES retailer_listings (id) ON DELETE CASCADE,
  price_cents  integer NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_listing_time ON price_history (listing_id, captured_at DESC);

-- =============================================================================
--  3. JEUX
-- =============================================================================

CREATE TABLE games (
  id                       text PRIMARY KEY,          -- slug : 'cyberpunk-2077'
  name                     text NOT NULL,
  steam_app_id             integer UNIQUE,
  apis                     graphics_api[] NOT NULL,   -- la première est l'API par défaut
  linux_native             boolean NOT NULL DEFAULT false,
  linux_native_api         graphics_api,
  linux_native_perf_ratio  numeric(4, 3),             -- mesuré vs Windows (0.85 = -15 %)
  anti_cheat_kind          anti_cheat_kind NOT NULL DEFAULT 'none',
  anti_cheat_linux         anti_cheat_linux NOT NULL DEFAULT 'unknown',
  min_ram_gb               numeric(4, 1) NOT NULL,
  rec_ram_gb               numeric(4, 1) NOT NULL,
  -- VRAM nécessaire par preset à 1080p : {"low":4,"medium":5,"high":6.5,"ultra":8}
  vram_gb                  jsonb NOT NULL,
  -- Plafond FPS imposé par le CPU sur un CPU d'indice 100 (calibré sur les bancs).
  cpu_bound_fps_ref        numeric(6, 1) NOT NULL,
  fps_cap                  smallint,
  ray_tracing              boolean NOT NULL DEFAULT false,
  ray_tracing_cost         numeric(4, 3),
  upscalers                text[] NOT NULL DEFAULT '{}',
  popularity_rank          integer,
  cover_url                text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX games_popularity ON games (popularity_rank);
CREATE TRIGGER games_updated_at BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Synthèse ProtonDB (importée périodiquement depuis les résumés publics).
CREATE TABLE game_proton_status (
  game_id         text PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  tier            proton_tier NOT NULL,
  confidence      proton_confidence NOT NULL,
  reports         integer NOT NULL DEFAULT 0,
  trending_tier   proton_tier,
  score           numeric(4, 3),
  steam_deck      steam_deck_status NOT NULL DEFAULT 'unknown',
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- Bancs de mesure : la matière première de l'estimateur de FPS.
CREATE TABLE game_benchmarks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id                  text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  os                       target_os NOT NULL,
  gpu_component_id         uuid NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  cpu_component_id         uuid REFERENCES components (id) ON DELETE SET NULL,
  -- Indices figés au moment de la mesure (un indice recalibré ne doit pas déplacer les bancs).
  gpu_perf_index_snapshot  numeric(6, 2) NOT NULL,
  cpu_gaming_index_snapshot numeric(5, 1),
  resolution               resolution NOT NULL,
  preset                   preset NOT NULL,
  ray_tracing              boolean NOT NULL DEFAULT false,
  upscaling                upscaling_mode NOT NULL DEFAULT 'none',
  proton_version           text,
  tgp_w                    smallint,
  avg_fps                  numeric(6, 1) NOT NULL,
  low_1pct_fps             numeric(6, 1),
  source_type              benchmark_source_type NOT NULL,
  source_url               text,
  measured_at              date,
  sample_size              integer,
  confidence               numeric(3, 2) NOT NULL DEFAULT 0.80 CHECK (confidence BETWEEN 0 AND 1)
);
CREATE INDEX game_benchmarks_lookup ON game_benchmarks (game_id, os, resolution, preset);

-- =============================================================================
--  4. EXPLOITATION
-- =============================================================================

CREATE TABLE scrape_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  input         text NOT NULL,               -- URL ou référence collée par l'utilisateur
  retailer      retailer,
  status        scrape_status NOT NULL DEFAULT 'queued',
  attempts      smallint NOT NULL DEFAULT 0,
  error         text,
  listing_id    uuid REFERENCES retailer_listings (id) ON DELETE SET NULL,
  pc_id         uuid REFERENCES pcs (id) ON DELETE SET NULL,
  requested_by  text,                        -- identifiant de session anonyme ou d'utilisateur
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX scrape_jobs_status ON scrape_jobs (status, created_at);

-- File de revue humaine : un composant que le matching n'a pas su trancher.
CREATE TABLE match_reviews (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  uuid NOT NULL REFERENCES scrape_jobs (id) ON DELETE CASCADE,
  role                    component_role NOT NULL,
  raw_text                text NOT NULL,
  -- [{"component_id":"…","name":"…","confidence":0.62,"method":"fuzzy"}, …]
  candidates              jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_component_id   uuid REFERENCES components (id) ON DELETE SET NULL,
  resolved_by             text,
  resolved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_reviews_open ON match_reviews (created_at) WHERE resolved_at IS NULL;

-- Comparaisons partagées (jusqu'à 4 PC), sans compte utilisateur.
CREATE TABLE comparisons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_slug  text NOT NULL UNIQUE,
  pc_ids      uuid[] NOT NULL CHECK (cardinality(pc_ids) BETWEEN 1 AND 4),
  -- {"os_focus":"linux","games":["cyberpunk-2077"],"resolution":"1440p","preset":"high"}
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

-- Résultats d'analyse mis en cache : recalculés quand le moteur OU les données changent.
CREATE TABLE pc_analyses (
  pc_id            uuid NOT NULL REFERENCES pcs (id) ON DELETE CASCADE,
  engine_version   text NOT NULL,
  dataset_version  text NOT NULL,
  linux_report     jsonb NOT NULL,
  diagnostic       jsonb NOT NULL,
  fps              jsonb NOT NULL,
  pro_workloads    jsonb NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pc_id, engine_version, dataset_version)
);

-- Provenance des jeux de données importés (ProtonDB, bancs, sondes linux-hardware…).
CREATE TABLE dataset_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset      text NOT NULL,          -- 'protondb', 'linux-hardware', 'benchmarks:techpowerup'…
  version      text NOT NULL,          -- date du dump, tag, hash
  row_count    integer,
  source_url   text,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset, version)
);

-- -----------------------------------------------------------------------------
--  Vue de commodité : un composant avec son support Linux, prêt pour le moteur.
-- -----------------------------------------------------------------------------

CREATE VIEW components_with_linux AS
SELECT
  c.id, c.family, c.vendor, c.name, c.canonical_name, c.segment, c.launch_date, c.device_ids, c.specs,
  ls.status, ls.kernel_min, ls.kernel_recommended, ls.driver_name, ls.driver_type, ls.firmware_package,
  ls.mesa_min, ls.proprietary_driver_min, ls.secure_boot_impact, ls.confidence AS linux_confidence,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
       'summary', i.summary, 'severity', i.severity, 'workaround', i.workaround,
       'fixedInKernel', i.fixed_in_kernel, 'sourceUrl', i.source_url))
     FROM linux_known_issues i WHERE i.component_id = c.id),
    '[]'::jsonb) AS known_issues,
  to_jsonb(cs.*) - 'component_id' AS cpu,
  to_jsonb(gs.*) - 'component_id' AS gpu
FROM components c
LEFT JOIN linux_support ls ON ls.component_id = c.id
LEFT JOIN cpu_specs cs ON cs.component_id = c.id
LEFT JOIN gpu_specs gs ON gs.component_id = c.id;
