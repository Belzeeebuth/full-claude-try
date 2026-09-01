# 06 — Roadmap d'extension

> Ce qui n'est **pas** dans la v1, dans quel ordre l'ajouter, et ce que chaque
> ajout coûte réellement en travail. Le classement suit le rapport
> valeur-joueur / effort, pas l'enthousiasme.

---

## v1 — Livré

Boucle complète semer → entretenir → récolter → transformer → vendre → réinvestir ;
27 cultures, 13 animaux, 32 recettes, 18 bâtiments ; économie fermée avec marché
dynamique, hôtel des ventes, échanges P2P et banque ; quêtes, succès, passe
saisonnier, saisons, météo, événements ; coopératives, classements, visites,
entraide, parrainage ; ~70 commandes ; rendu graphique complet ; 48 tables ;
administration et anti-triche.

---

## v2 — « Le monde s'élargit »

Objectif : donner des choses à faire à un joueur de niveau 40+ qui a déjà tout
débloqué, sans allonger artificiellement les courbes.

### v2.1 — Pêche et mine — ✅ Livré

Deux nouvelles boucles courtes qui utilisent l'infrastructure existante (qualité →
même modèle que les récoltes). Le gros du travail a été du contenu et du rendu, pas
de l'architecture — confirmé à l'implémentation.

- **Pêche** (`/fish`) : étang débloqué au niveau 18, 11 espèces de poissons filtrées
  par niveau, saison et jour/nuit (la météo précise n'a finalement pas servi de
  filtre — simplification assumée, la saison et le moment de la journée suffisent à
  faire vivre le vivier). Minijeu de timing via bouton (fenêtre de 3 s comparée en
  timestamps absolus, donc insensible à la latence Discord), **une seule**
  interaction, compatible avec la contrainte de session courte. La précision du
  ferrage pilote la qualité de la prise (réutilise les poids globaux de qualité).
- **Mine** (`/mine`) : profondeur qui ne recule jamais, plafonnée par une **formule**
  du niveau du joueur (pas de table à 20 paliers à maintenir à la main) ; 11
  minerais/gemmes bruts filtrés par profondeur minimale. Alimente une recette
  d'atelier existante (lingot de mithril, consomme le minerai miné).
- **Impact base réel** : une seule table, `mine_progress` (profondeur par joueur).
  La pêche n'en a nécessité aucune : l'état de ferrage, éphémère et sans valeur
  d'audit, vit en Redis avec un TTL court — même logique que les boosts de
  `/use`. Deux nouvelles catégories d'objets (`fish`, `ore`), aucune migration
  destructive.
- **Rendu** : scène d'étang (pêche) et coupe verticale du puits avec règle de
  profondeur (mine), toutes deux via le pipeline de rendu existant
  (cache Redis par état, repli procédural, budget de 4 s).
- **Effort estimé initial** : 3 à 4 semaines.

### v2.2 — Décoration libre de la ferme

Le rendu isométrique existe déjà ; il s'agit d'ajouter une couche de placement.

- Placement libre d'objets décoratifs sur les cases inutilisées, via menus + boutons
  directionnels (pas de glisser-déposer, impossible dans Discord).
- Petits bonus de zone (une mangeoire améliore le bonheur des animaux voisins), pour
  que la décoration ne soit pas purement cosmétique.
- Thèmes de ferme complets, déblocables par le passe saisonnier.
- **Impact base** : 2 tables (`decorations`, `owned_decorations`).
- **Effort** : 2 à 3 semaines, dont l'essentiel en assets.

### v2.3 — PNJ du village et affection

- 8 villageois avec dialogues, préférences de cadeaux, et niveaux d'affection.
- Débloquent recettes, remises permanentes, et contrats de livraison exclusifs.
- **Pas de romance ni de mariage** : le rapport intérêt/travail est mauvais et les
  attentes que ça crée sont difficiles à satisfaire dans une interface Discord.
- **Impact base** : 2 tables (`villagers_config`, `villager_relations`).
- **Effort** : 2 semaines.

### v2.4 — Marché noir et contrebande — ✅ Livré

- Boutique tournante à contenu rare, prix élevés, stock très limité, accessible aux
  niveaux élevés.
- Un **puits monétaire supplémentaire** dont le besoin apparaîtra quand les joueurs
  de fin de partie auront terminé les parcelles : c'est la vraie raison d'être de la
  fonctionnalité.
- **Impact base** : réutilise `shop_stock` avec un discriminant (`category =
  'black_market'`), aucune migration de table nécessaire.
