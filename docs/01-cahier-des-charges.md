# 01 — Cahier des charges

> Document de référence fonctionnel de **Harvester**. Il décrit *ce que* le bot
> fait et *pourquoi*. Le *comment* est dans [02 — Architecture](./02-architecture.md).

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
| **Aucun pay-to-win** | Les gemmes 💎 s'obtiennent **uniquement** par le jeu (niveaux, quêtes, succès, votes, événements). Aucune boutique monétaire n'existe dans le code, et aucun point d'entrée n'est prévu pour en ajouter. |
| **Sessions courtes et fréquentes** | Toute action utile doit tenir en **une commande**. Les cultures de départ poussent en 5 à 15 minutes ; les cycles longs (café, vanille) sont réservés au joueur qui revient deux fois par jour. |
| **Économie fermée** | Chaque source de pièces (*faucet*) a un puits (*sink*) correspondant. Le grand livre est vérifié toutes les heures : `SUM(transactions.amount) = users.coins` par joueur. |
| **Coopération encouragée** | Aider un autre fermier rapporte **aux deux**. Les coopératives donnent des bonus passifs à tous leurs membres. Aucun mécanisme n'oppose les joueurs entre eux, hors classements cosmétiques. |
| **Événements récurrents** | Météo quotidienne, saisons, boutique tournante, passe saisonnier, événements calendaires : le monde change même quand le joueur ne joue pas. |

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

- **court** (5–30 min) : planter, arroser, récolter, nourrir ;
- **moyen** (quelques heures) : transformation, enchères, quêtes journalières ;
- **long** (jours/semaines) : parcelles, bâtiments, coopérative, passe, prestige.

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
- ✅ Le modèle de données reste simple : `users.discord_id` est unique, point.

### Ce qui reste local au serveur — le compromis

Le grief légitime de la ferme globale est social : « le classement mondial ne me
parle pas ». On le traite sans casser le modèle :

- **`/leaderboard` a une option `portée`** : `serveur` (par défaut) filtre sur les
  membres présents dans le serveur courant ; `mondial` montre le classement global ;
  `coop` classe au sein de la coopérative.
- **Les coopératives sont indépendantes des serveurs.** Un groupe d'amis répartis
  sur cinq serveurs joue ensemble ; un serveur peut aussi créer sa coopérative
  maison.
- **`guild_settings`** stocke ce qui est légitimement propre au serveur : langue
  par défaut, salon d'annonces, activation des notifications publiques.
- Les **classements hebdomadaires figés** (`leaderboard_snapshots`) sont calculés
  pour les deux portées.

> **Conséquence technique.** `users.discord_id` est la seule identité. Aucune table
> de gameplay ne référence `guild_id`, sauf `guild_settings` et les instantanés de
> classement. Cette contrainte est vérifiée par revue de schéma : introduire un
> `guild_id` dans une table de gameplay reviendrait à revenir sur la décision.

---

## 3. Périmètre fonctionnel

### 3.1 Profil et progression

**Création automatique.** La première interaction avec une commande de jeu crée le
compte, la ferme, les 9 parcelles de départ, le compte bancaire et les paramètres,
dans **une seule transaction**. Aucune inscription explicite n'est requise ;
`/start` existe pour l'accueil et le code de parrainage, pas pour créer le compte.

**Courbe d'XP.** `xpToNext(n) = ⌊60 · n^1,45 + 40 · n⌋`. Exposant volontairement
inférieur à 1,5 : la courbe accélère sans jamais doubler d'un niveau à l'autre.
Niveau 60 = 615 942 XP cumulés (voir [04 — Équilibrage](./04-equilibrage.md)).

**Récompenses de palier.** Chaque niveau verse des pièces (croissantes), et tous
les 5 niveaux : 5 gemmes, plus les déblocages associés (cultures, animaux,
bâtiments, fonctionnalités). Un niveau ne débloque **jamais rien de purement
cosmétique en remplacement** d'un contenu attendu : la montée de niveau doit
toujours ouvrir une option de jeu.

**Statistiques détaillées** (`player_stats`, 30+ compteurs) : récoltes par culture,
pièces gagnées et dépensées, objets fabriqués, animaux élevés, quêtes terminées,
temps de jeu estimé, meilleure récolte, mutations obtenues, aides rendues et reçues.

