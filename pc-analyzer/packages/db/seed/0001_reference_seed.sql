-- =============================================================================
--  Jeu de données de référence (ILLUSTRATIF)
--
--  Valeurs indicatives au moment de la rédaction : versions de noyau issues des
--  notes de version / Arch Wiki, indices de performance approximatifs. En
--  production, ces lignes sont produites et rafraîchies par les jobs d'import
--  (docs/02-base-de-donnees.md § 5). Les UUID sont fixes pour que le seed soit
--  rejouable et référençable depuis les tests.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Distributions
-- -----------------------------------------------------------------------------
INSERT INTO distributions (id, name, version, family, kernel_version, kernel_hwe_version, rolling, lts, mesa_version, nvidia_driver_version, nvidia_install, secure_boot, audience, release_date) VALUES
  ('ubuntu-24.04', 'Ubuntu 24.04 LTS',       '24.04',   'ubuntu', '6.8',  '6.14', false, true,  '24.2', '580', 'easy',    'out_of_the_box', '{beginner,developer,workstation}', '2024-04-25'),
  ('fedora-43',    'Fedora Workstation 43',  '43',      'fedora', '6.17', NULL,   false, false, '25.2', '580', 'easy',    'mok',            '{developer,workstation,enthusiast}', '2025-10-28'),
  ('pop-24.04',    'Pop!_OS 24.04 LTS',      '24.04',   'ubuntu', '6.12', NULL,   false, true,  '24.2', '580', 'bundled', 'unsupported',    '{beginner,gaming,developer}', NULL),
  ('arch',         'Arch Linux',             'rolling', 'arch',   '6.17', NULL,   true,  false, '25.2', '580', 'manual',  'unsupported',    '{enthusiast,gaming,developer}', NULL),
  ('debian-13',    'Debian 13',              '13',      'debian', '6.12', NULL,   false, true,  '25.0', '535', 'manual',  'out_of_the_box', '{workstation,developer}', '2025-08-09'),
  ('bazzite',      'Bazzite',                '43',      'fedora', '6.17', NULL,   false, false, '25.2', '580', 'bundled', 'mok',            '{gaming,beginner}', NULL),
  ('mint-22.2',    'Linux Mint 22.2',        '22.2',    'ubuntu', '6.14', NULL,   false, true,  '24.2', '580', 'easy',    'out_of_the_box', '{beginner}', '2025-08-27');

