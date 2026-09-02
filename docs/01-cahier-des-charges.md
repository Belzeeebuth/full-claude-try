# 01 — Cahier des charges

> Document de référence fonctionnel de **Harvester**. Il décrit *ce que* le bot
> fait et *pourquoi*. Le *comment* est dans [02 — Architecture](./02-architecture.md).
> Les chiffres de ce document sont ceux du code au moment de sa relecture :
> `src/config/gameplay/*.json` pour le contenu, `src/commands/*.ts` pour les
> commandes, `src/jobs/definitions.ts` pour les tâches. Une exigence de la
> conception initiale qui n'est pas dans le code est marquée **non livré** et
> renvoie à la [roadmap](./06-roadmap.md) plutôt que d'être passée sous silence.

---

## 1. Positionnement

Harvester est un jeu de gestion de ferme persistant joué **entièrement dans
Discord**, via commandes slash et composants interactifs. Il ne remplace pas
Stardew Valley : il occupe une niche différente, celle du **jeu d'attente**
(*idle / incremental*) sociable, où chaque session dure deux à cinq minutes et où
la valeur vient de la régularité et de la communauté, pas de la dextérité.

### 1.1 Les cinq piliers, et ce qu'ils impliquent concrètement

| Pilier | Conséquence de conception, non négociable |
|---|---|
| **Aucun pay-to-win** | Les gemmes 💎 s'obtiennent **uniquement** par le jeu (paliers de niveau, quêtes, succès, votes, série quotidienne, passe saisonnier, parrainage). Aucune boutique monétaire n'existe dans le code, et aucun point d'entrée n'est prévu pour en ajouter. La piste « premium » du passe saisonnier se débloque en **votant** pour le bot, jamais en payant. |
| **Sessions courtes et fréquentes** | Toute action utile doit tenir en **une commande**. Les cultures de départ poussent en 5 à 15 minutes ; les cycles longs (vanille 6 h, arbre-monde 36 h) sont réservés au joueur qui revient deux fois par jour. |
| **Économie fermée** | Chaque source de pièces (*faucet*) a un puits (*sink*) correspondant. Le grand livre est vérifié toutes les heures, et son invariant est `users.coins = solde d'ouverture du dernier checkpoint + SUM(transactions.amount) postérieures` par joueur (§ 7 et [03 § 1.5](./03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture)). |
| **Coopération encouragée** | Aider un autre fermier rapporte **aux deux**. Les coopératives donnent des bonus passifs à tous leurs membres. Aucun mécanisme n'oppose les joueurs entre eux, hors classements cosmétiques. |
| **Le monde change sans le joueur** | Météo quotidienne, saisons, boutique et marché noir tournants, marché horaire, passe saisonnier, prévision payante de l'almanach, événements calendaires récurrents (§ 3.8). |

### 1.2 Boucle de jeu

```
 semer ──► attendre ──► entretenir ──► récolter ──► transformer ──► vendre
   ▲          (arroser, désherber,      (qualité,       (recettes,     (marché,
   │           traiter, fertiliser)      mutations)      valeur ×2)     HDV, PNJ)
   │                                                                       │
   └───────────────── réinvestir (graines, parcelles, animaux, bâtiments) ◄─┘
                                          │
                              XP ──► niveau ──► déblocages
```

Trois horizons temporels se superposent délibérément :

- **court** (5–30 min) : planter, arroser, récolter, nourrir, pêcher, miner ;
- **moyen** (quelques heures) : transformation, enchères, quêtes journalières,
  contrats ;
- **long** (jours/semaines) : parcelles, bâtiments, coopérative, passe,
  collection, prestige.

C'est cette superposition qui rend le jeu supportable à des rythmes de connexion
très différents : le joueur qui passe cinq fois par jour et celui qui passe une
fois progressent tous les deux, à des vitesses différentes mais sans mur.

---

## 2. Ferme globale ou ferme par serveur ? — décision et justification

**Décision retenue : une ferme globale par compte Discord.**

C'est la question de conception la plus structurante du projet, parce qu'elle
détermine la clé primaire de tout le modèle de données. Elle a été tranchée ainsi :

### Ce que donnerait une ferme par serveur

- ✅ Chaque communauté a « sa » économie, ses classements, sa culture de jeu.
- ✅ Un serveur qui installe le bot part d'une page blanche : pas de joueur
  niveau 55 qui écrase les nouveaux au classement dès le premier jour.
- ❌ **La progression est détruite par un changement de serveur.** Or les serveurs
  Discord meurent : un joueur qui a investi 40 heures peut tout perdre parce qu'un
  administrateur a fermé le salon. C'est rédhibitoire pour un jeu de progression longue.
- ❌ Le multi-comptage devient trivial : le même joueur cumule N fermes et croise
  les ressources vers celle qu'il veut faire monter.
- ❌ L'hôtel des ventes et les échanges perdent leur intérêt sur les petits serveurs
  (dix joueurs ne font pas un marché liquide).
- ❌ La table `users` explose en `users × guilds`, et chaque job (météo, marché,
  pousse) doit s'exécuter par serveur.

### Ce que donne la ferme globale — retenu

- ✅ La progression suit le joueur, partout. C'est la promesse implicite d'un jeu
  de ferme : *ma* ferme.
- ✅ Un seul marché, donc de la liquidité : l'hôtel des ventes fonctionne dès le
  premier millier de joueurs.
- ✅ Un seul jeu de tâches planifiées, quelle que soit la taille du parc de serveurs.
- ✅ Le modèle de données reste simple : `users.discord_id` est unique (parmi les
  comptes non supprimés), point.

### Ce qui reste local au serveur — le compromis

Le grief légitime de la ferme globale est social : « le classement mondial ne me
parle pas ». On le traite sans casser le modèle :

- **`/leaderboard` a une option `scope`** : `global` (par défaut) montre le
  classement mondial ; `discord` filtre sur les joueurs vus dans le serveur
  courant ; `coop` classe au sein de la coopérative. Sept types de classement
  (`wealth`, `level`, `harvests`, `animals`, `crafts`, `weekly_xp`, `coop_score`).
- **Les coopératives sont indépendantes des serveurs.** Un groupe d'amis répartis
  sur cinq serveurs joue ensemble ; un serveur peut aussi créer sa coopérative
  maison.
- **`guild_settings`** stocke ce qui est légitimement propre au serveur : langue
  par défaut, salons (annonces, marché, événements, **rappels** et taille de lot),
  commandes désactivées, rôles administrateurs.
- Les **classements hebdomadaires figés** (`leaderboard_snapshots`, job
  `leaderboard:weekly`, chaque lundi) couvrent quatre types (`wealth`, `level`,
  `harvests`, `weekly_xp`) en portée **mondiale** uniquement ; les portées
  serveur et coopérative sont calculées à la demande.