**Prestige.** Disponible au **niveau 60** (niveau maximum). Remet à zéro niveau, XP
et animaux, conserve **50 % des parcelles** débloquées, **tous les bâtiments**, les
gemmes, les succès, les titres, les badges, les statistiques, la coopérative, les
objets cosmétiques/outils/événement et **5 % des pièces** (avec un plancher de
5 000 🪙 pour ne jamais repartir sans rien). Accorde un bonus permanent cumulatif de
**+15 % par rang** (20 rangs maximum), un titre exclusif et des points de prestige.
Confirmation par **modal de saisie exacte** (le joueur doit écrire `PRESTIGE`), pas
par simple bouton : c'est l'action la plus destructrice du jeu.

**Titres et badges.** ~40 titres (progression, exploits, saisonniers, prestige) et
28 badges de succès. Un seul titre équipé à la fois, affiché sur la carte de profil
et dans les classements.

**Personnalisation.** Nom de ferme (32 caractères, filtré), couleur d'accent
(hex validé), style de bannière (6 styles débloqués par la progression), et
biographie courte.

### 3.2 Parcelles

- Grille de **9 (3×3) à 64 (8×8)** parcelles. La grille affichée s'adapte au
  nombre de parcelles possédées ; `slotToCoords` garantit une bijection stable.
- **Coût exponentiel** : `800 × 1,155^n`. De la 10ᵉ à la 64ᵉ parcelle :
  **14 276 110 🪙** cumulés — le principal puits monétaire de la partie longue.
- **États** : `empty`, `planted`, `growing`, `ready`, `withered`, `locked`.
- **Fertilité 0–100 par parcelle.** Chaque récolte consomme de la fertilité en
  proportion de la valeur de la culture ; le compost, le fumier et la jachère la
  restaurent. Sous 30, le rendement chute nettement : c'est ce qui empêche la
  monoculture d'une seule culture rentable en boucle infinie.
- **Irrigation.** Un arrosage manuel par cycle est requis (fenêtre de grâce
  paramétrable). Le bâtiment *système d'irrigation* débloque l'arrosage automatique
  d'une zone : il ne supprime pas le besoin d'arroser, il supprime le besoin d'être
  présent — ce qui est exactement ce qu'un joueur veut acheter.
- **Nuisibles aléatoires** avec **échéance** : un nuisible non traité avant sa
  date limite inflige des dégâts au rendement, jusqu'à la perte totale. Le job
  `pests` les fait apparaître ; le job `pest_damage` applique les conséquences.
- **Mauvaises herbes** : apparition passive, réduisent le rendement, `/weed`
  les retire et produit des *herbes* utilisables en compost.

### 3.3 Cultures — 27 espèces

Chaque culture porte : nom, emoji, rareté, prix de graine, durée de pousse,
rendement (min–max), prix de vente, niveau requis, saisons favorables,
multiplicateur de qualité, et éventuelles particularités (récolte multiple).

Progression : blé/carotte (5–8 min, niveau 1) → maïs, tomate, fraise (niveaux 3–6)
→ melon, pastèque, citrouille, houblon, raisin (10–15) → thé, café, cacao, lavande,
vanille (17–23) → ginseng, truffe, safran (28–36) → fruit du dragon, lotus étoilé,
arbre-monde (42–55). Liste complète et chiffres dans [04](./04-equilibrage.md).

**Qualités.** `normal` → `argent` (×1,35) → `or` (×1,9) → `iridium` (×3). La
distribution suit un modèle à exposants : `P(argent) ∝ score`, `P(or) ∝ score²`,
`P(iridium) ∝ score³`, où `score` agrège fertilité, niveau, engrais et bonus. Un
débutant voit 0,9 % d'iridium, un joueur optimisé de fin de partie 18 % : la qualité
est une récompense d'investissement, pas une loterie.

**Mutations rares** — `giant` (×2,5 rendement), `rainbow` (×3 valeur), `ancient`
(×1,5 rendement et ×2 valeur) : très faible probabilité, indépendante de la qualité.
Elles existent pour créer l'anecdote qu'on raconte dans le salon.

