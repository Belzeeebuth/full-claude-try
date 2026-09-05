# 03 — Algorithmes : compatibilité Linux, distributions, FPS Windows / Proton, charges pro

> Code : [`packages/engine/src`](../packages/engine/src) (TypeScript pur, 44 tests : `npm test`).
> Les chiffres des exemples sortent des fixtures livrées (`src/fixtures/`), dont les valeurs sont
> indicatives ; en production ils viennent des tables décrites dans le doc 02.

## 1. Compatibilité Linux — `linux/compatibility.ts`

### 1.1 Entrées

- La configuration (`PcConfiguration`) : composants avec leur **rôle** (`cpu`, `gpu_discrete`,
  `gpu_integrated`, `wifi`, `audio`…), firmware (`secureBootDefault`, `intelVmdRaidDefault`),
  certifications constructeur.
- Le support Linux de chaque composant (`LinuxSupport`) : statut de base, `kernelMin`,
  `kernelRecommended`, pilote (`in_tree` / `in_tree_firmware` / `dkms` / `proprietary` / `none`),
  `mesaMin`, `proprietaryDriverMin`, `secureBootImpact`, problèmes connus, confiance.
- Optionnellement une distribution (`DistroRelease`) : noyau livré (+ noyau HWE), Mesa, pilote NVIDIA
  disponible, Secure Boot.

### 1.2 Barème

Statut → score : `plug_and_play` 100 · `tweaks_required` 65 · `partial` 40 · `unsupported` 0 ·
`unknown` 50 (avec confiance plafonnée à 0,3).

Poids par rôle (portable / fixe) et criticité :

| Rôle | Portable | Fixe | Critique |
|---|---|---|---|
| GPU dédié | 22 | 30 | oui |
| GPU intégré | 18 (8 si un dGPU est présent) | 12 | oui |
| CPU | 12 | 12 | oui |
| Wi-Fi | 18 | 6 | oui sur portable, ou sur fixe sans Ethernet |
| Stockage (contrôleur) | 8 | 8 | oui |
| Audio | 7 | 4 | non |
| Webcam | 5 | 1 | non |
| Bluetooth / pavé tactile | 4 / 4 | 2 / 0 | non |
| Ethernet | 1 | 6 | non |
| Empreintes / écran / autre | 2 / 2 / 1 | 0 / 1 / 1 | non (mineurs : poids ≤ 3) |

### 1.3 Portes (dégradation du statut pour une distribution)

Le statut de base est celui « sur noyau récent ». Pour une distribution donnée, il ne peut que se
dégrader (`worstStatus`) :

1. **Noyau** : `kernelMin > noyau livré` → `unsupported`, *sauf* si un noyau HWE officiel suffit →
   `tweaks_required` + action « installer le noyau HWE ». `kernelRecommended > noyau retenu` →
   `plug_and_play` devient `tweaks_required` (« support encore jeune »).
2. **Mesa** (GPU) : `mesaMin > mesa livré` → `tweaks_required` + action « dépôt Mesa plus récent ».
3. **Pilote NVIDIA** : `proprietaryDriverMin > version disponible` (ou aucune) → `tweaks_required` ;
   distribution qui ne distribue pas le pilote → `partial`.
4. **Secure Boot** : machine avec Secure Boot actif par défaut × composant `mok_enrollment` →
   `tweaks_required` + « enrôler une clé MOK » ; `must_disable` → « désactiver Secure Boot ».
5. **Problèmes connus** non corrigés par le noyau retenu (`fixedInKernel`) : `major` →
   `tweaks_required`, `blocking` → `partial` ; les `minor` sont seulement listés.
6. **Firmware** : Intel VMD/RST en RAID → stockage `tweaks_required` + action UEFI « mode AHCI ».

### 1.4 Score, badge, confiance

```
score      = Σ(score_composant × poids) / Σ poids            (0–100, +3 si certifié constructeur)
confiance  = Σ(confiance_composant × poids) / Σ poids        (+0,15 si certifié constructeur)

badge = rouge   si un composant critique est `unsupported`
      = gris    si confiance < 0,4
      = orange  si score < 85, ou un composant critique est en tweaks/partial,
                ou un composant secondaire (poids > 3) est `unsupported`,
                ou une action UEFI est nécessaire (VMD, Secure Boot non géré par la distribution)
      = vert    sinon (les composants mineurs morts sont cités dans le résumé : « Plug & Play, sauf … »)
```