> **Conséquence technique.** `users.discord_id` est la seule identité. Aucune table
> de gameplay ne référence un serveur Discord, à deux exceptions près et
> assumées : `guild_settings` (configuration du serveur) et `users.last_guild_id`
> (dernier serveur vu, qui désigne le salon destinataire des rappels — § 3.10).
> Les instantanés de classement portent un `scope_id`, `global` aujourd'hui.
> Cette contrainte est vérifiée par revue de schéma : introduire un `guild_id`
> dans une table de gameplay reviendrait à revenir sur la décision.

---

## 3. Périmètre fonctionnel

### 3.1 Profil et progression

**Création par `/start`.** Le compte est créé par `/start [code]` — et par cette
commande seulement (`createIfMissing` n'est vrai que pour elle dans
`src/events/interaction-create.ts`) — en **une seule transaction**
(`src/services/player.service.ts`, `createPlayer`) : utilisateur, réglages,
ferme, les **64 lignes de parcelles** (9 débloquées, 55 `locked`), le kit de
départ, les bâtiments initiaux, le compagnon de niveau 1 et le lien de
parrainage éventuel. Les autres commandes répondent « vous n'avez pas encore de
ferme » à un inconnu, sauf les commandes de consultation déclarées
`requiresAccount: false` (`/help`, `/tutorial`, `/crops`, `/item`,
`/encyclopedia`, `/weather`, `/season`, `/event`), qui reçoivent un contexte
« invité ». Le compte est créé **avant** la réponse : `/start` est déféré
avant la construction du contexte (`deferBeforeContext`, [02 § 3](./02-architecture.md#3-flux-dune-interaction)).

**Courbe d'XP.** `xpToNext(n) = ⌊60 · n^1,45 + 40 · n⌋` (`balance.progression.xpCurve`).
Exposant volontairement inférieur à 1,5 : la courbe accélère sans jamais doubler
d'un niveau à l'autre. Niveau 60 = 615 942 XP cumulés (voir [04 § 5.1](./04-equilibrage.md#51-courbe-dxp--60--n145--40--n)).

**Récompenses de palier.** Chaque niveau verse des pièces croissantes avec le
niveau (`balance.progression.levelRewardCoins`), et tous les 5 niveaux (`milestoneLevels`, de 5 à 60) :
5 gemmes, plus les déblocages associés (cultures, animaux, bâtiments, recettes,
compagnons, fonctionnalités : pêche au 18, mine au 22, marché noir au 30). Un
niveau ne débloque **jamais rien de purement cosmétique en remplacement** d'un
contenu attendu : la montée de niveau doit toujours ouvrir une option de jeu — un
test de contenu (`tests/content-crops.test.ts`) refuse plus de 7 niveaux
consécutifs sans déblocage de culture.

**Statistiques.** Onze compteurs portés par `users` (`total_harvests`,
`total_planted`, `total_coins_earned`, `total_coins_spent`,
`total_animals_raised`, `total_crafts`, `total_watered`, `total_help_given`,
`best_harvest_value`, `commands_used`, `playtime_seconds`), complétés à
l'affichage de `/stats` par des agrégats (animaux vivants et élevés, série en
cours et record, rangs de classement, inventaire, prestige). Il n'existe pas de
table `player_stats` séparée.

**Prestige.** Disponible au **niveau 60** (niveau maximum, `progression.maxLevel`).
Remet à zéro niveau, XP, énergie, cultures en terre et animaux ; efface
l'inventaire **sauf** les catégories `cosmetic`, `tool` et `event` ; conserve
**50 % des parcelles** débloquées (jamais moins que les 9 de départ), **tous les
bâtiments**, les gemmes, et **5 % des pièces** plus un forfait de **5 000 🪙**
(`startingCoinsAfterPrestige`) et un kit de renaissance, pour ne jamais
repartir sans rien. Ne sont pas
touchés, donc conservés : la banque, les succès, le titre et les badges, les
statistiques, la coopérative, les compagnons. Accorde un bonus permanent
cumulatif de **+15 % par rang** (20 rangs maximum, ×4 au rang 20), des points de
prestige (100 + 10 par niveau au-delà de 60) et des étoiles à côté du pseudo. Le
plan exact est **prévisualisé** (`planPrestige`, fonction pure) puis confirmé par
un bouton dédié (`prestige:confirm`), sous verrou `prestige` et avec un cooldown
de 24 h (`cooldowns.prestige`) : c'est l'action la plus destructrice du jeu, et
la ligne de journal `prestige_reset` enregistre la variation de solde. La
confirmation par modal de saisie exacte (« écrire PRESTIGE ») prévue à l'origine
n'est **pas** ce qui est livré.

**Titres et badges.** Un seul titre équipé à la fois (`users.title`), affiché sur
la carte de profil ; les badges s'accumulent (`users.badges`). La configuration
définit **24 titres** (16 par succès, 3 par le passe saisonnier, 5 par
événements) et **7 badges** (succès). Ils sont **attribués automatiquement** à
la validation du succès ou du palier ; aucune commande ne permet d'en changer.

**Personnalisation — non livré, voir [06](./06-roadmap.md).** Ni renommage de
ferme, ni couleur d'accent, ni biographie n'existent en commande (les colonnes
`farms.name`, `farms.banner_color` et `users.profile_color` gardent leur valeur
par défaut). Ce qui existe : cinq objets cosmétiques (`theme_autumn`,
`theme_winter`, `theme_neon`, `banner_sunset`, `banner_starry`) qui, consommés
par `/use`, changent `users.profile_theme`, c'est-à-dire la bannière de la carte
de profil.

### 3.2 Parcelles

- Grille de **9 (3×3) à 64 (8×8)** parcelles, par 11 paliers de forme
  (`balance.plots.gridSteps` : 3×3, 4×3, 4×4, 5×4, 5×5, 6×5, 6×6, 7×6, 7×7, 8×7,
  8×8). La grille affichée s'adapte au nombre de parcelles possédées ;
  `slotToCoords` (`src/game/grid.ts`) garantit une bijection stable.
- **Coût exponentiel** : `800 × 1,155^n`, arrondi à la dizaine. De la 10ᵉ à la
  64ᵉ parcelle : **14 276 110 🪙** cumulés — le principal puits monétaire de la
  partie longue ([04 § 5.2](./04-equilibrage.md#52-coût-des-parcelles--800--1155n)).
- **États** (`plot_state`) : `locked`, `empty`, `planted`, `growing`, `ready`,
  `withered`.
- **Fertilité 0–100 par parcelle**, 70 au départ. Chaque récolte consomme
  `fertilityCost` de la culture ; les engrais (4 niveaux) et la jachère
  (+1,5/h) la restaurent. Sous 30 (`lowThreshold`), le rendement chute
  nettement (−45 % à zéro, +15 % à 100) : c'est ce qui empêche la monoculture
  d'une seule culture rentable en boucle infinie.
- **Irrigation.** Un arrosage par cycle de pousse est requis (fenêtre de grâce de
  20 minutes, pénalité de 8 % par arrosage manqué, plafonnée à 40 %). Le
  bâtiment **Puits** (`well`, niveau 8, 3 niveaux) arrose automatiquement 40 %,
  70 % puis 100 % des parcelles : il ne supprime pas le besoin d'arroser, il
  supprime le besoin d'être présent — ce qui est exactement ce qu'un joueur veut
  acheter. La pluie, l'orage et la neige arrosent gratuitement.
- **Nuisibles aléatoires** (`crows`, `insects`, `fungus`, `mole`) avec
  **échéance** de 8 heures : un nuisible non traité (`/treat`) inflige −50 % de
  rendement, et 15 % de chance de flétrissement. Le job `farm:pests` (toutes
  les 2 h) les fait apparaître selon la météo et prévient le joueur ; le job
  `farm:pest-consequences` (2 h, décalé de 30 min) applique les conséquences.
  L'appât répulsif (`pest_bait`) et la serre (dégâts météo −50 % puis −100 %)
  protègent.
- **Mauvaises herbes** : apparition passive (+2,5/h), pénalité de rendement
  au-delà de 30 ; `/weed` les retire et produit 3 unités de l'objet `weeds`
  (matériau), compostables à l'atelier — recette `fertilizer_basic`
  (« Compost ») : 8 herbes + 2 blés → 2 engrais simples, marge volontairement
  ramenée à 1,67× parce que l'intrant est gratuit
  ([04 § 4](./04-equilibrage.md#4-transformation--49-recettes)).

### 3.3 Cultures — 41 espèces

Chaque culture porte : nom (fr/en), emoji, silhouette et palette de rendu
(`form`, `palette`), rareté, prix de graine, durée de pousse, rendement de base,
prix de vente, niveau requis, saisons favorables, multiplicateur de qualité,
besoins en eau, coût de fertilité, XP, éventuelles repousses (`regrowCycles`,
12 cultures) et probabilité de mutation (1,2 % à 5 %).

Raretés en **paliers stricts** de niveau : 7 communes, 8 peu communes, 9 rares,
8 épiques, 5 légendaires, 4 mythiques. Progression : blé, carotte, oignon
(5–10 min, niveau 1) → pomme de terre, laitue, maïs, ail, tomate, concombre,
fraise, petits pois (niveaux 2–6) → aubergine, brocoli, poivron, piment, melon,
tournesol, patate douce, pastèque, myrtille, citrouille, houblon, raisin,
kiwi (7–16) → thé, café, rose, cacao, lavande, olive, vanille, mandarine (17–25)
→ ginseng, sakura, truffe, safran, bambou (28–39) → fruit du dragon, rose des
glaces, lotus étoilé, arbre-monde (42–55). Liste complète et chiffres dans
[04 § 2](./04-equilibrage.md#2-cultures--41-espèces).

**Qualités.** `normal` → `silver` (×1,35) → `gold` (×1,9) → `iridium` (×3). La
distribution suit un modèle à exposants : `P(argent) ∝ score`, `P(or) ∝ score²`,
`P(iridium) ∝ score³`, où `score` agrège fertilité (×0,6), niveau (×0,004 par
niveau), engrais et bonus (plafonnés à +0,6). Un débutant voit 0,9 % d'iridium,
un joueur optimisé de fin de partie 18 % ([04 § 6.1](./04-equilibrage.md#61-distribution-de-qualité)) :
la qualité est une récompense d'investissement, pas une loterie.

**Mutations rares** — `giant` (×2,5 rendement), `rainbow` (×3 valeur), `ancient`
(×1,5 rendement et ×2 valeur), tirées aux poids 55/28/8 : très faible
probabilité, indépendante de la qualité. Elles existent pour créer l'anecdote
qu'on raconte dans le salon — et elles sont **distinguables sur l'image**.

**Grainerie** (`seed_maker`, niveau 14) : à la récolte, une probabilité de
récupérer des graines de la culture récoltée — 25 %, 45 % puis 70 % selon le
niveau du bâtiment. Elle réduit le coût récurrent des cultures sans jamais le
supprimer (le taux est calibré sous 100 % : les graines restent un puits).

### 3.4 Animaux — 24 espèces

Poule, oie, canard, lapin, cochon d'Inde, mouton, dinde, chèvre, âne, abeille,
vache, cochon, ver à soie, tortue, alpaga, yack, autruche, cerf, cheval, cygne,
paon, licorne, dragonnet, phénix — 5 communes, 6 peu communes, 4 rares,
4 épiques, 3 légendaires, 2 mythiques. Chaque espèce a **un produit propre** de
même rareté, suivi par le marché ([04 § 3](./04-equilibrage.md#3-animaux--24-espèces)).
Le dragonnet ne s'obtient que par événement (`eventOnly`) ; le phénix coûte
300 gemmes — le seul débouché **premium** de l'Antre.

**Trois jauges** par animal — faim, bonheur, santé (0–100) — plus l'âge
(`born_at`, durée de vie par espèce). Elles ne sont **pas** mises à jour par un
tick : elles sont projetées au moment de la lecture (`projectAnimal`,
`src/game/animals.ts`) depuis `stats_updated_at`, `last_fed_at`,
`last_petted_at`, puis matérialisées toutes les 3 heures par le job
`animals:decay` (qui déclenche maladies et décès).

- **Nourrir** : consomme l'aliment de l'espèce (`feed_grain`, `feed_hay`,
  `feed_premium`, pollen), remonte la faim de 45 points. Sous 25 de faim, la
  production s'arrête (et le rendement est divisé par deux).
- **Caresser** : +12 de bonheur, une fois par heure. Le bonheur module le
  rendement et la probabilité de produit de qualité (+15 % au maximum).
- **Soigner** : un soin vétérinaire (500 🪙 + 120 par niveau) remonte la santé
  et guérit la maladie, qui survient après 24 h de faim ; la mort après 96 h.
- **Reproduction** (`/breed`) : deux animaux adultes, sains et heureux de la
  même espèce produisent un petit (75 % de réussite, 1 200 🪙, cooldown par
  espèce). C'est la seule manière d'obtenir certains animaux sans les acheter.
- **Variantes** (`balance.animals.variants`) : à l'achat et à la naissance, une
  bête est **shiny** (2 %) ou **dorée** (0,2 %), probabilités multipliées par
  un poids de rareté (×1 commun → ×3 mythique). Un parent shiny transmet dans
  35 % des cas, deux parents dans 60 % ; la dorée ne se transmet **jamais** et
  ne naît jamais d'une portée — elle se trouve. Effets volontairement modestes
  (shiny : qualité argent une collecte sur deux ; dorée : production ×2 et
  revente ×3, soit 1,8× l'achat : l'achat-revente reste perdant). Voir
  [04 § 3.1](./04-equilibrage.md#31-variantes--shiny-et-dorée).
- **Capacité limitée par bâtiment** : poulailler (`coop`), enclos (`pen`),
  étable (`barn`), rucher (`apiary`), Antre (`mythic_pen`, niveau 40). Acheter
  un animal sans place libre échoue avec un message explicite.
- **Vente** : 60 % du prix, modulé par la santé (×3 pour une dorée).
- **Mort et improductivité.** Un animal négligé tombe malade, cesse de produire,
  puis meurt. **Un avertissement en message privé est envoyé si et seulement si
  le joueur a activé les notifications** (`settings.dm_notifications`,
  désactivé par défaut, et `settings.notify_animals`).

### 3.5 Inventaire

Paginé, filtrable par catégorie (`item_category` : graines, récoltes, produits
animaux, produits transformés, outils, consommables, matériaux, cosmétiques,
objets d'événement, poissons, minerais). **Capacité limitée** par l'entrepôt
(`farms.warehouse_capacity`, 306 au départ), extensible par les 5 niveaux du
bâtiment **Entrepôt** — un puits monétaire, et une pression douce à vendre plutôt
qu'à thésauriser. La borne s'applique à tout ce que le joueur **produit**
(récoltes, collectes, artisanat, pêche, mine), par la porte d'entrée unique
`addItems` (`src/services/inventory.service.ts`).

Les objets sont stockés par `(user, item, qualité, mutation)` : le même blé en
qualité or et en qualité normale sont deux lignes distinctes, empilables
séparément. `mutation` est `NOT NULL DEFAULT 'none'` précisément pour que la
contrainte d'unicité fonctionne (un `NULL` casserait l'unicité en PostgreSQL).

**150 objets explicites** dans `items.json` (48 produits, 24 produits animaux,
17 consommables, 17 poissons, 16 minerais, 13 matériaux, 6 outils,
5 cosmétiques, 4 objets d'événement), plus les 82 graines et récoltes
**dérivées** des 41 cultures par le chargeur — jamais écrites à la main.

**Consommables (17)** : engrais simple, de qualité, suprême et mythique ;
arrosoir magique ; parchemin d'expérience ; potion de croissance ; sablier du
fermier ; ticket de chance ; trèfle à quatre feuilles ; appât répulsif ; charme
d'épouvantail ; traitement bio ; jus et élixir d'énergie ; gel de série ; jeton
de relance de quête ([04 § 4.1](./04-equilibrage.md#41-consommables--17)).

### 3.6 Transformation — 8 ateliers, 49 recettes

Moulin (3 recettes), atelier (11), confiturerie (11), fromagerie (5), brasserie
(4), presse à huile (6), fumoir (4), confiserie (5). Avec les 5 bâtiments
d'élevage et les 5 utilitaires (entrepôt, maison, puits, grainerie, serre) :
**18 bâtiments** au total, chacun avec 1 à 5 niveaux d'amélioration.

Chaque atelier a un **nombre limité de slots de production**
(`farms.crafting_slots`), extensible par amélioration. Une recette occupe un slot
pendant sa durée, puis le produit attend d'être collecté (`/production`). La marge
est calibrée entre **2,0× et 2,2×** la valeur des ingrédients : transformer vaut
toujours mieux que vendre brut, mais coûte du temps et de l'attente — c'est
l'arbitrage central de la partie moyenne.

La marge est bornée par un test automatisé (`tests/config-and-balance.test.ts`) :
une recette dont la marge sortirait de l'intervalle **1,2× – 2,4×** fait échouer
la CI. C'est ainsi qu'a été détecté et corrigé le cas du compost, qui part de
mauvaises herbes gratuites et constituait un robinet monétaire pur : c'est la
seule recette sous 2× (1,67×), délibérément. `tests/content-recipes.test.ts`
fige par ailleurs que chaque culture et chaque produit animal a un débouché.

### 3.7 Économie

**Deux monnaies.** Pièces 🪙 (BIGINT, jamais de flottant) pour tout le jeu ;
gemmes 💎 pour les raccourcis de confort (recharge d'énergie à 15 💎, phénix,
dragonnet). Les gemmes ne s'achètent pas.

**Marché dynamique.** Prix recalculés **toutes les heures** par le job
`market:update`, selon la pression offre/demande accumulée depuis la dernière
mise à jour (`src/game/market.ts`) :

```
targetDemand = 2 / (1 + pression)      pression > 1 ⇒ cible < 1 ⇒ prix baisse
prix ← lissage(prix, prixBase × targetDemand) × (1 + bruit)
prix ← clamp(prix, plancher, plafond)   volume ← volume × décroissance
```

Le plancher et le plafond (**55 %–180 %** du prix de base) sont **durs** :
ils garantissent qu'aucune stratégie de manipulation ne peut ni effondrer un prix
à zéro ni le faire exploser. L'historique est conservé 30 jours et affiché en
graphique par `/market-history`. À la fin de chaque mise à jour, les **alertes de
prix** sont évaluées.

**Alertes de prix** (`/alert create|list|delete`) : « préviens-moi quand {objet}
passe au-dessus ou en dessous de {seuil} ». 5 alertes par joueur, 14 jours, seuil
borné aux limites réelles du marché ; une alerte ne crée ni ne détruit rien.
Message privé si `notify_market`, webhook `price_alert`.

**Boutique du jour.** Rotation quotidienne déterministe (job `shop:rotate` à
00:05 UTC, RNG *seedée* sur la date et `WORLD_SEED`), donc identique sur tous les
*shards* sans coordination. 6 emplacements, remises aléatoires (30 % de chance,
10 à 40 %).

**Marché noir** (`/black-market`, niveau 30) : 3 emplacements de produits rares
à 6× le prix de vente, stock de 1 à 2 unités, une seule unité par joueur et par
article (`shop_purchases`).

**Hôtel des ventes.** Annonces à prix fixe ou aux enchères, durée 6/12/24/48 h,
8 annonces actives au plus, frais de mise en vente **non remboursables** (2 %,
minimum 25 🪙) et commission à la vente (5 %). Prolongation anti-*snipe* de
5 minutes. Les mises perdantes sont remboursées automatiquement par le job
`auctions:expire` toutes les 5 minutes. Les frais sont le puits ; les
remboursements garantissent qu'enchérir n'est jamais un piège.

**Ordres d'achat permanents** (`/order create|list|cancel`) : « achète {X}
{objet} à {Y} 🪙 maximum l'unité », rapprochés des annonces actives par le même
job, 5 ordres actifs, 72 h, débit tenté au moment du rapprochement (l'ordre
reste actif si les fonds manquent).

**Échanges directs.** `/trade @joueur` (niveau 5) ouvre une session de
10 minutes : chaque partie ajoute objets (8 au plus) et pièces (5 000 000 au
plus) via un menu déroulant et des modals de quantité, puis **les deux** doivent
confirmer par bouton. Toute modification après confirmation **réinitialise les
deux confirmations** — c'est la protection standard contre l'arnaque au dernier
moment (rejouée par `tests/integration/trade-revision.test.ts`). Taxe de 2 % sur
les pièces échangées.

**Banque.** Dépôt, retrait, intérêts quotidiens (job `bank:interest`, 03:00 UTC,
0,5 % à 1 % par jour plafonnés par niveau), 6 niveaux de coffre relevant le
plafond de dépôt (50 000 → 100 000 000 🪙). Elle sert à la fois de puits
temporaire et de protection : les pièces en banque ne sont pas touchées par un
prestige.

**Dons.** `/gift` (niveau 5) : taxe de 5 %, plafond de 50 000 🪙 par jour.

**Historique.** `/history [type] [days] [page]` — « où sont passées mes
pièces ? » : lecture seule du journal `transactions`, neuf familles de types,
fenêtres 1/7/30/90 jours, contrepartie nommée.

**Puits monétaires** (récapitulatif exhaustif dans [04 § 7](./04-equilibrage.md#7-puits-monétaires-et-vérification-anti-exploitation)) :
taxe de vente 3 % (à partir du niveau 5), décote de vente directe 15 %,
commission HDV 5 %, frais de mise en vente 2 %, taxe sur les dons 5 %, taxe
d'échange 2 %, parcelles, bâtiments, graines, nourriture, soins vétérinaires,
reproduction, relances de quête, almanach, création de coopérative (25 000 🪙),
recharge d'énergie en gemmes.

### 3.8 Quêtes, événements et monde

- **Journalières** : 4 par jour (`quests.dailyCount`), tirées d'un pool de 24
  pondéré par niveau. **Relance payante** à coût doublant (500 🪙, puis 1 000,
  2 000), 3 par jour au plus ; le jeton de relance (`quest_reroll_token`)
  l'évite.
- **Hebdomadaires** : 3 par semaine, dans un pool de 8, réinitialisées le lundi.
- **Chaîne narrative** : 12 quêtes d'histoire (`story_village_*`) qui
  accompagnent les déblocages et servent de tutoriel implicite.
- **Contrats de livraison** : 3 actifs par jour, dans un pool de 8 — demandes
  précises (objet, quantité, qualité minimale) contre récompenses supérieures
  au prix de marché.
- **Succès** : 34, en 8 catégories (agriculture, domaine, élevage, artisanat,
  économie, progression, fidélité, social), dont 6 de collection ; 23 versent
  des gemmes, 16 un titre, 7 un badge.
- **Collection** (`/collection [kind] [page]`) : cultures, produits, animaux,
  poissons, minerais et variantes rares découverts, entrées inconnues masquées
  « ??? », enregistrement sous *savepoint* (une découverte qui échoue ne coûte
  jamais une récolte).
- **Passe saisonnier** : 30 paliers, 500 points par palier gagnés par le jeu
  normal ; piste gratuite plus une piste « premium » débloquée par un **vote**
  top.gg (jamais par un paiement). Un seul passe configuré (`season-pass.json`),
  daté.
- **Événements temporaires.** Six événements sont configurés (`events.json` :
  moisson d'automne, marché de Noël, fête du printemps, sécheresse, week-end
  doublé, réveil du dragon) avec bannière, modificateurs et paliers de
  récompense ; le suivi de points (`user_events`) existe. Les cinq premiers
  reviennent par `recurringCron` + `durationHours` ; le sixième
  (`dragon_awakening`), sans cron ni dates, est **permanent**.

  La fenêtre d'un événement récurrent est **calculée à la lecture**
  (`currentEventWindow`, `src/game/events.ts`) : dernière occurrence du cron à
  ou avant l'instant demandé, plus la durée. Aucun état, aucune écriture, donc
  le même résultat sur tous les shards. Le calcul se fait en UTC, comme toutes
  les cadences du projet.

  Jusqu'à la revue finale, `getActiveEvents` attendait qu'une fenêtre
  `startsAt`/`endsAt` soit écrite **dans la configuration** — un fichier JSON en
  lecture seule que personne n'écrivait : cinq événements sur six ne se sont
  jamais déclenchés, sans erreur nulle part. Le schéma exige désormais
  `durationHours` dès qu'un `recurringCron` est posé, et un test vérifie que
  chaque événement récurrent est actif au moins un jour dans l'année.

  | Événement | Départ (UTC) | Durée | Jours actifs par an |
  |---|---|---|---|
  | Fête du printemps | 20 mars | 240 h | 10 |
  | Sécheresse | 5 juillet | 120 h | 5 |
  | Moisson d'automne | 1er octobre | 336 h | 14 |
  | Marché de Noël | 10 décembre | 384 h | 16 |
  | Week-end doublé | vendredi 18 h | 54 h | 104 |

  Reste non livré : le déclenchement manuel d'un événement (`/admin`), utile
  pour une opération exceptionnelle — voir [06](./06-roadmap.md).
- **Saisons** : printemps, été, automne, hiver, sur un cycle réel configurable
  (`SEASON_LENGTH_DAYS`, 14 jours par défaut). En saison : +20 % de rendement ;
  hors saison : −35 % de rendement et −25 % de vitesse (−10 % de plus en
  hiver). Planter hors saison est possible mais moins rentable ; la serre
  (`greenhouse`, niveau 24) immunise.
- **Météo quotidienne** tirée de façon déterministe (`WORLD_SEED`, identique
  sur tous les *shards*) parmi sept types — grand soleil, nuageux, pluie, orage,
  canicule, gel, neige — pondérés par saison : modifie pousse, rendement,
  arrosage, dégâts et nuisibles. La pluie arrose gratuitement toutes les
  parcelles — la météo est donc une raison de se connecter pour vérifier.
- **Almanach** (`/almanac`) : la météo d'aujourd'hui gratuite, la prévision
  **exacte** de demain (même tirage que le job de minuit UTC) contre
  `150 + 12 × niveau` 🪙 — un puits monétaire pur et thématique.

### 3.9 Social

- **Coopératives** : création au niveau 10 pour 25 000 🪙 ; 10 membres au
  niveau 1, +2 par niveau, **50 au plus** ; 3 rôles (`owner`, `officer`,
  `member`) ; trésorerie commune journalisée (`guild_treasury_log`, immuable) ;
  niveau collectif (30 au plus, XP par contributions et objectifs) ; bonus
  passifs pour tous les membres — pousse +0,4 %, vente +0,3 %, XP +0,4 %,
  qualité +0,2 % par niveau, soit ~10 % au maximum ([04 § 6.2](./04-equilibrage.md#62-bonus-de-coopérative)).
  Cooldown de 24 h après un départ.
- **Objectifs de coopérative** : 3 hebdomadaires et 1 **défi quotidien**,
  tirés de gabarits (`COOP_OBJECTIVE_TEMPLATES`), récompenses en pièces et XP de
  coopérative distribuées automatiquement par le job `coop:objectives` toutes
  les 15 minutes — jamais de gemmes.
- **Classements** : richesse, niveau, récoltes, élevage, artisanat, XP de la
  semaine, score de coopérative ; portées `global` / `discord` / `coop` ;
  instantanés hebdomadaires figés ; image avec podium.
- **Visites et entraide** : `/visit @joueur` affiche la ferme d'autrui (image)
  et rapporte 120 🪙 et 15 XP au visiteur ; `/assist @joueur` **arrose** les
  parcelles qui en ont besoin chez l'hôte (10 aides par jour, 200 🪙 et 25 XP
  pour l'aidant, +3 % de rendement par aidant pour l'hôte jusqu'à +12 %). Une
  seule visite récompensée par jour et par couple (`farm_visits`), contre le
  farming entre comptes complices. L'entraide ne désherbe pas.
- **Parrainage** : code unique, récompenses aux deux parties quand le filleul
  atteint le **niveau 10** (5 000 🪙 et 10 💎 au parrain ; 1 500 🪙 de bonus de
  départ au filleul) — et non à l'inscription, ce qui empêche la ferme à comptes
  jetables. Un *trigger* SQL (`users_referral_loop_guard`) empêche les boucles
  de parrainage.
- **Carte postale** (`/postcard [caption]`) : image **publique** de sa ferme,
  légende de 60 caractères nettoyée, timbre et cachet daté, pièces masquées si le
  profil est privé ; un envoi toutes les 10 minutes.

### 3.10 Rétention

- **Série quotidienne** (`/daily`) : 250 🪙 + 60 par jour de série (bonus
  plafonné à 2 400), 60 XP + 15 par jour, 3 gemmes tous les 7 jours, objet
  bonus dans 35 % des cas ; tolérance de **30 heures** entre deux réclamations
  (`streakGraceHours`) pour ne pas punir un décalage horaire, et jetons de gel
  de série consommés automatiquement en cas d'absence.
- **Notifications privées opt-in** (`settings.dm_notifications`, désactivé par
  défaut) : récolte prête, nuisible, animal affamé ou malade, production
  terminée, enchère vendue/remportée/surenchérie, échange, objectif de
  coopérative, ordre exécuté, alerte de prix, rappel quotidien — réglables par
  famille (`notify_crops`, `notify_animals`, `notify_energy`, `notify_market`,
  `notify_coop`, `daily_reminder`), 12 par jour au plus. Des MP fermés (erreur
  Discord 50007) désactivent l'option d'eux-mêmes.
- **Rappels en salon** : un gestionnaire du serveur désigne un salon
  (`/server reminders channel:#salon [every:N]`), le joueur s'y inscrit
  (`/settings channel-reminders:true`) — **double opt-in** avant toute mention
  publique. Un message par salon et par lot, 20 joueurs mentionnés au plus,
  retour automatique aux MP si le salon disparaît.
- **File de notifications** : la table `notifications` (`deliver_at`,
  `dedupe_key`) est alimentée par les jobs et vidée par un worker qui tourne sur
  chaque *shard* (réservation `FOR UPDATE SKIP LOCKED`), à 4 envois par
  seconde — les rappels partent au bon moment, pas par sondage du joueur.
- **Système d'énergie** (`ENERGY_SYSTEM_ENABLED`, **activé par défaut**) :
  100 points au départ (jusqu'à 220 avec les 4 niveaux de la Maison),
  régénération de 1 par
  minute, coût par action (1 à 5), recharge à 15 💎. Il borne le nombre
  d'actions par session pour éviter l'abattage en boucle, et se désactive
  entièrement en passant la variable à `false`, sans autre changement.
- **Récompenses de vote top.gg** : 5 💎 et 1 500 🪙 par vote (×2 le week-end,
  bonus de série), toutes les 12 h, créditées par le webhook entrant
  `POST /api/v1/topgg` ; le vote débloque la piste premium du passe.
- **Compagnons** (`/companion list|equip|unequip`) : 8 compagnons cosmétiques
  débloqués par niveau, affichés sur l'image de ferme.

### 3.11 Administration

`/admin` (réservé aux `BOT_OWNER_IDS`) : `give` / `take` (écriture
compensatoire au journal), `reset`, `eco-ban`, `maintenance`, `announce`
(modal), `reload-config` (propagé à tous les *shards*), `stats` (économie,
inflation, jobs), `lookup` (journal d'audit d'un joueur), `market-update`
(force le marché et l'évaluation des alertes).

`/server reminders|status` est réservé aux membres ayant la permission **Gérer
le serveur**, revérifiée à l'exécution.

**Bannissement économique** : un joueur banni conserve l'accès aux commandes de
lecture (`ECO_BAN_READONLY`, `src/framework/interaction.ts` : aide, profil,
statistiques, réglages, langue, encyclopédies, succès, classement, monde,
historique, almanach, collection, compte RGPD) ; toute action — composants compris — est
refusée.

**Toute action admin est journalisée** dans `audit_logs`, table rendue immuable
par un *trigger* PostgreSQL (`reject_mutation`) : ni `UPDATE` ni `DELETE` ne
sont possibles, y compris pour l'application. Même chose pour
`guild_treasury_log`. `transactions` a sa propre garde
(`reject_ledger_mutation`) : `UPDATE` interdit sans exception, `DELETE` accepté
uniquement de la purge de rétention annoncée par `SET LOCAL` (§ 7).

### 3.12 Compte et RGPD

`/account export` produit un JSON éphémère de tout ce que le bot conserve
(listes de champs explicites, garde anti-secret, 8 Mo, une fois par heure) ;
`/account delete` anonymise le compte en **une transaction** après
confirmation (bouton valable 15 minutes), refusée tant qu'il reste des
annonces actives, des échanges en cours ou la direction d'une coopérative. Le
journal comptable est conservé (il n'identifie personne) ; les deux actions
laissent une trace `account_export` / `account_delete` dans `audit_logs`. Ce
qui est effacé et ce qui reste : [03 § 1.4](./03-base-de-donnees.md#14-suppression-logique).

### 3.13 Pêche et mine

- **Pêche** (`/fish`, niveau 18) : minijeu de timing en **une** interaction
  (fenêtre de 3 s comparée en horodatages absolus, donc insensible à la latence
  Discord) ; 17 espèces filtrées par niveau, saison et moment de la journée ; la
  précision du ferrage pilote la qualité de la prise. État de ferrage en Redis,
  aucune table.
- **Mine** (`/mine`, niveau 22) : profondeur qui ne recule jamais (table
  `mine_progress`), plafonnée par une formule du niveau (20 paliers au plus) ;
  16 minerais filtrés par profondeur, débouchés en recettes d'atelier.

### 3.14 Intégrations

Clés d'API personnelles (`/apikey create|list|revoke`, 3 par joueur, hachées
SHA-256), API REST en lecture (`GET /api/v1/me`, `GET /api/v1/me/coop`,
60 requêtes par minute par clé), webhooks sortants signés HMAC-SHA256
(`/webhook create|list|delete|test`, 3 par joueur, évènements `crop_ready`,
`auction_won`, `price_alert`, livrés chaque minute par le job
`webhooks:dispatch`). Détail dans [07 — API publique](./07-api-publique.md).

---

## 4. Commandes

**74 commandes slash** et **2 menus contextuels**, dans 25 fichiers de
`src/commands/` chargés dynamiquement, **tous implémentés**. Rôle de chacune
dans le [README § 8](../README.md#8-commandes).

| Fichier | Commandes |
|---|---|
| `start.ts` | `/start [code]`, `/tutorial`, `/help [category]` |
| `account.ts` | `/account export\|delete` |
| `language.ts` | `/lang [language]` |
| `profile.ts` | `/profile`, `/stats`, `/balance`, `/settings`, `/prestige` |
| `farm.ts` | `/farm`, `/plant`, `/harvest`, `/water`, `/fertilize`, `/weed`, `/treat`, `/plots`, `/buy-plot`, `/crops` |
| `fishing.ts` | `/fish` |
| `mining.ts` | `/mine` |
| `animals.ts` | `/animals`, `/buy-animal`, `/feed`, `/collect`, `/heal`, `/pet`, `/breed`, `/sell-animal` |
| `economy.ts` | `/shop`, `/buy`, `/sell`, `/market`, `/market-history`, `/inventory`, `/item`, `/use`, `/discard`, `/bank balance\|deposit\|withdraw\|upgrade`, `/gift` |
| `blackmarket.ts` | `/black-market` |
| `alerts.ts` | `/alert create\|list\|delete` |
| `history.ts` | `/history [type] [days] [page]` |
| `almanac.ts` | `/almanac` |
| `craft.ts` | `/craft`, `/recipes`, `/production`, `/buildings [build]` |
| `progression.ts` | `/quests`, `/reroll-quest`, `/achievements`, `/pass`, `/daily`, `/vote` |
| `collection.ts` | `/collection [kind] [page]` |
| `companion.ts` | `/companion list\|equip\|unequip` |
| `social.ts` | `/coop create\|join\|leave\|info\|members\|invite\|kick\|promote\|treasury\|contribute\|objectives`, `/leaderboard [type] [scope]`, `/visit`, `/assist`, `/referral` |
| `postcard.ts` | `/postcard [caption]` |
| `trade.ts` | `/auction list\|sell\|buy\|my-listings\|cancel`, `/trade <user>`, `/order create\|list\|cancel` |
| `world.ts` | `/weather`, `/season`, `/event`, `/encyclopedia <term>` |
| `server.ts` | `/server reminders\|status` |
| `admin.ts` | `/admin give\|take\|reset\|eco-ban\|maintenance\|announce\|reload-config\|stats\|lookup\|market-update` |
| `integrations.ts` | `/apikey create\|list\|revoke`, `/webhook create\|list\|delete\|test` |
| `context-menus.ts` | **View farm**, **Propose a trade** (clic droit sur un membre) |

Toutes les options d'objet, de culture, d'animal, de recette et de compagnon
utilisent l'**autocomplétion** filtrée par ce que le joueur possède réellement —
pas la liste complète du jeu — et dans la langue du joueur. Les descriptions
publiées à Discord sont en anglais ; l'interface est traduite (§ 7, i18n).

---

## 5. Composants interactifs

**Boutons** : actions rapides contextuelles (récolter tout, arroser tout,
désherber tout, nourrir tout, collecter tout, menu de plantation), pagination
`⏮️ ◀️ ▶️ ⏭️` (`paginationRow`), confirmation pour toute action destructive
(prestige, suppression de compte), navigation par onglets, rafraîchissement,
ferrage de la pêche, achat d'almanach, pages de collection et d'historique.

**Menus déroulants** (`StringSelect` uniquement) : catégorie d'inventaire, achat
en boutique, graphique de marché, graine à planter, animal à caresser, bâtiment
à améliorer, quête à relancer, coopérative à rejoindre, annonce HDV à acheter,
catégorie d'aide, objet à offrir dans un échange. Les cibles « joueur » et
« salon » passent par des **options de commande** (`/trade <user>`,
`/server reminders channel:`), pas par `UserSelect` ou `ChannelSelect`.

**Modals** (6) : quantité d'achat en boutique, création de coopérative,
contribution à la trésorerie, quantité de pièces et d'objets dans un échange,
annonce administrateur.

**Identifiants structurés** : `namespace:action:ownerId:param1:param2`,
construits et analysés par `src/utils/custom-id.ts`. Longueur vérifiée à la
construction (limite Discord : 100 caractères). `ownerId = '0'` (`PUBLIC_OWNER`)
marque un composant public. `assertOwner` est appelé **avant toute action**, sauf
pour les gestionnaires qui déclarent `checkOwner: false` : un joueur ne peut pas
cliquer sur le bouton d'un autre.

**Sans collecteur.** Aucun composant ne dépend d'un `collector` en mémoire : les
gestionnaires sont résolus par `(namespace, action)` dans un registre chargé au
démarrage, ce qui les rend insensibles à un redémarrage ou à un changement de
*shard*. Un composant dont le gestionnaire n'existe plus reçoit « composant
expiré ». `deferUpdate()` est systématique avant tout traitement long ; les
messages qui n'intéressent que le joueur sont éphémères (`replyEphemeral`,
`followUpEphemeral`).

**Anti-double-clic** : verrou Redis par `(utilisateur, action)` autour de toute
exécution — commande (`cmd:<nom>`) comme composant (`lockKey` du gestionnaire) —
plus idempotence côté base (contraintes uniques, vérification d'état sous verrou
de ligne). Un double clic ne récolte jamais deux fois
(`tests/integration/harvest-concurrency.test.ts`).

---

## 6. Rendu graphique

Non négociable, et traité comme tel. Huit images, chacune avec sa fonction de
**texte alternatif** (`describeX()`, ≤ 1 024 caractères, fr/en) jointe à la
pièce Discord pour les lecteurs d'écran :

| Image | Commande | Contenu |
|---|---|---|
| **Vue de ferme** | `/farm`, `/visit`, menu contextuel | Grille de parcelles vue de dessus, état et stade de chaque culture, mutations distinguables, sol épuisé craquelé, badges (prêt / à arroser / nuisible / herbes), bandeau joueur avec avatar Discord, compagnon, barre de niveau, météo, saison, monnaies |
| **Carte de profil** | `/profile` | Bannière encodant le prestige, anneau de niveau, titre, XP, énergie, monnaies, statistiques clés, badges, coopérative |
| **Graphique de marché** | `/market-history` | Courbe d'historique de prix, min/max, référence, tendance |
| **Carte de classement** | `/leaderboard` | Podium avec médailles et avatars, rangs 4 à 10, ligne « votre rang » |
| **Étang** | `/fish` | Scène de pêche selon saison et météo |
| **Puits de mine** | `/mine` | Coupe verticale, strates, filons par rareté, paliers verrouillés |
| **Basse-cour** | `/animals` | Un enclos par bâtiment, 24 bêtes visibles au plus, pastilles seulement si une action est possible, variantes signalées |
| **Carte postale** | `/postcard` | Tirage presque carré de la ferme, timbre, cachet daté, légende |

Contraintes respectées : dessin dans des **threads dédiés** (`RENDER_WORKERS`,
2 par défaut) pour ne jamais bloquer la passerelle Discord ; cache **Redis**
indexé sur le hash SHA-1 de l'état rendu (locale comprise), TTL 120 s ;
budget de 4 s puis **repli automatique en embed texte** (le rendu tardif
alimente tout de même le cache) ; file bornée sous saturation ; `/settings
compact-mode:true` supprime les images. Poids mesuré sur les 38 PNG de `out/`
produits par `render:preview` et `render:matrix` : de 25 Ko (graphique sans
historique) à 432 Ko (ferme 8×8), loin de la limite Discord ; une image de plus
de 2 Mo n'est pas mise en cache. Palette tenue au contraste WCAG (4,5:1 texte,
3:1 grands chiffres) par `tests/render-contrast.test.ts`. Les silhouettes et
palettes sont **procédurales** — aucun sprite n'est embarqué (dossiers
`assets/sprites/*` vides), des PNG déposés là sont utilisés en priorité. Pipeline
documenté en [05](./05-pipeline-assets.md).

---

## 7. Exigences non fonctionnelles

| Domaine | Exigence |
|---|---|
| **Intégrité économique** | Transaction SQL + `SELECT … FOR UPDATE` sur **toute** opération touchant un solde. Écriture systématique au grand livre dans la même transaction. |
| **Journal comptable** | `transactions` est immuable en `UPDATE` et **purgeable** : le job mensuel `ledger:checkpoint` fige par joueur et par monnaie un solde d'ouverture **dérivé du journal** (jamais recopié de `users`), contrôlé sous verrou de la ligne joueur ; l'invariant vérifié chaque heure devient `solde = ouverture + Σ écritures postérieures à la borne du dernier checkpoint`. La purge nocturne n'efface que ce qu'un checkpoint de plus de 12 mois couvre, jamais pour un joueur en écart, et le `DELETE` doit s'annoncer par `SET LOCAL harvester.ledger_purge` pour passer le *trigger*. Le journal reste la source de vérité par (checkpoint d'ouverture + somme depuis). Détail : [03 § 1.5](./03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture). |
| **Contraintes** | 102 `CHECK` en base ([03](./03-base-de-donnees.md)) ; un solde négatif est impossible même si le code se trompe. |
| **Anti-triche** | Validation exclusivement côté serveur, RNG *seedée* pour la météo, la boutique et le marché noir (`WORLD_SEED`, secret d'instance), détection d'anomalies économiques avec score de suspicion et sanctions graduées (avertissement 50, revue 120, bannissement automatique 250), journaux immuables, limite d'achat par joueur au marché noir, plafond de dons, une aide récompensée par jour et par couple. |
| **Performance** | Pousse, jauges animales et énergie calculées à la lecture (aucun tick global). Coût O(1) par joueur actif au lieu de millions d'écritures par minute. Rendu hors du thread principal. |
| **Montée en charge** | `ShardingManager` (`src/shard.ts`, profil compose `sharded`) ; jobs BullMQ dédupliqués entre *shards* ; notifications réservées par `claimed_by`. **Limite connue** : chaque *shard* ouvre `HTTP_PORT`, le profil shardé n'est sûr qu'avec `SHARDING_TOTAL=1` ([06 — dette technique](./06-roadmap.md#dette-technique-à-traiter-en-priorité)). |
| **Résilience** | Gestion d'erreurs centralisée, salon d'erreurs privé dédoublonné, arrêt propre sur SIGTERM, `/health` vérifiant Discord **et** PostgreSQL (Redis rapporté, non bloquant : cache, verrous et cooldowns ont un repli mémoire). |
| **Sécurité** | Aucun secret en dur, validation Zod de l'environnement au démarrage (échec immédiat si invalide) et de toute entrée utilisateur, limitation de débit (30 commandes/min, 600/h) et cooldowns, TLS PostgreSQL vérifié, filtre anti-SSRF des webhooks avec adresse épinglée, `/metrics` protégeable par jeton, image Docker non privilégiée. |
| **Accessibilité** | Texte alternatif sur chaque image, contraste WCAG testé, mode texte intégral. |
| **RGPD** | `/account export` et `/account delete` sans passer par un administrateur ; suppression logique, journal conservé, preuve dans `audit_logs`. |
| **i18n** | Interface **française et anglaise** (`/lang`, `/settings language`, locale Discord par défaut), contenu de jeu **bilingue**. Chaque entrée de `src/config/gameplay/` porte `name`/`description` et `nameEn`/`descriptionEn` ; le chargeur construit une variante complète par langue (`getConfig(locale)`), donc aucun point d'affichage n'a à résoudre la langue lui-même. Catalogue `src/i18n/locales/{fr,en}.json` plus un fragment par fonctionnalité, fusionnés au chargement ; un test refuse une entrée sans traduction. Un message posté dans un salon partagé est rédigé dans la langue du **serveur**. |
| **Configuration** | Tout l'équilibrage vit dans 10 JSON rechargeables à chaud (`/admin reload-config`, propagé à tous les *shards*) ; une configuration invalide est **rejetée** et l'ancienne conservée. Validation Zod avec références croisées. |
| **Tests** | 494 tests rapides en 23 fichiers, sans aucune infrastructure (logique de jeu pure, cohérence de configuration et de contenu, rendu, texte alternatif, contraste, métriques, journal) — seuil de couverture 70 % sur `src/game/**`, `src/utils/**` et `src/config/index.ts` — plus 38 tests d'intégration en 11 fichiers (`tests/integration/`, base partagée ou Testcontainers) pour les garanties qu'une base en mémoire ne peut pas prouver : non-duplication d'une récolte concurrente, remboursement d'enchère, révision d'échange, capacité d'entrepôt, rétention du journal. CI GitHub Actions (`verify` et `integration`). |
| **Observabilité** | Journaux structurés (Pino), `/health`, `/ready`, `/metrics` (erreurs par code, latences par commande et par composant, pool de rendu, économie), instantanés économiques horaires, tableau Grafana `ops/grafana/`. |

---

## 8. Hors périmètre

Explicitement non livré, pour éviter l'ambiguïté : minijeux temps réel exigeant
de la dextérité, mariage/PNJ romançables, décoration libre de la ferme, PNJ du
village avec affection, tableau de bord web, saisons compétitives,
multi-fermes, monétisation, ainsi que — parmi les exigences de ce document —
le déclenchement manuel d'un événement et la personnalisation du profil
(§ 3.1, § 3.8). La pêche, la mine, l'API publique et les webhooks, prévus hors
v1, **sont livrés** (§ 3.13, § 3.14). Ces éléments sont positionnés dans la
[roadmap](./06-roadmap.md).