-- -----------------------------------------------------------------------------
--  Composants
-- -----------------------------------------------------------------------------
INSERT INTO components (id, family, vendor, name, canonical_name, segment, launch_date, device_ids, specs) VALUES
  ('00000000-0000-4000-8000-000000000001', 'cpu',   'intel',    'Intel Core i7-13700H',              'intel core i7 13700h',              'laptop',  '2023-01-03', '{}', '{"codename":"Raptor Lake-H","base_ghz":2.4,"boost_ghz":5.0}'),
  ('00000000-0000-4000-8000-000000000002', 'cpu',   'amd',      'AMD Ryzen AI 9 HX 370',             'amd ryzen ai 9 hx 370',             'laptop',  '2024-07-15', '{}', '{"codename":"Strix Point","base_ghz":2.0,"boost_ghz":5.1}'),
  ('00000000-0000-4000-8000-000000000003', 'cpu',   'amd',      'AMD Ryzen 7 7800X3D',               'amd ryzen 7 7800x3d',               'desktop', '2023-04-06', '{}', '{"codename":"Raphael-X","socket":"AM5"}'),
  ('00000000-0000-4000-8000-000000000011', 'gpu',   'nvidia',   'NVIDIA GeForce RTX 4060 Laptop',    'nvidia geforce rtx 4060 laptop',    'laptop',  '2023-02-22', '{10de:28e0}', '{"bus":"pcie4 x8"}'),
  ('00000000-0000-4000-8000-000000000012', 'gpu',   'amd',      'AMD Radeon RX 7800 XT',             'amd radeon rx 7800 xt',             'desktop', '2023-09-06', '{1002:747e}', '{"bus":"pcie4 x16"}'),
  ('00000000-0000-4000-8000-000000000013', 'gpu',   'amd',      'AMD Radeon 890M',                   'amd radeon 890m',                   'laptop',  '2024-07-15', '{1002:150e}', '{}'),
  ('00000000-0000-4000-8000-000000000014', 'gpu',   'intel',    'Intel Iris Xe Graphics (96 EU)',    'intel iris xe graphics 96 eu',      'laptop',  '2021-01-01', '{8086:a7a0}', '{}'),
  ('00000000-0000-4000-8000-000000000021', 'wifi',  'realtek',  'Realtek RTL8852BE Wi-Fi 6',         'realtek rtl8852be',                 'both',    '2022-01-01', '{10ec:b852}', '{"standard":"wifi6","bands":"2.4/5"}'),
  ('00000000-0000-4000-8000-000000000022', 'wifi',  'mediatek', 'MediaTek MT7922 (AMD RZ616) Wi-Fi 6E', 'mediatek mt7922',                'both',    '2022-01-01', '{14c3:0616}', '{"standard":"wifi6e"}'),
  ('00000000-0000-4000-8000-000000000023', 'wifi',  'intel',    'Intel Wi-Fi 6E AX211',              'intel wi fi 6e ax211',              'both',    '2021-01-01', '{8086:51f0}', '{"standard":"wifi6e"}'),
  ('00000000-0000-4000-8000-000000000024', 'wifi',  'broadcom', 'Broadcom BCM4360',                  'broadcom bcm4360',                  'both',    '2013-01-01', '{14e4:43a0}', '{"standard":"wifi5"}'),
  ('00000000-0000-4000-8000-000000000031', 'audio', 'other',    'Cirrus Logic CS35L41 (amplificateur)', 'cirrus logic cs35l41',           'laptop',  '2022-01-01', '{}', '{}'),
  ('00000000-0000-4000-8000-000000000032', 'webcam','intel',    'Caméra MIPI Intel IPU6',            'intel ipu6',                        'laptop',  '2022-01-01', '{8086:a75d}', '{}');

INSERT INTO cpu_specs (component_id, cores, threads, tdp_w, has_npu, gaming_index, multi_index) VALUES
  ('00000000-0000-4000-8000-000000000001', 14, 20, 45,  false, 72, 62),
  ('00000000-0000-4000-8000-000000000002', 12, 24, 28,  true,  76, 70),
  ('00000000-0000-4000-8000-000000000003',  8, 16, 120, false, 95, 55);

INSERT INTO gpu_specs (component_id, integrated, vram_gb, architecture, perf_index, tgp_min_w, tgp_max_w, ray_tracing, rt_efficiency, upscalers, encoders, compute_apis, rocm_official) VALUES
  ('00000000-0000-4000-8000-000000000011', false, 8,  'ada',      29,   35, 140, true,  1.0,  '{dlss,fsr,xess}', '{nvenc}', '{cuda}', false),
  ('00000000-0000-4000-8000-000000000012', false, 16, 'rdna3',    56,   NULL, NULL, true, 0.7, '{fsr,xess}',      '{vcn}',   '{rocm}', true),
  ('00000000-0000-4000-8000-000000000013', true,  0,  'rdna3.5',  10.5, NULL, NULL, true, 0.5, '{fsr,xess}',      '{vcn}',   '{rocm}', false),
  ('00000000-0000-4000-8000-000000000014', true,  0,  'xe-lp',    4.7,  NULL, NULL, false, NULL, '{fsr,xess}',    '{qsv}',   '{oneapi}', false);