Le rapport liste, par composant, le statut de base, le statut effectif, les **raisons** et les
**actions**, plus une synthèse Secure Boot (impact global, guidance), les actions UEFI, et le noyau
minimal/recommandé de la configuration avec « satisfait par le noyau GA / par le HWE ».

### 1.5 Exemples (fixtures)

| Configuration | Distribution | Badge | Score | Pourquoi |
|---|---|---|---|---|
| Lenovo Legion 5 (i7-13700H, RTX 4060 Laptop, Realtek RTL8852BE, ampli CS35L41) | Ubuntu 24.04 LTS (6.8) | **orange** | 88 | NVIDIA : pilote propriétaire + clé MOK (Secure Boot actif) + PRIME offload ; audio : firmware CS35L41 ; Wi-Fi RTL8852BE plug & play (rtw89 dans l'arbre depuis 6.2) |
| ASUS Zenbook S 16 (Ryzen AI 9 HX 370, Radeon 890M, MediaTek MT7922) | Ubuntu 24.04 LTS (6.8, HWE 6.14) | **orange** | 86 | Strix Point exige le noyau ≥ 6.10 : le GA ne suffit pas, le HWE oui → action « installer le noyau 6.14 » |
| même Zenbook | Fedora 43 (6.17) · Debian 13 (6.12) | **vert** | 100 | Tout dans l'arbre, Secure Boot sans contrainte |
| même Zenbook | Pop!_OS 24.04 (6.12) | **orange** | 100 | Matériel OK, mais Pop!_OS ne démarre pas avec Secure Boot actif → action UEFI |
| PC fixe Ryzen 7 7800X3D + RX 7800 XT + Ethernet | Fedora 43 | **vert** | 100 | amdgpu/RADV, Wi-Fi non critique grâce à l'Ethernet |
| MacBook Air M3 | toutes | **rouge** | — | Asahi ne prend pas en charge M3 : CPU et GPU `unsupported` |

## 2. Recommandation de distributions — `linux/distro-recommender.ts`

Pour chaque distribution de la table `distributions` :

```
score_matériel = score du rapport de compatibilité recalculé avec CE noyau / Mesa / pilote NVIDIA
score_profil   = 50
   + NVIDIA dédié : pilote préinstallé +15 · installation en une étape +8 · manuelle −5 · absent −25
   + Secure Boot exigé par le profil : natif +10 · via MOK +4 · non géré −25
   + public visé correspond à l'usage (jeu / développement / station / grand public) +10
   + débutant : distribution « beginner » +8, rolling release −10
   + avancé : distribution « enthusiast » +5
   + stabilité souhaitée : LTS +8, rolling −8
   − 5 si le matériel exige le noyau HWE
score = 0,65 × score_matériel + 0,35 × score_profil
```

Chaque recommandation porte ses raisons (« Noyau 6.17 ≥ 6.10 requis par le matériel », « Pilote NVIDIA
préinstallé ») et ses avertissements (« Nécessite le noyau alternatif 6.14 », « Secure Boot doit être
désactivé »).

Exemples : Legion 5, profil *jeu, débutant* → Bazzite 86, Pop!_OS 86, Mint 80, Ubuntu 80, Fedora 78,
Arch 73, Debian 73. Zenbook S 16, profil *développement, Secure Boot exigé* → Debian 13 90, Fedora 43 87,
Mint 86, Bazzite 84, Ubuntu 24.04 79 (HWE), Arch 77 et Pop!_OS 77 (Secure Boot).

## 3. Estimation des FPS — `performance/fps-estimator.ts`

### 3.1 Vue d'ensemble

```
             ┌ mesure de référence (jeu, OS, GPU le plus proche) ┐
             │  ramenée à la résolution / au preset cibles       │
             └───────────────────────┬───────────────────────────┘
                                     ▼
  débridage du plafond CPU du banc → charge GPU pure (FPS_gpu_ref)
                                     ▼
  FPS_gpu = FPS_gpu_ref × (indice_gpu_effectif / indice_gpu_ref) × RT × upscaling × pénalité VRAM
                                     ▼
  FPS_cpu = cpuBoundFpsRef × indice_cpu / 100
                                     ▼
  FPS_Windows = min_lissé(FPS_gpu, FPS_cpu) × pénalité RAM, puis plafond moteur
                                     ▼
  Linux natif  = mesure native si elle existe, sinon FPS_Windows × ratio_portage × pilote
  Linux Proton = mesure Proton si elle existe, sinon FPS_Windows × traduction(API, vendeur)
                 × palier ProtonDB × pilote × RT_linux   — ou « incompatible » (anti-cheat, Borked)
```

### 3.2 Formules

**Indice GPU effectif (portables).** `indice = perf_index × min(1, TGP / TGP_max)^0,3`. Sans TGP annoncé
par le marchand : milieu de la plage et confiance −0,1 (`tgpAssumed`). Exemple : RTX 4060 Laptop
(29 à 140 W) à 60 W → 29 × (0,43)^0,3 = 22,5.

**Choix de la référence.** Parmi les bancs du jeu pour l'OS visé (sans RT ni upscaling), coût =
`|ln(indice_cible / indice_banc)| + 0,35 si résolution différente + 0,25 si preset différent + 0,1 si
vendeur différent` ; on prend le coût minimal. Pour Linux, on n'accepte une mesure que du **même vendeur de
GPU** et à distance ≤ 0,5 (rapport 1,65) : au-delà, le modèle prend le relais (les couches de traduction se
comportent différemment selon le pilote).

**Changement de résolution / preset.** Facteurs de charge GPU : 1080p 1 · 1440p 0,68 · 2160p 0,40 ;
ultra 1 · high 1,18 · medium 1,40 · low 1,65. `échelle = f_res(cible)/f_res(banc) × f_preset(cible)/f_preset(banc)`.

**Débridage.** Une mesure `m` faite avec un CPU d'indice `i` est bornée par `c = cpuBoundFpsRef × i/100`.
Avec la combinaison douce d'exposant `k = 4` : `FPS_gpu_ref = (m^-k − c^-k)^(-1/k)` (si `m ≥ 0,97 c`, la
mesure était plafonnée : on prend `1,1 m`).