- **Implémentation retenue** : `/black-market`, alimenté par
  `rotateBlackMarket()`/`getBlackMarket()` dans `market.service.ts`, rotation
  quotidienne dans le job `shop:rotate`. Contenu tiré des objets `product` et
  `animal_product` déjà existants de rareté épique et au-delà (aucun nouvel
  objet créé), prix = `sellPrice × blackMarket.priceMultiplier` (config
  `balance.blackMarket`), niveau 30 minimum, stock 1-2 unités, achat via le
  `/buy` générique.
- **Effort** : 1 semaine.

### v2.5 — Compétitions de coopératives

- Tournois hebdomadaires entre coopératives sur un objectif tiré au sort.
- Classement dédié, récompenses cosmétiques et bannière de coopérative.
- **Effort** : 2 semaines. Dépend d'une base de coopératives actives suffisante —
  à ne pas livrer trop tôt.

### v2.6 — Défi quotidien, ordres permanents et accessibilité — ✅ Livré

Trois ajouts ponctuels, hors plan initial, choisis pour leur rapport
effort/valeur plutôt que pour suivre l'ordre de cette liste.

- **Défi communautaire quotidien** (coopératives) : même mécanique que les
  objectifs hebdomadaires existants (`guild_objectives`), avec une cadence
  quotidienne — une colonne `period` distingue les deux, des clés `daily_*`
  distinctes évitent toute collision. Volontairement scopé à la coopérative et
  non au serveur Discord : le cahier des charges interdit explicitement
  d'introduire un `guild_id` (serveur) dans une table de gameplay, décision
  structurante liée au choix de la ferme globale. Récompenses en pièces et XP
  de coopérative uniquement, jamais de gemmes — un gain quotidien répété
  7×/semaine serait une source de monnaie premium bien plus généreuse qu'un
  objectif hebdomadaire.
- **Ordres d'achat permanents** (`/order create|list|cancel`) : « achète {X}
  {objet} à {Y} 🪙 maximum l'unité », rapproché contre les annonces actives de
  l'hôtel des ventes par le job `auctions:expire` existant (toutes les 5 min).
  Construit sur l'hôtel des ventes entre joueurs, pas sur le marché fluctuant :
  ce dernier n'a pas de côté achat aujourd'hui (`/sell` uniquement), et lui en
  inventer un aurait ouvert un puits d'objets sans plafond. Aucun fonds
  réservés à la création : le rapprochement tente le débit au moment du match
  et laisse simplement l'ordre actif si les fonds manquent.
- **Mode texte intégral** (`/settings compact-mode`) : le réglage existait déjà
  de bout en bout (colonne, option Discord, ligne d'affichage) mais rien ne le
  lisait — toutes les commandes à image généraient quand même leur PNG. Les six
  points d'appel (`renderFarmImage`, `renderProfileImage`,
  `renderChartImage`, `renderLeaderboardImage`, `renderFishingImage`,
  `renderMiningImage`) court-circuitent désormais le rendu et vont directement
  au repli texte déjà prévu à chaque appelant — un vrai gain d'accessibilité,
  pas seulement un repli technique en cas d'échec.
- **Impact base** : 1 table (`standing_orders`), 1 colonne (`period` sur
  `guild_objectives`), 2 valeurs d'énumération (`coop_objective_period`,
  `notification_type.order_filled`).

### v2.7 — Compagnons de ferme — ✅ Livré

Fonctionnalité cosmétique pure, ajoutée hors plan initial : aucun bonus de
jeu, aucune nouvelle monnaie ni jauge à équilibrer, juste une collection à
débloquer.

- **Catalogue** (`game/pets.ts`) : 8 compagnons (poussin → bébé dragon),
  chacun avec un niveau de déblocage, en tableau TypeScript plutôt qu'en
  table `*_config` — même choix que les gabarits d'objectifs de coopérative
  (`COOP_OBJECTIVE_TEMPLATES`) : la clé référencée (`owned_pets.pet_key`,
  `users.equipped_pet_key`) reste un `varchar` sans clé étrangère, validé
  côté service.
- **Déblocage automatique** : accroché à `grantXp()` (chaque montée de
  niveau débloque les compagnons nouvellement atteints, idempotent via
  `onConflictDoNothing`) et à la création de compte pour le compagnon de
  niveau 1 — pas de commande « réclamer », le compagnon apparaît directement
  dans `/companion list` dès le niveau atteint.