-- -----------------------------------------------------------------------------
--  Alias marchands (extraits de titres Amazon / Fnac / Boulanger / Cdiscount)
-- -----------------------------------------------------------------------------
INSERT INTO component_aliases (component_id, alias, alias_normalized, kind, source, confidence) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Intel Core i7-13700H',                 'intel core i7 13700h',           'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000001', 'i7-13700H',                            'i7 13700h',                      'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000001', 'Intel Core i7 13ème génération 13700H','intel core i7 13eme generation 13700h', 'retailer', 'fnac', 0.95),
  ('00000000-0000-4000-8000-000000000011', 'NVIDIA GeForce RTX 4060 Laptop GPU',   'nvidia geforce rtx 4060 laptop gpu', 'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000011', 'RTX 4060 8 Go (portable)',             'rtx 4060 8 go portable',         'retailer', 'boulanger', 0.90),
  ('00000000-0000-4000-8000-000000000011', 'GeForce RTX4060 8GB GDDR6',            'geforce rtx4060 8gb gddr6',      'retailer', 'amazon', 0.85),
  ('00000000-0000-4000-8000-000000000012', 'AMD Radeon RX 7800 XT 16 Go',          'amd radeon rx 7800 xt 16 go',    'retailer', 'ldlc', 1.00),
  ('00000000-0000-4000-8000-000000000013', 'AMD Radeon 890M Graphics',             'amd radeon 890m graphics',       'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000014', 'Intel Iris Xe Graphics',               'intel iris xe graphics',         'marketing', 'manual', 0.80),
  ('00000000-0000-4000-8000-000000000021', 'Realtek 8852BE',                       'realtek 8852be',                 'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000021', 'Wi-Fi 6 Realtek RTL8852BE',            'wi fi 6 realtek rtl8852be',      'retailer', 'boulanger', 1.00),
  ('00000000-0000-4000-8000-000000000021', '10ec:b852',                            '10ec:b852',                      'pci_id', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000022', 'AMD RZ616 Wi-Fi 6E',                   'amd rz616 wi fi 6e',             'oem', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000023', 'Intel AX211',                          'intel ax211',                    'marketing', 'manual', 1.00),
  ('00000000-0000-4000-8000-000000000023', 'Intel Wi-Fi 6E AX211 (Gig+)',          'intel wi fi 6e ax211 gig',       'marketing', 'manual', 1.00);

-- -----------------------------------------------------------------------------
--  Support Linux
-- -----------------------------------------------------------------------------
INSERT INTO linux_support (component_id, status, kernel_min, kernel_recommended, driver_name, driver_type, firmware_package, mesa_min, proprietary_driver_min, secure_boot_impact, confidence, source_url, notes) VALUES
  ('00000000-0000-4000-8000-000000000001', 'plug_and_play',   '5.19', NULL,   'intel_pstate',  'in_tree',          NULL,             NULL,   NULL,  'none',           0.95, 'https://wiki.archlinux.org/title/CPU_frequency_scaling', NULL),
  ('00000000-0000-4000-8000-000000000002', 'plug_and_play',   '6.10', '6.11', 'amd_pstate',    'in_tree',          NULL,             NULL,   NULL,  'none',           0.85, NULL, 'Strix Point : noyau ≥ 6.10 ; NPU (amdxdna) ≥ 6.14'),
  ('00000000-0000-4000-8000-000000000003', 'plug_and_play',   '6.0',  NULL,   'amd_pstate',    'in_tree',          NULL,             NULL,   NULL,  'none',           0.95, NULL, NULL),
  ('00000000-0000-4000-8000-000000000011', 'tweaks_required', NULL,   NULL,   'nvidia',        'proprietary',      NULL,             NULL,   '525', 'mok_enrollment', 0.95, 'https://wiki.archlinux.org/title/NVIDIA', 'Nouveau/NVK inadaptés au jeu ; Optimus via PRIME render offload'),
  ('00000000-0000-4000-8000-000000000012', 'plug_and_play',   '6.5',  NULL,   'amdgpu',        'in_tree_firmware', 'linux-firmware', '23.1', NULL,  'none',           0.95, 'https://wiki.archlinux.org/title/AMDGPU', NULL),
  ('00000000-0000-4000-8000-000000000013', 'plug_and_play',   '6.10', '6.11', 'amdgpu',        'in_tree_firmware', 'linux-firmware', '24.1', NULL,  'none',           0.85, NULL, NULL),
  ('00000000-0000-4000-8000-000000000014', 'plug_and_play',   '5.11', NULL,   'i915',          'in_tree_firmware', 'linux-firmware', '21.0', NULL,  'none',           0.95, NULL, NULL),
  ('00000000-0000-4000-8000-000000000021', 'plug_and_play',   '6.2',  '6.4',  'rtw89',         'in_tree_firmware', 'linux-firmware', NULL,   NULL,  'none',           0.80, 'https://github.com/lwfinger/rtw89', 'Avant 6.2 : module DKMS rtw89 hors arbre'),
  ('00000000-0000-4000-8000-000000000022', 'plug_and_play',   '5.18', NULL,   'mt7921e',       'in_tree_firmware', 'linux-firmware', NULL,   NULL,  'none',           0.90, NULL, NULL),
  ('00000000-0000-4000-8000-000000000023', 'plug_and_play',   '5.14', NULL,   'iwlwifi',       'in_tree_firmware', 'linux-firmware', NULL,   NULL,  'none',           0.95, NULL, NULL),
  ('00000000-0000-4000-8000-000000000024', 'tweaks_required', NULL,   NULL,   'wl (broadcom-sta)', 'proprietary',  NULL,             NULL,   NULL,  'mok_enrollment', 0.85, 'https://wiki.archlinux.org/title/Broadcom_wireless', 'Aucun pilote libre fonctionnel'),
  ('00000000-0000-4000-8000-000000000031', 'tweaks_required', '6.2',  '6.5',  'snd_hda_scodec_cs35l41', 'in_tree_firmware', 'linux-firmware', NULL, NULL, 'none',    0.75, NULL, 'Firmware propre au modèle ; parfois correctif _DSD nécessaire'),
  ('00000000-0000-4000-8000-000000000032', 'partial',         '6.10', NULL,   'intel_ipu6',    'in_tree_firmware', 'linux-firmware', NULL,   NULL,  'none',           0.70, NULL, 'Pile libcamera incomplète');