**Combinaison douce.** `min_lissé(a, b) = (a^-k + b^-k)^(-1/k)` : vaut ≈ min(a, b) quand l'un domine, et
0,84 × a quand a = b (les deux goulots se partagent le temps de frame).

**Ray tracing.** `× ray_tracing_cost × rt_efficiency` (Cyberpunk : 0,55 ; RDNA 3 : 0,7 ; NVIDIA : 1).
Ignoré avec avertissement si le jeu ou le GPU ne le propose pas.

**Upscaling.** Technologie choisie dans l'ordre du vendeur (NVIDIA : DLSS > FSR > XeSS ; AMD : FSR > XeSS ;
Intel : XeSS > FSR) parmi celles du jeu. Gain : qualité 1,25 / 1,35 / 1,55 (1080p / 1440p / 2160p),
équilibré 1,35 / 1,5 / 1,75, performance 1,5 / 1,7 / 2,1.

**VRAM.** Besoin = `vram_gb[preset] × (1 · 1,25 · 1,6 selon résolution) + 1,5 Go si RT`. iGPU : VRAM
partagée = min(RAM/2, 8 Go). Dépassement ≤ 10 % → × 0,9 ; ≤ 30 % → × 0,75 ; au-delà → × 0,55, avec
avertissement et goulot `vram`.

**RAM.** Sous le minimum du jeu × 0,6 ; sous la recommandation × 0,92 ; simple canal × 0,7 avec un iGPU,
× 0,95 avec un dGPU. Stockage HDD : avertissement (chargements, streaming).

**Plafond moteur.** `min(FPS, fps_cap)` (Elden Ring : 60) → goulot `fps_cap`.

**1 % low.** `moyenne × ratio_banc (ou 0,72)`, × 0,9 si goulot CPU, × 0,8 si VRAM limitante, × 0,92
sous Proton (compilation des shaders au premier lancement).

**Linux natif.** Mesure native prioritaire ; sinon `FPS_Windows × linux_native_perf_ratio × pilote`
(CS2 : 0,85 ; Minecraft : 1,0 ; défaut 0,9).