- **Commande** `/companion list|equip|unequip` : liste avec statut
  verrouillé/débloqué/équipé, équipement soumis à la possession réelle
  (`owned_pets`), autocomplétion limitée aux compagnons déjà débloqués.
  `/pet` était déjà pris par `/animals` (caresser un animal), d'où le nom
  distinct.
- **Rendu** : badge rond superposé au coin de l'avatar sur `/farm`. Comme
  pour les tuiles/cultures/animaux, un sprite `pets/<clé>.png` optionnel est
  tenté en premier ; à défaut, repli procédural (`drawPetIcon`) — silhouette
  générique teintée par espèce, cohérente avec le reste du travail de
  polish vectoriel de la v2.6.
- **Impact base** : 1 table (`owned_pets`), 1 colonne
  (`users.equipped_pet_key`), sans clé étrangère sur la clé de compagnon.

---

## v3 — « La plateforme »

Objectif : sortir du seul client Discord et industrialiser l'exploitation.

### v3.1 — Tableau de bord web

- Next.js + OAuth2 Discord, lecture seule au départ : ferme, statistiques,
  graphiques d'historique, classements.
- Puis écriture pour les actions non urgentes (planification de production,
  gestion de coopérative, mise en vente).
- **Réutilise intégralement `src/services/`** — c'est précisément ce que la
  séparation stricte commandes → services → repositories rendait possible. Le travail
  se limite à une couche HTTP et à l'interface.
- **Effort** : 6 à 8 semaines.

### v3.2 — API publique et webhooks — ✅ Livré

- **API REST en lecture** : `GET /api/v1/me` (profil et statistiques) et
  `GET /api/v1/me/coop` (coopérative du titulaire, 404 s'il n'en a pas), sur le
  même serveur HTTP que `/health` et `/metrics` (`src/http/api.ts`), sans
  framework supplémentaire. Un endpoint `/api/v1/leaderboard` a été envisagé puis
  écarté : le texte de la roadmap ne demandait que les statistiques de joueur et
  de coopérative, et les classements existants n'avaient pas de forme stable à
  publier sans travail de conception supplémentaire — à reconsidérer si la
  demande se confirme.
- **Authentification et débit** : clés personnelles (`/apikey create|list|revoke`),
  jamais stockées en clair (hachage SHA-256 — une clé à haute entropie n'a pas
  besoin d'un KDF lent type bcrypt), secret affiché une seule fois à la création.
  Limitation de débit par clé via `consumeRate()`, le même mécanisme de fenêtre
  glissante que les commandes Discord (`balance.api.rateLimitPerMinute`).
- **Webhooks sortants** (`/webhook create|list|delete|test`) pour `crop_ready` et
  `auction_won`, signés HMAC-SHA256 (en-tête `X-Harvester-Signature`, à vérifier
  côté récepteur). Un évènement de jeu ne fait jamais un appel HTTP synchrone :
  il écrit une ligne dans `webhook_events` au sein de la **même transaction** que
  l'action qui le déclenche, et un job planifié (`webhooks:dispatch`, chaque
  minute) livre en tentative unique — la fiabilité vient de la désactivation
  automatique d'un abonnement en échec répété (`webhookMaxFailures`), pas d'une
  reprise avec attente exponentielle qui retarderait la livraison à un tiers.
- **Effet de bord utile** : en câblant `auction_won`, la notification MP du
  vendeur (`auction_sold`) et celle du gagnant (`auction_won`) ont été branchées
  au passage — le type `auction_sold` existait déjà dans l'énumération mais
  n'était encore déclenché par aucun code.
- **Impact base** : 3 tables (`api_keys`, `webhook_subscriptions`,
  `webhook_events`), 1 valeur d'énumération ajoutée
  (`notification_type.auction_won`).
- **Documentation dédiée** : [07 — API publique](./07-api-publique.md), destinée
  aux intégrateurs tiers (authentification, endpoints, format des webhooks,
  vérification de signature).
- **Effort estimé initial** : 3 semaines.

### v3.3 — Saisons compétitives

