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
entraide, parrainage ; ~70 commandes ; rendu graphique complet ; 49 tables ;
administration et anti-triche.

---

## v2 — « Le monde s'élargit »

Objectif : donner des choses à faire à un joueur de niveau 40+ qui a déjà tout
débloqué, sans allonger artificiellement les courbes.

### v2.1 — Pêche et mine

Deux nouvelles boucles courtes qui utilisent l'infrastructure existante (parcelles →
spots, cultures → prises/minerais, qualité → même modèle). Le gros du travail est du
contenu et du rendu, pas de l'architecture.

- **Pêche** : étang débloqué au niveau 18, 15 espèces de poissons selon météo, saison
  et heure de la journée. Minijeu de timing via bouton (fenêtre de 3 s), donc **une**
  interaction, compatible avec la contrainte de session courte.
- **Mine** : 20 niveaux de profondeur, minerais et gemmes brutes, consommation
  d'énergie. Alimente une nouvelle recette de forge (outils améliorés).
- **Impact base** : 4 tables (`fishing_spots`, `caught_fish`, `mine_progress`,
  `mined_resources`), aucune migration destructive.
- **Effort estimé** : 3 à 4 semaines.

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

### v2.4 — Marché noir et contrebande

- Boutique tournante à contenu rare, prix élevés, stock très limité, accessible aux
  niveaux élevés.
- Un **puits monétaire supplémentaire** dont le besoin apparaîtra quand les joueurs
  de fin de partie auront terminé les parcelles : c'est la vraie raison d'être de la
  fonctionnalité.
- **Impact base** : réutilise `shop_stock` avec un discriminant.
- **Effort** : 1 semaine.

### v2.5 — Compétitions de coopératives

- Tournois hebdomadaires entre coopératives sur un objectif tiré au sort.
- Classement dédié, récompenses cosmétiques et bannière de coopérative.
- **Effort** : 2 semaines. Dépend d'une base de coopératives actives suffisante —
  à ne pas livrer trop tôt.

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

### v3.2 — API publique et webhooks

- API REST en lecture pour les statistiques de joueur et de coopérative, avec clés
  et limitation de débit.
- Webhooks sortants (récolte prête, enchère remportée) vers des services tiers.
- Permet aux communautés de construire leurs propres tableaux de bord.
- **Effort** : 3 semaines.

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

1. **Tests d'intégration sur base réelle.** Les 90 tests actuels couvrent la logique
   pure et la configuration. Il manque une suite Testcontainers vérifiant les
   transactions concurrentes — notamment que deux `/harvest` simultanés sur la même
   parcelle n'en produisent qu'une. C'est le test le plus important qui manque.
2. **Métriques Prometheus.** `/metrics` expose déjà des compteurs ; les passer au
   format Prometheus et brancher un Grafana rendrait la détection d'anomalies
   économiques visuelle plutôt que journalisée.
3. **Partitionnement des tables de journaux.** `transactions` et
   `market_price_history` croissent linéairement avec l'activité. Un partitionnement
   par mois deviendra nécessaire vers 10 millions de lignes.
4. **Cache mémoire L1 devant Redis.** Les configurations de gameplay sont relues à
   chaque requête depuis la mémoire du processus (déjà en cache), mais les données
   de monde (météo, saison) font un aller-retour Redis systématique. Un cache local
   de 60 s économiserait l'essentiel de ce trafic.
5. **Sprites.** Le rendu procédural est propre et fonctionne, mais des sprites
   dédiés changeraient la perception du bot. C'est le meilleur rapport
   effort/impact perçu de toute cette liste — voir
   [05 — Pipeline d'assets](./05-pipeline-assets.md).

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