**Grainerie** : à la récolte, une probabilité de récupérer des graines de la culture
récoltée. Elle réduit le coût récurrent des cultures de bas niveau sans jamais le
supprimer (le taux est calibré sous 100 % : les graines restent un puits).

### 3.4 Animaux — 13 espèces

Poule, canard, lapin, mouton, chèvre, abeille, vache, cochon, alpaga, autruche,
cheval, paon, dragonnet.

**Quatre jauges** par animal : faim (0–100), bonheur (0–100), santé (0–100), âge
(en jours). Elles ne sont **pas** mises à jour par un tick : elles sont calculées
au moment de la lecture depuis `last_fed_at`, `last_petted_at` et `created_at`,
puis matérialisées toutes les 3 heures par le job `animals` (qui déclenche maladies
et décès).

- **Nourrir** : consomme de la nourriture adaptée à l'espèce, remonte la faim.
- **Caresser** : remonte le bonheur, une fois par cycle. Le bonheur module le
  rendement et la probabilité de produit de qualité.
- **Soigner** : consomme un kit vétérinaire, remonte la santé et guérit la maladie.
- **Reproduction** : deux animaux adultes, sains et heureux de la même espèce
  produisent un petit, avec cooldown et coût. C'est la seule manière d'obtenir
  certains animaux sans les acheter.
- **Capacité limitée par bâtiment** : poulailler, étable, bergerie, rucher,
  écurie, enclos exotique. Acheter un animal sans place libre échoue avec un
  message explicite.
- **Mort et improductivité.** Un animal négligé tombe malade, cesse de produire,
  puis meurt. **Un avertissement en message privé est envoyé si et seulement si
  le joueur a activé les notifications** (`settings.dm_notifications`, désactivé
  par défaut, RGPD-compatible).

### 3.5 Inventaire

Paginé, filtrable par catégorie (graines, récoltes, produits transformés,
nourriture, consommables, matériaux, spéciaux). **Capacité limitée** par le niveau
de coffre, extensible par amélioration payante — un puits monétaire, et une
pression douce à vendre plutôt qu'à thésauriser.

Les objets sont stockés par `(user, item, qualité, mutation)` : le même blé en
qualité or et en qualité normale sont deux lignes distinctes, empilables
séparément. `mutation` est `NOT NULL DEFAULT 'none'` précisément pour que la
contrainte d'unicité fonctionne (un `NULL` casserait l'unicité en PostgreSQL).

**Consommables** : engrais (3 niveaux), arrosoir amélioré, boost d'XP, boost de
pousse, potion de chance, ticket de relance de quête, appât à nuisibles.

### 3.6 Transformation — 6 bâtiments, 32 recettes