- Cycles de 3 mois avec classement figé, récompenses exclusives, et remise à zéro
  **partielle** optionnelle (le joueur choisit d'y participer ou non).
- C'est le mécanisme de rétention long terme qui manque à la v1, mais il ne peut
  être calibré qu'avec des données réelles de rétention — d'où sa position tardive.
- **Effort** : 4 semaines.

### v3.4 — Multi-fermes et automatisation

- Une seconde ferme déblocable très haut niveau, avec sa propre spécialisation.
- Contremaître : automatisation partielle et payante (arrosage, collecte) — un puits
  monétaire récurrent qui achète du confort, jamais de la puissance.
- **Attention** : c'est la fonctionnalité qui menace le plus le pilier « sessions
  courtes ». À n'ajouter que si les données montrent une frustration réelle de
  micro-gestion chez les joueurs de fin de partie.
- **Effort** : 5 semaines.

### v3.5 — Internationalisation complète

- Anglais, espagnol, allemand, portugais. La structure existe déjà
  (`src/i18n/locales/`) ; le travail est de la traduction et de la relecture, plus
  la localisation des noms de cultures et d'objets.
- Détection automatique depuis la langue du serveur Discord.
- **Effort** : 2 semaines de développement, plus le temps de traduction.

---

## Dette technique à traiter en priorité

Indépendamment des fonctionnalités, à faire avant toute v2 significative :

1. **Tests d'intégration sur base réelle — ✅ Fait.** `tests/integration/` (suite
   dédiée, `npm run test:integration`, séparée des 125 tests rapides qui ne
   nécessitent aucune infrastructure) démarre de vrais conteneurs PostgreSQL et
   Redis via Testcontainers et vérifie que deux `/harvest` simultanés sur la
   même parcelle n'en produisent qu'une — la garantie qui ne peut être
   honnêtement prouvée que contre une vraie base (verrou `SELECT ... FOR
   UPDATE`, isolation `read committed`), jamais par un mock. La logique a été
   validée manuellement contre un PostgreSQL/Redis locaux (résultat : exactement
   une récolte aboutit, l'autre échoue avec `crop_not_ready`, l'inventaire ne
   compte que la récolte gagnante) ; l'environnement de développement qui a
   produit ce commit n'avait pas de démon Docker accessible pour exécuter la
   suite Testcontainers elle-même de bout en bout — à confirmer au premier
   `npm run test:integration` sur une machine avec Docker.
2. **Métriques Prometheus économiques — ✅ Fait.** `/metrics` exposait déjà des
   compteurs techniques au format Prometheus ; il expose maintenant aussi la masse
   monétaire, le ratio création/destruction de pièces, les écarts de journal
   comptable et le nombre de joueurs suspects, dérivés de l'instantané horaire
   existant (`economy:snapshot`) — de quoi brancher un Grafana pour une détection
   d'anomalies visuelle plutôt que journalisée.
3. **Partitionnement des tables de journaux.** `transactions` et
   `market_price_history` croissent linéairement avec l'activité. Un partitionnement
   par mois deviendra nécessaire vers 10 millions de lignes.
4. **Cache mémoire L1 devant Redis.** Les configurations de gameplay sont relues à
   chaque requête depuis la mémoire du processus (déjà en cache), mais les données
   de monde (météo, saison) font un aller-retour Redis systématique. Un cache local
   de 60 s économiserait l'essentiel de ce trafic.
5. **Sprites — toujours pas livré, mais repli amélioré.** Aucun sprite dédié ne
   peut être ajouté sans assets sous licence claire (voir
   [05 — Pipeline d'assets](./05-pipeline-assets.md)) ; ça reste le meilleur
   rapport effort/impact perçu de toute cette liste dès qu'ils existeront. En
   attendant, le rendu procédural de repli a été enrichi (dégradés sur pièces,
   gemmes, fruits, sol et avatars par défaut ; ombres portées sur les panneaux)
   pour paraître moins plat sans dépendre d'un seul pixel d'asset externe — et
   un vrai bug a été corrigé au passage : le graphique de marché dessinait
   l'emoji d'un objet directement en texte canvas, ce qui produisait des carrés
   « tofu » sans police d'emoji couleur.

---

## Ce qui restera hors périmètre

Décisions de conception, pas manques de temps :

- **Toute monétisation donnant un avantage de jeu.** Le pilier « aucun
  pay-to-win » n'est pas négociable. Un financement éventuel passerait par du
  cosmétique strict, et le code n'en prévoit délibérément aucun point d'entrée.
- **Combat PvP.** Le jeu est coopératif ; opposer les joueurs casserait la
  dynamique d'entraide, qui est ce qui le rend agréable en communauté.
- **Minijeux temps réel exigeant de la dextérité.** La latence de Discord les rend
  frustrants, et ils excluent une partie des joueurs.
- **Économie inter-serveurs cloisonnée.** Voir la décision « ferme globale » en
  [01 § 2](./01-cahier-des-charges.md#2-ferme-globale-ou-ferme-par-serveur--décision-et-justification).
