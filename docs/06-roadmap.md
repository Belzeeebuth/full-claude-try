# 06 — Roadmap d'extension

> Ce qui n'est **pas** dans la v1, dans quel ordre l'ajouter, et ce que chaque
> ajout coûte réellement en travail. Le classement suit le rapport
> valeur-joueur / effort, pas l'enthousiasme. Chaque entrée livrée (✅) dit ce
> qui a été **retenu** à l'implémentation, et ce qui a été écarté.

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

- **Pêche** (`/fish`) : étang débloqué au niveau 18, espèces filtrées par
  niveau, saison et jour/nuit (la météo précise n'a finalement pas servi de
  filtre — simplification assumée, la saison et le moment de la journée suffisent
  à faire vivre le vivier). Minijeu de timing via bouton (fenêtre de 3 s comparée
  en timestamps absolus, donc insensible à la latence Discord), **une seule**
  interaction, compatible avec la contrainte de session courte. La précision du
  ferrage pilote la qualité de la prise (réutilise les poids globaux de qualité).
  11 espèces à la livraison, **17** depuis la v2.8.
- **Mine** (`/mine`) : profondeur qui ne recule jamais, plafonnée par une **formule**
  du niveau du joueur (pas de table à 20 paliers à maintenir à la main) ;
  minerais et gemmes bruts filtrés par profondeur minimale — 11 à la livraison,
  **16** depuis la v2.8, sans écart de plus de trois galeries entre deux filons.
  Alimente une recette d'atelier existante (lingot de mithril, consomme le
  minerai miné).
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
  'black_market'`), aucune migration de table nécessaire — jusqu'à l'audit, qui
  a ajouté `shop_purchases` (migration 0011) : la limite « 1 par joueur » n'était
  comparée qu'à la quantité d'**un** achat et se contournait en achetant dix
  fois de suite.
- **Implémentation retenue** : `/black-market`, alimenté par
  `rotateBlackMarket()`/`getBlackMarket()` dans `market.service.ts`, rotation
  quotidienne dans le job `shop:rotate`. Contenu tiré des objets `product` et
  `animal_product` déjà existants de rareté épique et au-delà (aucun nouvel
  objet créé), prix = `sellPrice × blackMarket.priceMultiplier` (6, config
  `balance.blackMarket`), niveau 30 minimum, 3 emplacements, stock 1-2 unités,
  achat via le `/buy` générique.
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
  et laisse simplement l'ordre actif si les fonds manquent. L'audit a corrigé
  la faille la plus grave du projet à cet endroit (F-01 : un ordre annulé
  pouvait quand même débiter) et verrouille désormais l'ordre `FOR UPDATE`
  avant toute dépense ; le scénario d'intégration `standing-order-cancel`
  le rejoue.
- **Mode texte intégral** (`/settings compact-mode`) : le réglage existait déjà
  de bout en bout (colonne, option Discord, ligne d'affichage) mais rien ne le
  lisait — toutes les commandes à image généraient quand même leur PNG. Tous
  les points d'appel du rendu court-circuitent désormais l'image et vont
  directement au repli texte déjà prévu à chaque appelant — un vrai gain
  d'accessibilité, complété en v2.8 par le texte alternatif, qui permet de
  **garder** les images.
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
  générique teintée par espèce.
- **Impact base** : 1 table (`owned_pets`), 1 colonne
  (`users.equipped_pet_key`), sans clé étrangère sur la clé de compagnon.

### v2.8 — Contenu, variantes et vie sociale — ✅ Livré

Une livraison groupée, issue d'un **audit complet** du bot (18 constats
corrigés, dont deux de gravité haute) suivi de treize chantiers menés en
parallèle sur des périmètres disjoints. Le fil conducteur : donner à un joueur
de niveau 20 à 50 des raisons de revenir (contenu, collection, information) et
à l'exploitant les moyens de voir ce qui se passe (métriques, journal, carnet
d'incidents), sans toucher aux piliers — pas de pay-to-win, sessions courtes,
économie fermée.

**Audit et correctifs (F-01 → F-18, B, C, A, D).** Ordre permanent annulé qui
débitait quand même (F-01), parcelles achetées entre deux paliers invisibles
sur l'image (F-02), capacité d'entrepôt inerte parce que 21 des 22 appels à
`addItems` la contournaient (F-03), verrou Redis libéré par un `DEL`
inconditionnel (F-04), TLS PostgreSQL qui chiffrait sans authentifier (F-05),
création de compte hors du budget de 3 s (F-06), graine du monde en dur dans
le dépôt (F-07), seuil de couverture jamais appliqué (F-08), fenêtre de *DNS
rebinding* dans le filtre SSRF des webhooks (F-09), `/metrics` exposé avec
l'API (F-10), arrondis monétaires (F-11), commentaire anti-reroll inexact
(F-12), vote perdu sur échec de transaction (F-13), erreur éphémère affichée en
public (F-14), quota d'incidents consommé sans salon (F-16), README et mot de
passe compose (F-17, F-18). Les emoji « tofu » dans les images (pile de polices
absente de `ctx.font`) et un export `getWorldSeed` sans appelant ont été
corrigés dans la foulée. F-15 (rétention du journal) a été traité comme un
chantier à part entière — voir plus bas.

**Contenu (C1, C2, C3).**

- **14 cultures** (27 → 41) pour combler les trous : l'hiver était désert entre
  les niveaux 3 et 27, le printemps sans rare ni légendaire, l'automne sans
  épique, et huit niveaux sans déblocage. Méthode retenue : graine, prix et
  durée choisis pour que le revenu horaire s'intercale entre les voisines de
  niveau, série à récolte unique croissante, repousseuses à ROI 4–10×, raretés
  devenues des **paliers stricts** de niveau. Diff volontairement additif :
  aucune entrée existante modifiée (l'inversion `sortOrder` houblon/citrouille,
  laissée alors, a été corrigée à la revue finale). Objets graine et récolte
  dérivés, rien dans `items.json`.
- **11 animaux** (13 → 24) et silhouette + palette pour les 24 : oie, cochon
  d'Inde, dinde, âne, ver à soie, tortue, yack, cerf, cygne, licorne, phénix.
  Retenu : un produit propre par espèce, de même rareté, suivi par le marché ;
  une seule monnaie par espèce, gemmes réservées au mythique (le phénix est le
  débouché **premium** de l'Antre, le dragonnet reste une récompense
  d'événement) ; **aucun aliment nouveau** parce que la liste des fournitures
  du magasin est codée dans `market.service.ts` ; amortissement croissant avec
  le niveau (8,3 h → 37,8 h).
- **16 recettes, 16 produits, 5 consommables, 6 poissons, 5 minerais** : chaque
  nouvelle culture et chaque nouveau produit animal a un débouché, toutes les
  marges entre 2,06× et 2,09×, deux puits de fin de partie à 12 h (tapisserie
  de licorne, encens de phénix) pour les produits de l'Antre. Seule
  modification hors périmètre : les nouvelles clés dans `unlocksRecipes` des
  huit ateliers, exigées par `validateReferences`.
- **Contrat de contenu testé** : `tests/content-crops.test.ts`,
  `content-animals.test.ts`, `content-recipes.test.ts` (42 tests) figent ce
  que l'extension a comblé — un futur lot ne peut pas rouvrir un trou.
- **Déploiement** : aucune migration, mais `npm run db:seed:prod` obligatoire
  (clés étrangères vers `*_config`).

**Information et économie (E-01, E-02, S13).**

- `/history [type] [days] [page]` — « où sont passées mes pièces ? » : lecture
  seule du journal, neuf familles de types, fenêtres 1/7/30/90 jours, en-tête
  entrées/sorties/net, contrepartie nommée. Aucune table ni index ajoutés :
  `transactions_user_created_idx` suffit. Règle induite : tout nouveau
  `transaction_type` doit être classé dans `HISTORY_FAMILIES` et traduit, un
  test l'impose.
- `/alert create|list|delete` — le pendant **vendeur** des ordres permanents.
  Retenu : une alerte ne crée ni ne détruit rien (un vrai côté achat du marché
  ouvrirait un puits d'objets), seuil borné aux limites dures du marché avec
  les arrondis exacts d'`updatePrice`, évaluation à la fin de `market:update`
  sur `market_prices.current_price`, déclenchement idempotent (`UPDATE WHERE
  status = 'active'`), MP gardé par `settings.notify_market`, webhook
  `price_alert`. 5 alertes, 14 jours. Table `price_alerts` (0012).
- `/almanac` — aujourd'hui gratuit, **demain payant** (`150 + 12 × niveau` 🪙),
  prévision **exacte** (même tirage que le job de minuit UTC — une prévision
  approximative serait un produit trompeur), puits monétaire pur et
  thématique. Aucune table : mémorisation Redis avec repli sur le journal
  (`shop_purchase` / `almanac` / `metadata.day`).

**Rappels en salon (E-03).** `/server reminders channel:#salon [every:N]` par
un gestionnaire (permission « Gérer le serveur », revérifiée à l'exécution
parce qu'aucun pipeline n'applique `requiredPermissions`) et
`/settings channel-reminders:true` par le joueur — **double opt-in** avant de
mentionner qui que ce soit publiquement. Un message par salon et par lot
(`reminder_batch_minutes`, fenêtre Redis `SET NX PX` partagée entre shards),
20 joueurs mentionnés au plus, le reste reporté, `allowedMentions` restreint
(`parse: []`), retombée MP automatique quand le salon disparaît
(10003/50001/50013), message rédigé dans la langue du **serveur** puisqu'il est
partagé. Migration 0013.