**Linux via Proton.** D'abord les blocages : anti-cheat `blocked` (Fortnite, Valorant, Apex…) ou palier
`borked` → **incompatible**, quelle que soit la machine ; GPU sans pilote Linux → incompatible. Sinon :

| Facteur | Valeurs |
|---|---|
| Couche de traduction (API par défaut du jeu × vendeur) | DX12 → VKD3D-Proton : AMD 0,92 · NVIDIA 0,85 · Intel 0,85 ; DX11/DX9 → DXVK : 0,98 / 0,95 / 0,90 ; Vulkan 1,0 / 0,98 / 0,97 ; OpenGL 0,97 |
| Palier ProtonDB | Platinum 1 · Gold 0,97 · Silver 0,85 · Bronze 0,6 · Borked 0 · inconnu 0,9 (confiance −0,1) |
| Pilote Linux | AMD (RADV) 1,0 · NVIDIA propriétaire 0,97 · Intel (ANV) 0,95 |
| Ray tracing sous Linux | NVIDIA 0,95 · AMD 0,8 · Intel 0,85 |

Chemin recommandé : natif si `FPS_natif ≥ 0,95 × FPS_Proton`, sinon Proton ; `none` si les deux sont
incompatibles. Notes produites : couche de traduction et perte attendue, palier et nombre de rapports,
compilation des shaders (DX12), pilote propriétaire NVIDIA, DLSS (super résolution OK, génération d'images
partielle), ray tracing.

**Jouabilité.** ≥ 120 excellent · ≥ 60 fluide · ≥ 40 jouable · ≥ 25 limité · < 25 injouable ·
`null` incompatible.

**Confiance.** 0,9 − 0,1 (TGP inconnu) − 0,1 (iGPU) − 0,1 (CPU inconnu) − pénalité de référence
(résolution 0,1, preset 0,08, distance GPU jusqu'à 0,25) ; Proton modélisé −0,15 (−0,1 de plus sans rapport
ProtonDB) ; natif modélisé −0,1. Bornée à [0,2 ; 0,95].

### 3.3 Exemple détaillé — Cyberpunk 2077, Legion 5 (RTX 4060 Laptop 140 W, i7-13700H), 1080p ultra

1. Référence : RTX 4060 de bureau (indice 30), 1080p ultra, 68 FPS (1 % low 55), CPU d'indice 100.
2. Débridage : `c = 170`, `(68^-4 − 170^-4)^-1/4 = 68,4`.
3. Projection : `68,4 × 1 × 29/30 = 66,1` (même résolution et preset ; VRAM 8 Go = 8 Go requis ; RAM OK).
4. Plafond CPU : `170 × 0,72 = 122,4`. Combinaison : `66,1 × (1 + (66,1/122,4)^4)^-1/4 = 64,8`.
5. Windows : **64,8 FPS**, 1 % low `64,8 × 55/68 = 52,4`, goulot GPU, confiance 0,89, fluide.
6. Proton : `64,8 × 0,85 (DX12/NVIDIA) × 0,97 (Gold) × 0,97 (pilote) = 51,8`, jouable, confiance 0,74.