INSERT INTO linux_known_issues (component_id, summary, severity, workaround, fixed_in_kernel) VALUES
  ('00000000-0000-4000-8000-000000000002', 'NPU (XDNA) : pilote amdxdna disponible à partir du noyau 6.14', 'minor', NULL, '6.14'),
  ('00000000-0000-4000-8000-000000000011', 'Graphismes hybrides (Optimus) : le dGPU est utilisé à la demande', 'minor', 'Lancer les jeux avec PRIME render offload (prime-run)', NULL),
  ('00000000-0000-4000-8000-000000000021', 'Débits réduits en coexistence Wi-Fi / Bluetooth sur certains firmwares', 'minor', NULL, NULL),
  ('00000000-0000-4000-8000-000000000031', 'Haut-parleurs muets tant que le firmware CS35L41 propre au modèle est absent', 'major', 'Installer un linux-firmware récent ; certains modèles exigent un correctif _DSD', NULL),
  ('00000000-0000-4000-8000-000000000032', 'Pile libcamera / IPU6 incomplète : image dégradée ou absente selon l''application', 'major', NULL, NULL);

-- Particularité au niveau du modèle (motif de gamme).
INSERT INTO pc_linux_quirks (brand, model_pattern, summary, severity, workaround, source_url) VALUES
  ('Lenovo', '^Legion (5|7)', 'Pas de son sur les modèles à amplificateur CS35L41 avec un noyau ancien', 'major', 'Noyau ≥ 6.5 et linux-firmware récent', 'https://wiki.archlinux.org/title/Lenovo_Legion_5'),
  ('Dell',   '^XPS 13 93(15|20)', 'Webcam MIPI IPU6 non fonctionnelle hors Ubuntu OEM', 'major', 'Utiliser Ubuntu (pile OEM) ou une webcam USB', NULL);