**Variantes et collection (S4).** Shiny (2 %) et dorée (0,2 %), × poids de
rareté, uniquement à l'achat et à la naissance ; la dorée ne se transmet pas et
ne naît jamais — elle se trouve. Effets modestes (argent une collecte sur
deux ; ×2 production et ×3 revente, soit 1,8× l'achat sur 0,2 % des bêtes :
l'achat-revente reste perdant). `/collection [kind] [page]` confronte l'univers
de la configuration aux découvertes du joueur, entrées inconnues masquées
« ??? », six succès `discover_entry`. Enregistrement dans `addItems` sous
**savepoint** : une découverte qui échoue ne coûte jamais une récolte. Migration
0014 (`owned_animals.variant`, `discoveries`).

**Carte postale (S18).** `/postcard [caption]`, réponse **publique** (c'est le
but), cooldown 600 s, légende ≤ 60 caractères nettoyée, timbre = culture la plus
plantée, cachet daté dans le fuseau du fermier, pièces masquées si la ferme est
`private`. Retenu après examen des PNG : tirage presque carré, arbres en marge
d'une petite ferme, timbre réorganisé, signature qui réduit avant de couper.

**Rendu (R1, R2, C-01, C-03).** `/animals` a enfin son image (basse-cour par
enclos, pastilles seulement si actionnables, 24 bêtes puis « +N ») et le décor
partagé avec la ferme est sorti dans `scenery.ts`. Polish sans changer les
interfaces d'entrée : mutations distinguables, sol épuisé craquelé, décor de
saison, bannière de prestige, anneau de niveau, repères du graphique,
médailles, plans de l'étang, strates de la mine ; `render:matrix` couvre
désormais 26 images. **Texte alternatif** sur chaque pièce jointe (huit
`describeX()` purs, ≤ 1 024 caractères, fr/en) et **garde de contraste WCAG**
sur la palette (4,5:1 texte, 3:1 grands chiffres).

**RGPD (C-02).** `/account export` (JSON par listes de champs explicites, garde
anti-secret, 8 Mo, cooldown d'une heure posé par la sous-commande) et
`/account delete` (confirmation 15 min, blocages : annonces, échanges,
direction de coopérative ; suppression logique en une transaction, journal
conservé). Voir [03 § 1.4](./03-base-de-donnees.md#14-suppression-logique).

**Rétention du journal (D-02, F-15).** Soldes d'ouverture mensuels
(`ledger_checkpoints`), invariant reformulé « solde = ouverture + écritures
postérieures », purge nocturne bornée, *trigger* qui n'accepte un `DELETE`
qu'annoncé par `SET LOCAL`. Migration 0015. Voir
[03 § 1.5](./03-base-de-donnees.md#15-rétention-du-journal-comptable--soldes-douverture).

**Observabilité (B-01 → B-04).** `harvester_errors_total{code,kind}`,
`harvester_command_duration_seconds{command}` (seaux 0,05 → 10 s, 2,5 et 5
encadrant le budget Discord), `harvester_component_duration_seconds{namespace}`,
jauges du pool de rendu ; registre Prometheus maison sans dépendance,
cardinalité bornée à la source ; tableau Grafana `ops/grafana/`.

**Outillage (A-01 → A-05, D-01, D-03).** CI GitHub Actions (jobs `verify` et
`integration`), Dependabot hebdomadaire, `.dockerignore` aligné sur ce que le
`Dockerfile` copie, configuration ESLint avec règles maison (arrondi monétaire,
`allowOverflow` justifié, réponses via le framework), cinq scénarios
d'intégration Testcontainers supplémentaires, profil compose `sharded`, et ce
carnet d'incidents ([08 — Exploitation](./08-exploitation.md)).

- **Impact base** : migrations 0011 à 0015 — 4 tables (`shop_purchases`,
  `price_alerts`, `discoveries`, `ledger_checkpoints`), 5 colonnes
  (`plots.last_weeded_at`, `notifications.claimed_at/claimed_by`,
  `owned_animals.variant`, `guild_settings.reminder_channel_id/
  reminder_batch_minutes`, `settings.channel_reminders`), 4 types énumérés,
  2 valeurs d'énumération, une vue et un *trigger* réécrits. 48 tables en v1,
  58 aujourd'hui.
- **Tests** : 167 → 494 tests rapides (23 fichiers), 5 → 11 fichiers
  d'intégration.
- **Effort** : hors plan initial ; l'ordre a suivi les constats de l'audit.

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
  `auction_won` — et `price_alert` depuis la v2.8 —, signés HMAC-SHA256 (en-tête
  `X-Harvester-Signature`, à vérifier côté récepteur). Un évènement de jeu ne
  fait jamais un appel HTTP synchrone : il écrit une ligne dans `webhook_events`
  au sein de la **même transaction** que l'action qui le déclenche, et un job
  planifié (`webhooks:dispatch`, chaque minute) livre en tentative unique — la
  fiabilité vient de la désactivation automatique d'un abonnement en échec
  répété (`webhookMaxFailures`), pas d'une reprise avec attente exponentielle
  qui retarderait la livraison à un tiers. L'audit a fermé la fenêtre de *DNS
  rebinding* du filtre anti-SSRF (F-09) : l'adresse validée est épinglée.
- **Webhook entrant top.gg** (`POST /api/v1/topgg`) : la boucle de vote
  manquait entièrement (F-13) ; elle crédite désormais, avec idempotence Redis
  rendue en cas d'échec de paiement.
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
  (`src/i18n/locales/`, un catalogue par langue plus des **fragments** par
  fonctionnalité fusionnés au chargement — plusieurs chantiers avancent sans
  conflit sur un fichier de 1 200 clés) ; le travail est de la traduction et de
  la relecture, plus la localisation des noms de cultures et d'objets.
- Détection automatique depuis la langue du serveur Discord.
- **Effort** : 2 semaines de développement, plus le temps de traduction.

---

## Dette technique à traiter en priorité

Indépendamment des fonctionnalités, à faire avant toute v2 significative :

1. **Tests d'intégration sur base réelle — ✅ Fait, étendu, et en CI.**
   `tests/integration/` (suite dédiée, `npm run test:integration`, séparée des
   494 tests rapides qui ne nécessitent aucune infrastructure) compte 11
   fichiers, 38 tests et un `it.todo`. Six sont **hermétiques** (Testcontainers :
   `harvest-concurrency` et les cinq scénarios A-03 — `standing-order-cancel`,
   `auction-double-refund`, `trade-revision`, `gift-cap-concurrent`,
   `warehouse-capacity` — via `tests/integration/stack.ts` : variables posées
   avant tout import de `src/**`, migrate + seed, attente du second « ready »
   de PostgreSQL) ; les autres partagent la base `<POSTGRES_DB>_test` de
   `global-setup.ts`. Le job `integration` de `.github/workflows/ci.yml` les
   exécute à chaque *push* avec des services `postgres:16-alpine` et
   `redis:7-alpine` et le démon Docker du runner — ce qui lève la réserve
   ouverte ici depuis la v2.1 (« suite jamais exécutée de bout en bout »),
   **à confirmer au premier run vert** : l'environnement qui a produit ces
   commits n'avait pas de démon Docker.
2. **Métriques Prometheus économiques — ✅ Fait, et branchées.** `/metrics`
   expose la masse monétaire, le ratio création/destruction, les écarts de
   journal et les joueurs suspects (instantané horaire), et depuis la v2.8 les
   erreurs par code, les latences par commande et le pool de rendu ; le
   tableau Grafana `ops/grafana/harvester-dashboard.json` (B-04) les lit. La
   promesse `errors_total{code=…}` de l'en-tête d'`utils/errors.ts` est tenue
   sous le nom `harvester_errors_total`.
3. **Partitionnement des tables de journaux.** `transactions` et
   `market_price_history` croissent linéairement avec l'activité. La rétention
   par soldes d'ouverture (v2.8) plafonne désormais `transactions` à
   `retentionMonths` d'historique ; si le volume l'exige quand même, un
   partitionnement mensuel par `created_at` peut s'appuyer sur
   `ledger_checkpoints.transactions_through` pour **détacher des partitions
   entières** au lieu de supprimer par lots.
4. **Cache mémoire L1 devant Redis.** Les configurations de gameplay sont relues à
   chaque requête depuis la mémoire du processus (déjà en cache), mais les données
   de monde (météo, saison) font un aller-retour Redis systématique. Un cache local
   de 60 s économiserait l'essentiel de ce trafic.
5. **Sprites — toujours pas livré, mais repli encore amélioré.** Aucun sprite
   dédié ne peut être ajouté sans assets sous licence claire (voir
   [05 — Pipeline d'assets](./05-pipeline-assets.md)) ; ça reste le meilleur
   rapport effort/impact perçu de toute cette liste dès qu'ils existeront. En
   attendant, le rendu procédural porte silhouettes et palettes par espèce
   (cultures **et** animaux), mutations visibles, décor de saison, médailles,
   strates — et les dossiers `buildings/`, `weather/` déclarés dans
   `sprites.ts` ne sont résolus par aucun rendu : à câbler le jour où des
   assets arrivent.
6. **Lint — ✅ Fait (A-02).** `eslint.config.js` : `@eslint/js` +
   `typescript-eslint` avec information de types (`no-floating-promises`
   attrape une transaction oubliée derrière un `await` manquant) et des règles
   maison qui encodent les invariants violés avant l'audit — pas de
   `Math.round`/`Math.ceil` sur de la monnaie, `allowOverflow: true` justifié
   par un commentaire, réponses aux interactions via le framework ;
   `reportUnusedDisableDirectives` refuse les exceptions mortes. `npm run lint`
   tourne dans le job `verify` de la CI, entre `typecheck` et `test`.
7. **Limites connues, à lever** — chacune est documentée là où elle mord :
   - chaque shard ouvre `HTTP_PORT` : le profil `sharded` n'est sûr qu'avec
     `SHARDING_TOTAL=1` tant que `src/index.ts` ne réserve pas le serveur HTTP
     au shard 0 ([08 § 3](./08-exploitation.md#3-shard-qui-ne-revient-pas)) ;
   - le plafond quotidien des dons est lu hors transaction, deux dons simultanés
     peuvent le franchir ensemble (`it.todo` dans `gift-cap-concurrent`) ;
   - `requiredPermissions` de l'interface `Command` n'est appliqué par aucun
     pipeline — `/server` vérifie lui-même `memberPermissions` ; à généraliser
     dans `interaction-create.ts` dès qu'une seconde commande en a besoin ;
   - `touchUser` ne filtre pas `deleted_at` (contourné par
     `reassertAnonymization`) ;
   - aucun déclenchement manuel d'événement : les cinq événements récurrents
     partent à leur date (`recurringCron` + `durationHours`, calcul dans
     `src/game/events.ts`), mais une opération exceptionnelle demanderait une
     sous-commande `/admin event` qui n'existe pas ;
   - le motif `node_modules/` de `.gitignore` n'ignore pas un **lien
     symbolique** `node_modules` (cas des copies de travail des agents) —
     `node_modules` sans barre oblique serait plus sûr.
8. **Première purge du journal.** Douze mois après la mise en service, la
   purge nocturne trouve un an d'écritures et s'étale sur plusieurs nuits
   (200 000 lignes/nuit) : surveiller `ledger_purge` dans `audit_logs` et le
   retour de `maintenance:cleanup` ([08 § 12](./08-exploitation.md#12-journal-comptable--première-purge-et-surveillance)).

---

## Ce qui restera hors périmètre

Décisions de conception, pas manques de temps :

- **Toute monétisation donnant un avantage de jeu.** Le pilier « aucun
  pay-to-win » n'est pas négociable. Un financement éventuel passerait par du
  cosmétique strict, et le code n'en prévoit délibérément aucun point d'entrée —
  les variantes d'animaux, seul « graal » du jeu, ne viennent que du jeu.
- **Combat PvP.** Le jeu est coopératif ; opposer les joueurs casserait la
  dynamique d'entraide, qui est ce qui le rend agréable en communauté.
- **Minijeux temps réel exigeant de la dextérité.** La latence de Discord les rend
  frustrants, et ils excluent une partie des joueurs.
- **Économie inter-serveurs cloisonnée.** Voir la décision « ferme globale » en
  [01 § 2](./01-cahier-des-charges.md#2-ferme-globale-ou-ferme-par-serveur--décision-et-justification).
- **Un « ordre de vente » sur le marché dynamique.** `/alert` prévient, `/order`
  achète à l'hôtel des ventes ; un côté achat du marché fluctuant ouvrirait un
  puits d'objets sans plafond et un vecteur de triche (vendre à soi-même par un
  compte tiers).