Moulin, fromagerie, brasserie, confiturerie, presse à huile, fumoir (plus les
bâtiments d'élevage et utilitaires : 18 au total).

Chaque bâtiment a un **nombre limité de slots de production**, extensible par
amélioration. Une recette occupe un slot pendant sa durée, puis le produit attend
d'être collecté. La marge est calibrée entre **2,0× et 2,2×** la valeur des
ingrédients : transformer vaut toujours mieux que vendre brut, mais coûte du temps
et de l'attente — c'est l'arbitrage central de la partie moyenne.

Le plafond de marge est vérifié par un test automatisé
(`tests/config-and-balance.test.ts`) : une recette dont la marge dépasserait 2,4×
fait échouer la CI. C'est ainsi qu'a été détecté et corrigé le cas du compost, qui
partait de mauvaises herbes gratuites et constituait donc un robinet monétaire pur.

### 3.7 Économie

**Deux monnaies.** Pièces 🪙 (BIGINT, jamais de flottant) pour tout le jeu ;
gemmes 💎 pour les raccourcis de confort (relances, slots supplémentaires,
cosmétiques). Les gemmes ne s'achètent pas.

**Marché dynamique.** Prix recalculés **toutes les heures** par le job `market`,
selon la pression offre/demande accumulée depuis la dernière mise à jour :

```
targetDemand = 2 / (1 + pression)      pression > 1 ⇒ cible < 1 ⇒ prix baisse
prix ← lissage(prix, prixBase × targetDemand) × (1 + bruit)
prix ← clamp(prix, plancher, plafond)   volume ← volume × décroissance
```

Le plancher et le plafond (**55 %–180 %** du prix de base) sont **durs** :
ils garantissent qu'aucune stratégie de manipulation ne peut ni effondrer un prix
à zéro ni le faire exploser. L'historique est conservé et affiché en graphique par
`/market-history`.

**Boutique du jour.** Rotation quotidienne déterministe (RNG *seedée* sur la date),
donc identique sur tous les *shards* sans coordination. Remises aléatoires.

**Hôtel des ventes.** Annonces avec prix fixe ou enchères, durée choisie, frais de
mise en vente **non remboursables** (2 %, minimum 25 🪙) et commission à la vente
(5 %). Les mises perdantes sont remboursées automatiquement par le job `auctions`
toutes les 5 minutes. Les frais sont le puits ; les remboursements garantissent
qu'enchérir n'est jamais un piège.

**Échanges directs.** `/trade @joueur` ouvre une session : chaque partie ajoute
objets et pièces via des menus déroulants, puis **les deux** doivent confirmer par
bouton. Toute modification après confirmation **réinitialise les deux
confirmations** — c'est la protection standard contre l'arnaque au dernier moment.
Taxe de 2 % sur les pièces échangées.

**Banque.** Dépôt, retrait, intérêts quotidiens (job `bank_interest`), plafond de
dépôt relevable. Elle sert à la fois de puits temporaire et de protection : les
pièces en banque ne sont pas perdues lors d'un prestige.

**Puits monétaires** (récapitulatif exhaustif dans [04](./04-equilibrage.md)) :
taxe de vente 3 %, décote de vente directe 15 %, commission HDV 5 %, frais de mise
en vente 2 %, taxe sur les dons 5 % (plafond 50 000 🪙/jour), taxe d'échange 2 %,
parcelles, bâtiments, graines, nourriture, soins vétérinaires, relances de quête,
création de coopérative.

### 3.8 Quêtes, événements et monde

- **Journalières** : 3 à 5, tirées d'un pool pondéré par niveau. **Relance payante**
  à coût doublant (500 🪙, puis 1 000, etc.), limitée par jour.
- **Hebdomadaires** : plus longues, meilleures récompenses, réinitialisées le lundi.
- **Chaîne narrative** : progression scénarisée qui accompagne les déblocages et
  sert de tutoriel implicite au-delà du niveau 10.
- **Contrats de livraison** de PNJ du village : demandes précises (quantité,
  qualité minimale) contre récompenses supérieures au prix de marché.
- **Succès** : 28, avec badges et titres.
- **Passe saisonnier gratuit** : 30 paliers, points gagnés par le jeu normal.
  Aucune piste payante — ce serait contraire au premier pilier.
- **Événements temporaires** : 6 configurés, activables par date ou manuellement,
  avec bannière, bonus globaux et récompenses dédiées.
- **Saisons** : printemps, été, automne, hiver, sur un cycle réel configurable
  (`SEASON_LENGTH_DAYS`, 14 jours par défaut). Elles modulent le rendement par
  culture — planter hors saison est possible mais moins rentable.
- **Météo quotidienne** aléatoire (ensoleillé, pluie, orage, canicule, gel,
  brouillard, arc-en-ciel) : modifie pousse, arrosage et risques. La pluie arrose
  gratuitement toutes les parcelles — la météo est donc une raison de se connecter
  pour vérifier.

### 3.9 Social

- **Coopératives** : jusqu'à 50 membres, 4 rôles (chef, officier, vétéran, membre),
  trésorerie commune journalisée, niveau collectif, bonus passifs pour tous les
  membres (pousse, vente, XP — voir la table en [04](./04-equilibrage.md)).
- **Objectifs hebdomadaires de coopérative** : cibles collectives, récompenses
  distribuées automatiquement par le job `coop_objectives`.
- **Classements** : pièces, niveau, récoltes, score de coopérative, série ;
  portées serveur / mondial / coop ; instantanés hebdomadaires figés.
- **Visites** : `/visit @joueur` affiche la ferme d'autrui (image générée).
  `/assist @joueur` permet un nombre limité d'aides par jour — arroser, désherber —
  qui **rapporte aux deux joueurs**.
- **Parrainage** : code unique, récompenses aux deux parties à des paliers de
  progression du filleul (et non à l'inscription, ce qui empêche la ferme à
  comptes jetables). Une contrainte SQL empêche les boucles de parrainage.

### 3.10 Rétention

- **Série quotidienne** avec paliers de récompense et tolérance d'un jour manqué
  (`grace`), pour ne pas punir un décalage horaire.
- **Notifications privées opt-in** : récolte prête, animal affamé, enchère
  terminée, production collectée. Désactivées par défaut ; réglables par catégorie.
- **Rappels programmés** : `scheduled_tasks` déclenche les notifications au bon
  moment plutôt que par sondage.
- **Système d'énergie** (`ENERGY_SYSTEM_ENABLED`, **activé par défaut**) : borne le
  nombre d'actions par session pour éviter l'abattage en boucle. Se désactive
  entièrement en passant la variable à `false`, sans autre changement.
- **Récompenses de vote top.gg** : bonus quotidien, cumulable avec la série.

### 3.11 Administration

`/admin` (réservé aux `BOT_OWNER_IDS`) : donner / retirer des ressources,
réinitialiser un joueur, bannir économiquement, activer le mode maintenance,
publier une annonce globale, recharger la configuration à chaud, consulter le
tableau de bord (joueurs, économie, santé), et inspecter un joueur.

**Toute action admin est journalisée** dans `audit_logs`, table rendue immuable par
un *trigger* PostgreSQL (`reject_mutation`) : ni `UPDATE` ni `DELETE` ne sont
possibles, y compris pour l'application. Même chose pour `transactions` et
`guild_treasury_log`.

---

## 4. Commandes

~70 commandes et sous-commandes, **toutes implémentées**, plus deux menus
contextuels. Détail complet dans le [README](../README.md#commandes) et dans
`src/commands/`.

| Fichier | Commandes |
|---|---|
| `start.ts` | `/start`, `/tutorial`, `/help` |
| `farm.ts` | `/farm`, `/plant`, `/harvest`, `/water`, `/fertilize`, `/weed`, `/treat`, `/plots`, `/buy-plot`, `/crops` |
| `fishing.ts` | `/fish` |
| `mining.ts` | `/mine` |
| `profile.ts` | `/profile`, `/stats`, `/balance`, `/settings`, `/prestige` |
| `animals.ts` | `/animals`, `/buy-animal`, `/feed`, `/collect`, `/heal`, `/pet`, `/breed`, `/sell-animal` |
| `economy.ts` | `/shop`, `/buy`, `/sell`, `/market`, `/market-history`, `/inventory`, `/item`, `/use`, `/discard`, `/bank`, `/gift` |
| `blackmarket.ts` | `/black-market` |
| `craft.ts` | `/craft`, `/recipes`, `/production`, `/buildings`, `/build` |
| `progression.ts` | `/quests`, `/reroll-quest`, `/achievements`, `/pass`, `/daily`, `/vote` |
| `social.ts` | `/coop`, `/leaderboard`, `/visit`, `/assist`, `/referral` |
| `trade.ts` | `/auction`, `/trade` |
| `world.ts` | `/weather`, `/season`, `/event`, `/encyclopedia` |
| `admin.ts` | `/admin` |
| `context-menus.ts` | **Voir la ferme**, **Proposer un échange** |

Toutes les options d'objet, de culture, d'animal et de recette utilisent
l'**autocomplétion** filtrée par ce que le joueur possède réellement — pas la
liste complète du jeu.

---

## 5. Composants interactifs

**Boutons** : actions rapides contextuelles (arroser tout, récolter tout, replanter
la même graine), pagination `⏮️ ◀️ ▶️ ⏭️`, confirmation double pour toute action
destructive, navigation par onglets, rafraîchissement.

**Menus déroulants** : sélection de graine, de parcelle, de catégorie, d'objet à
vendre, d'animal ; `UserSelect` pour les échanges ; `ChannelSelect` pour la
configuration serveur.

**Modals** : quantité personnalisée, prix d'enchère, description de coopérative,
annonce administrateur, confirmation de prestige, nom de ferme.

**Identifiants structurés** : `namespace:action:ownerId:param1:param2`, construits
et analysés par `src/utils/custom-id.ts`. Longueur vérifiée à la construction
(limite Discord : 100 caractères). `ownerId = '0'` marque un composant public.
`assertOwner` est appelé **avant toute action** : un joueur ne peut pas cliquer sur
le bouton d'un autre.

**Collecteurs** : expiration entre 60 et 120 secondes, composants désactivés à
l'expiration, `deferUpdate()` systématique avant tout traitement long, réponses
éphémères pour tout ce qui n'intéresse que le joueur.

**Anti-double-clic** : verrou Redis par `(utilisateur, action)` avant toute
opération économique, plus idempotence côté base (contraintes uniques, vérification
d'état sous verrou de ligne). Un double clic ne récolte jamais deux fois.

---

## 6. Rendu graphique

Non négociable, et traité comme tel :

| Image | Contenu |
|---|---|
| **Vue de ferme** | Grille de parcelles vue de dessus, état et stade de chaque culture, badges (prêt / à arroser / nuisible / mutation), bandeau joueur avec avatar Discord, barre de niveau, météo, monnaies |
| **Carte de profil** | Bannière, avatar, titre, niveau, XP, énergie, monnaies, 8 statistiques clés, badges |
| **Graphique de marché** | Courbe d'historique de prix, min/max, tendance |
| **Carte de classement** | Podium illustré avec avatars, rangs 4 à 10, bandeau « votre rang » |
| **Bannières d'événement** | Visuel d'annonce |

Contraintes respectées : cache **Redis** indexé sur le hash SHA-1 de l'état rendu,
génération asynchrone avec budget de 4 s, **repli automatique en embed texte** en
cas d'erreur ou de dépassement, poids largement sous 500 Ko (mesuré : 39–102 Ko).
Pipeline d'assets documenté en [05](./05-pipeline-assets.md).

---

## 7. Exigences non fonctionnelles

| Domaine | Exigence |
|---|---|
| **Intégrité économique** | Transaction SQL + `SELECT … FOR UPDATE` sur **toute** opération touchant un solde. Écriture systématique au grand livre dans la même transaction. |
| **Contraintes** | 91 `CHECK` en base ; un solde négatif est impossible même si le code se trompe. |
| **Anti-triche** | Validation exclusivement côté serveur, RNG *seedée* par `(culture, compteur de récolte)` pour empêcher le *reroll*, détection d'anomalies économiques avec score de suspicion et sanctions graduées, journaux immuables. |
| **Performance** | Pousse calculée à la lecture (aucun tick global). Coût O(1) par joueur actif au lieu de millions d'écritures par minute. |
| **Montée en charge** | *Sharding* discord.js prêt ; jobs BullMQ dédupliqués entre *shards*. |
| **Résilience** | Gestion d'erreurs centralisée, salon d'erreurs privé, arrêt propre sur SIGTERM, `/health` vérifiant Discord **et** PostgreSQL. |
| **Sécurité** | Aucun secret en dur, validation Zod de l'environnement au démarrage (échec immédiat si invalide) et de toute entrée utilisateur, limitation de débit et cooldowns. |
| **i18n** | Interface **anglaise**, contenu de jeu **bilingue**. Chaque entrée de `src/config/gameplay/` porte `name`/`description` (français) et `nameEn`/`descriptionEn`. Le chargeur construit une variante complète par langue, donc aucun point d'affichage n'a à résoudre la langue lui-même. |
| **Configuration** | Tout l'équilibrage vit dans des JSON rechargeables à chaud sans redéploiement ; une configuration invalide est **rejetée** et l'ancienne conservée. |
| **Tests** | 90 tests sur la logique de jeu pure et la cohérence de configuration ; seuil de couverture 70 % sur `src/game/**`. |
| **Observabilité** | Journaux structurés (Pino), `/health`, `/metrics`, instantanés économiques horaires. |

---

## 8. Hors périmètre (v1)

Explicitement non livré, pour éviter l'ambiguïté : minijeux temps réel, pêche et
mine, mariage/PNJ romançables, décoration libre de la ferme, tableau de bord web,
API publique, monétisation. Ces éléments sont positionnés dans la
[roadmap](./06-roadmap.md).