Autres sorties des fixtures : PC fixe RX 7800 XT, Cyberpunk 1440p ultra → Windows 84,7 (mesure) / Proton
77,8 (**mesure Proton**, pas le modèle) ; avec ray tracing → 33,2 / 24,3. CS2 1440p high → Windows 297,
natif 264 (mesure), Proton 262 → chemin **natif**. Fortnite → Windows 132, Linux **incompatible**
(EAC désactivé par l'éditeur). Hogwarts Legacy 1440p ultra sur 8 Go de VRAM → 15 Go requis, × 0,55, goulot
VRAM. Elden Ring → 56,9 sur le Legion (sous le plafond de 60).

### 3.4 Calibration et limites

- Les coefficients (`DEFAULT_PERF_MODEL`) sont des valeurs de départ. Le job de calibration ajuste,
  par régression sur `game_benchmarks`, les facteurs de résolution/preset par jeu, les rendements de
  traduction par API × vendeur × version de Proton, et `cpu_bound_fps_ref` par jeu.
- Une mesure Linux vaut mieux que dix coefficients : chaque banc Proton importé remplace le modèle pour
  les GPU voisins du même vendeur.
- Non modélisés : génération d'images (DLSS 3 / FSR 3), HDR, VRR, stutters de traversal, versions de
  jeux ; ils font l'objet de notes, pas de chiffres.

## 4. Charges de travail pro — `performance/pro-workloads.ts`

Scores 0–100 par charge et par OS, avec facteur limitant et outils :

| Charge | Formule (sous-scores 0–100) | Différence Linux |
|---|---|---|
| Montage vidéo | 0,35 CPU multi + 0,25 GPU + 0,2 RAM (32 Go = 100) + 0,1 stockage + 0,1 encodeur matériel | ≈ identique ; note DaVinci Resolve (Studio pour H.264/AAC), Kdenlive VA-API/NVENC |
| Développement | 0,4 CPU multi + 0,25 RAM + 0,2 stockage + 0,15 CPU mono | × 1,05 : conteneurs natifs (pas de WSL2), E/S |
| Rendu 3D | 0,6 calcul GPU (ou CPU × 0,6) + 0,25 CPU multi + 0,15 RAM | calcul GPU : CUDA/OptiX 1 sur les deux OS ; AMD ROCm 0,85 (liste officielle) / 0,55 sous Linux contre 0,65 / 0,45 sous Windows ; Intel oneAPI 0,7 / 0,6 |
| IA locale | palier VRAM (24 Go = 100, 8 Go = 50 ; mémoire unifiée pour les iGPU) × rendement de l'API de calcul | PyTorch ROCm officiel sous Linux seulement ; NPU : `intel_vpu` ≥ 6.8, `amdxdna` ≥ 6.14 |

Exemple : PC fixe RX 7800 XT → rendu 3D 53 (Windows) / 61 (Linux), IA locale 55 / 72 ; Legion 5
(RTX 4060) → rendu 46 / 46, IA 50 / 50 ; Zenbook S 16 → développement 84 / 89.

## 5. Diagnostic, réparabilité, évolutivité, perf/prix (spécification)

Ces scores ne sont pas encore codés dans le moteur ; ils suivent la même philosophie (règles explicites,
raisons affichées) :

- **Réparabilité (0–10)** : indice de réparabilité français si présent (`repairability.french_index`),
  sinon 5 + 2 si SSD remplaçable + 1,5 si batterie accessible (vis standard) − 2 si RAM soudée + 1 si
  manuel de maintenance public + 0,5 si pièces détachées ≥ 5 ans ; borné à [0, 10] ; score iFixit
  connu → moyenne des deux.
- **Évolutivité (0–10)** : portables : +3 par emplacement RAM libre (max 6), +2 si M.2 libre, +1 si Wi-Fi
  sur M.2, +1 si RAM max ≥ 2 × installée ; fixes : +2 plateforme à longue vie (AM5, LGA1851), +2 M.2
  libre, +2 alimentation avec ≥ 200 W de marge, +2 emplacement PCIe ×16 libre / longueur GPU ≥ 320 mm,
  +2 RAM max ≥ 128 Go.
- **Forces / faiblesses** : liste de règles (RAM < 16 Go, simple canal, 60 Hz, sRGB < 90 %, batterie
  < 50 Wh avec CPU 45 W, GPU/CPU déséquilibrés : `|ln(indice_gpu/indice_cpu_jeu × 1,3)| > 0,5`…).
- **Perf/prix** : `(0,5 × indice_gpu + 0,3 × indice_cpu_jeu + 0,2 × mémoire_stockage) / prix × 1000`,
  comparé à la médiane de la catégorie (portable gaming, ultraportable, fixe…).

## 6. Exécuter et étendre

```bash
cd pc-analyzer
npm ci                           # une seule fois
npm test                         # moteur : 44 tests, < 1 s
npm run typecheck
npm run db:check                 # migration + seed rejoués dans PGlite, matching trigramme vérifié
```

Ajouter un composant : une entrée `components` + `linux_support` (+ `cpu_specs`/`gpu_specs`, alias,
problèmes connus). Ajouter un jeu : `games` + `game_proton_status` + au moins un banc Windows 1080p.
Ajouter une distribution : une ligne `distributions`. Aucun code à modifier : tout est donnée.