-- -----------------------------------------------------------------------------
--  Jeux, ProtonDB, bancs
-- -----------------------------------------------------------------------------
INSERT INTO games (id, name, steam_app_id, apis, linux_native, linux_native_api, linux_native_perf_ratio, anti_cheat_kind, anti_cheat_linux, min_ram_gb, rec_ram_gb, vram_gb, cpu_bound_fps_ref, fps_cap, ray_tracing, ray_tracing_cost, upscalers, popularity_rank) VALUES
  ('cyberpunk-2077',   'Cyberpunk 2077',       1091500, '{dx12}',        false, NULL,     NULL,  'none',     'supported', 12, 16, '{"low":4,"medium":5,"high":6.5,"ultra":8}', 170, NULL, true,  0.55, '{dlss,fsr,xess}', 1),
  ('counter-strike-2', 'Counter-Strike 2',     730,     '{dx11}',        true,  'vulkan', 0.85,  'vac',      'supported', 8,  16, '{"low":2,"medium":3,"high":4,"ultra":5}',   480, NULL, false, NULL, '{}', 2),
  ('elden-ring',       'Elden Ring',           1245620, '{dx12}',        false, NULL,     NULL,  'eac',      'supported', 12, 16, '{"low":3,"medium":4,"high":5,"ultra":6}',   140, 60,   true,  0.70, '{}', 3),
  ('baldurs-gate-3',   'Baldur''s Gate 3',     1086940, '{dx11,vulkan}', false, NULL,     NULL,  'none',     'supported', 8,  16, '{"low":3,"medium":4,"high":6,"ultra":8}',   150, NULL, false, NULL, '{dlss,fsr}', 4),
  ('hogwarts-legacy',  'Hogwarts Legacy',      990080,  '{dx12}',        false, NULL,     NULL,  'none',     'supported', 16, 16, '{"low":4,"medium":6,"high":8,"ultra":12}',  130, NULL, true,  0.60, '{dlss,fsr,xess}', 5),
  ('fortnite',         'Fortnite',             NULL,    '{dx12,dx11}',   false, NULL,     NULL,  'eac',      'blocked',   8,  16, '{"low":2,"medium":3,"high":4,"ultra":6}',   300, NULL, false, NULL, '{dlss,fsr,xess}', 6),
  ('valorant',         'Valorant',             NULL,    '{dx11}',        false, NULL,     NULL,  'vanguard', 'blocked',   4,  8,  '{"low":1,"medium":1,"high":2,"ultra":2}',   600, NULL, false, NULL, '{}', 7),
  ('minecraft-java',   'Minecraft (Java Edition)', NULL, '{opengl}',     true,  'opengl', 1.0,   'none',     'supported', 4,  8,  '{"low":1,"medium":1,"high":2,"ultra":3}',   400, NULL, false, NULL, '{}', 8);

INSERT INTO game_proton_status (game_id, tier, confidence, reports, steam_deck) VALUES
  ('cyberpunk-2077',  'gold',     'strong', 4200, 'verified'),
  ('elden-ring',      'platinum', 'strong', 3100, 'verified'),
  ('baldurs-gate-3',  'platinum', 'strong', 2800, 'verified'),
  ('hogwarts-legacy', 'gold',     'good',   900,  'playable'),
  ('fortnite',        'borked',   'strong', 1500, 'unsupported'),
  ('valorant',        'borked',   'strong', 600,  'unsupported');

INSERT INTO game_benchmarks (game_id, os, gpu_component_id, cpu_component_id, gpu_perf_index_snapshot, cpu_gaming_index_snapshot, resolution, preset, avg_fps, low_1pct_fps, source_type, source_url, confidence) VALUES
  ('cyberpunk-2077',   'windows',      '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003', 56, 95, '1440p', 'ultra', 85,  68,  'review_site', NULL, 0.85),
  ('cyberpunk-2077',   'linux_proton', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003', 56, 95, '1440p', 'ultra', 78,  60,  'phoronix',    NULL, 0.80),
  ('counter-strike-2', 'windows',      '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003', 56, 95, '1440p', 'high',  300, 190, 'review_site', NULL, 0.85),
  ('counter-strike-2', 'linux_native', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003', 56, 95, '1440p', 'high',  265, 150, 'phoronix',    NULL, 0.80),
  ('cyberpunk-2077',   'windows',      '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 29, 72, '1080p', 'ultra', 62,  50,  'review_site', NULL, 0.80);

INSERT INTO dataset_imports (dataset, version, row_count, source_url) VALUES
  ('seed', '0001', NULL, NULL);
