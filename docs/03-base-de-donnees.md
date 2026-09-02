# 03 — Base de données

> **58 tables applicatives · 102 contraintes `CHECK` · 164 index · 36 types
> énumérés · 3 journaux immuables.**
> (59 en base : le runner de migrations crée et possède sa propre table `migrations`.)
> Schéma ORM : `src/db/schema/*.ts` (14 fichiers, dont `enums.ts` et `index.ts`). SQL exécutable :
> `drizzle/0000_init.sql` à `drizzle/0015_ledger_checkpoints.sql` (16 fichiers, § 6).

---

## 1. Conventions transversales

### 1.1 Clés primaires : UUIDv7 pour les entités, BIGSERIAL pour les journaux

Les deux stratégies coexistent **délibérément**, chacune là où elle est bonne.

**UUIDv7 (`users`, `farms`, `plots`, `owned_animals`, `auction_listings`,
`standing_orders`, `price_alerts`, `api_keys`, `webhook_subscriptions`,
`mine_progress`, `owned_pets`, …)**

- Un identifiant peut être **généré côté application avant l'insertion**. C'est ce
  qui permet de construire un `customId` de bouton (`plot:water:<userId>:<plotId>`)
  sans aller-retour supplémentaire vers la base.
- Pas de séquence partagée : deux *shards* insèrent en parallèle sans contention.
- Aucune fuite d'information : un identifiant BIGSERIAL exposé dans un composant
  Discord révélerait le nombre de joueurs et l'ordre d'inscription.
- **UUIDv7 et non v4** : les 48 premiers bits sont un horodatage millisecondes, donc
  les valeurs sont **croissantes dans le temps**. L'insertion dans un index B-tree
  reste séquentielle, sans la fragmentation de page qui rend l'UUIDv4 pénible à
  grande échelle. Implémentation : `src/utils/uuid.ts`. Corollaire exploité par
  `/alert delete` : deux alertes créées à des instants différents divergent dès
  les premiers caractères, donc **huit caractères hexadécimaux** suffisent à
  désigner l'une des cinq alertes d'un joueur — la résolution est toujours
  restreinte au propriétaire, jamais faite sur toute la table.

**BIGSERIAL (`transactions`, `audit_logs`, `market_price_history`,
`guild_treasury_log`, `economy_snapshots`, `notifications`, `scheduled_tasks`,
`webhook_events`, `shop_purchases`, `farm_visits`, `votes`, `weather`)**

- Tables **append-only** à très fort volume : 8 octets contre 16, sur des dizaines
  de millions de lignes, c'est significatif en taille d'index comme en cache.
- L'ordre d'insertion est intrinsèquement l'ordre chronologique, ce qui est exactement
  la sémantique attendue d'un journal — et ce sur quoi s'appuie la rétention du
  grand livre (§ 1.5) : « toutes les écritures d'identifiant ≤ N ».
- Ces identifiants ne sont jamais exposés dans un composant Discord.

**Clés composites, sans identifiant de substitution (`discoveries`,
`ledger_checkpoints`)** : `(user_id, kind, entry_key)` et
`(user_id, currency, period_start)` sont les clés naturelles, rien ne référence
ces lignes, et l'`UPSERT` de la collection (`ON CONFLICT … DO UPDATE`) porte
directement sur la clé primaire.

### 1.2 Argent : `BIGINT`, jamais de flottant

Toute valeur monétaire est un `BIGINT` de pièces entières.

Un `DOUBLE PRECISION` accumule des erreurs de représentation ; sur une économie de
jeu qui effectue des millions d'opérations, une dérive de fraction de pièce devient
un écart réel, et surtout **rend l'invariant du grand livre invérifiable**
(`SUM(transactions) = users.coins` n'est vrai en flottant qu'à epsilon près — donc
faux). `NUMERIC` serait exact mais coûteux en calcul et en stockage pour un besoin
qui n'a aucune décimale.

Côté application, `src/game/money.ts` fournit les garde-fous :

| Fonction | Rôle |
|---|---|
| `assertMoney(n)` | vérifie entier fini et dans `Number.MAX_SAFE_INTEGER` |
| `scaleMoney(n, f)` | multiplication puis **arrondi vers le bas** — les gains ne sont jamais gonflés |
| `feeOf(n, rate)` | frais avec **arrondi vers le haut** — un frais n'est jamais nul par arrondi |

Ces deux sens d'arrondi opposés sont volontaires : ils font toujours pencher l'erreur
d'arrondi du côté de l'économie, jamais du côté du joueur. C'est ce qui garantit
qu'aucune boucle « acheter/revendre » ne peut extraire de la valeur du bruit d'arrondi.
L'audit a trouvé cinq chemins de gain qui utilisaient `Math.round` à la place :
ils ont été ramenés à `scaleMoney` (F-11), et une règle ESLint maison interdit
désormais `Math.round` sur une valeur monétaire.

### 1.3 Temps : `TIMESTAMPTZ` partout

Aucun `TIMESTAMP` nu. Toutes les colonnes temporelles sont `TIMESTAMP WITH TIME ZONE`,
stockées en UTC. Les joueurs sont dans des fuseaux différents et les journalières
doivent se réinitialiser à minuit **local** : la conversion est faite à l'affichage
par Luxon, à partir de `settings.timezone`. Stocker en heure locale rendrait le calcul
des cycles impossible.

Les seules colonnes `DATE` sont des **étiquettes de jour UTC** : `weather.day`
(la météo est un état global indexé par la date UTC — c'est pour cela que
« demain » dans `/almanac` est le jour UTC suivant, quel que soit le fuseau du
joueur), `farm_visits.visit_date` et `ledger_checkpoints.period_start`.

Chaque table d'entité porte `created_at` et `updated_at` (`DEFAULT now()`), ce dernier
maintenu par un *trigger* `set_updated_at` appliqué en boucle sur toutes les tables
concernées — pas par le code applicatif, qui pourrait l'oublier.

### 1.4 Suppression logique

`users.deleted_at`, `farms.deleted_at`, `guilds.deleted_at`,
`owned_animals.died_at`, `auction_listings.cancelled_at`. Motifs :

- **RGPD** : une demande d'effacement doit être traçable, et le journal
  comptable ne doit pas perdre ses références.
- **Intégrité du grand livre** : supprimer physiquement un joueur casserait les
  références de `transactions` et rendrait l'audit économique impossible.
- **Continuité de jeu** : un animal mort reste consultable dans les statistiques.

Les requêtes de gameplay filtrent systématiquement `deleted_at IS NULL`, et les
index correspondants sont **partiels** (`WHERE deleted_at IS NULL`) : ils ne portent
donc que sur les lignes vivantes. L'unicité de `users.discord_id` est elle-même
partielle depuis la migration 0011 : `/admin reset` fait une suppression logique,
et une unicité totale empêchait la personne de refaire `/start`.

**Ce que `/account delete` efface, révoque ou neutralise** — en une seule
transaction (`src/services/account.service.ts`), après relecture des blocages
sous verrou de la ligne joueur :

| Table | Effet |
|---|---|
| `users` | `username` → `deleted-<8 premiers caractères de l'UUID>`, `display_name`, `avatar_hash` et `last_guild_id` mis à `NULL`, `deleted_at` posé. Le solde, le niveau et les statistiques restent : ce sont les agrégats du journal. |
| `settings` | toutes les notifications à `false`, `locale` `fr`, `timezone` `Europe/Paris`, `privacy` `private` |
| `farms` | `name` remis à sa valeur par défaut (texte libre), `deleted_at` posé |
| `owned_animals` | surnoms effacés (texte libre) |
| `api_keys` | `revoked_at` posé sur toutes les clés |
| `webhook_subscriptions` | supprimés (l'URL est une donnée personnelle) |
| `standing_orders` | annulés |
| `notifications` | lignes non livrées purgées |
| `guild_members` | départ de la coopérative (un chef doit d'abord transmettre la direction) |
| `audit_logs` | ligne `account_delete` (sévérité `warn`) avec les compteurs de révocations, preuve du traitement |

**Ce qui reste** : `transactions` (la comptabilité), `audit_logs`, et les
cultures, animaux et inventaire rattachés à la ligne supprimée — ils
n'identifient personne et sont exclus de tout affichage par le filtre
`deleted_at`. `/account export` laisse de son côté une ligne `account_export`
(sévérité `info`, taille du fichier et sections tronquées) : une demande
d'accès honorée doit pouvoir être prouvée. Les blocages qui empêchent la
suppression sont ceux qui engagent un **autre** joueur : annonces actives à
l'hôtel des ventes, échanges en cours, direction d'une coopérative.

Après le commit, `reassertAnonymization` rejoue l'anonymisation : le pipeline
d'interaction lance `touchUser` (pseudo et avatar lus sur Discord) sans
l'attendre et sans filtrer `deleted_at`, et cet `UPDATE` pouvait s'appliquer
juste après la suppression et ré-identifier la ligne.

### 1.5 Rétention du journal comptable — soldes d'ouverture

`transactions` est immuable et ne faisait que croître. L'audit horaire comparait
`users.coins` à la somme du journal **depuis l'origine** : aucune ligne
ancienne ne pouvait être supprimée sans fausser la vérification, et le
partitionnement prévu par la roadmap n'y aurait rien changé. La migration 0015
(constat F-15 de l'audit, proposition D-02) reformule l'invariant sans
l'affaiblir :

```
solde = ouverture(dernier checkpoint) + Σ transactions.amount WHERE id > transactions_through
```

**`ledger_checkpoints`** fige, par joueur, par monnaie et par période
mensuelle, le solde reconstitué à partir du journal jusqu'à une ligne donnée
(`transactions_through`). Trois règles rendent la chose sûre :

1. **L'ouverture est toujours dérivée du journal** (checkpoint précédent + somme
   des lignes intermédiaires), jamais recopiée depuis `users` : c'est une
   compression du journal, pas une seconde source de vérité. Elle est ensuite
   confrontée au solde réel **sous verrou de la ligne joueur** (`lockUserRow`) ;
   l'écart éventuel est mémorisé dans `drift`, journalisé en `ledger_mismatch`
   (sévérité `error`), et bloque la purge de ce joueur tant qu'un checkpoint
   plus récent n'est pas revenu à zéro.
2. **La purge n'efface que ce qu'un checkpoint assez ancien couvre.** Le job
   `maintenance:cleanup` (04:00 UTC) supprime, couple (joueur, monnaie) par
   couple, les écritures d'identifiant ≤ `transactions_through` du plus récent
   checkpoint dont la période **et** l'instant de calcul sont antérieurs à la
   coupure (`economy.ledger.retentionMonths`, 12 mois ; minimum 4 pour couvrir
   la fenêtre de 90 jours de `/history`). Jamais sans checkpoint, jamais pour
   un joueur dont le dernier checkpoint porte une dérive. Par lots de 5 000
   lignes, 200 000 lignes et 2 000 couples par nuit au plus : la première purge,
   douze mois après la mise en service, s'étale sur plusieurs nuits. Les
   checkpoints antérieurs à la borne sont élagués une fois le couple purgé.
3. **L'audit reste juste pendant la purge** : la vérification horaire ne somme
   que les écritures d'identifiant supérieur à la borne du **dernier**
   checkpoint, la purge n'efface que des écritures inférieures ou égales à la
   borne d'un checkpoint **plus ancien** — les deux ensembles sont disjoints.

Le job mensuel `ledger:checkpoint` (le 1er à 05:00 UTC, une heure après la purge
pour ne pas se disputer le pool) traite les joueurs vivants sans checkpoint sur
la période par lots de 100, une transaction par lot, verrous pris par
identifiant croissant (même ordre que `lockUserRows`, donc pas d'interblocage
avec une enchère ou un don), `ON CONFLICT DO NOTHING` : le rejouer à la main
(`runJobNow('ledger:checkpoint')`) est sûr. Un lot en échec est dépassé et
repris au passage suivant ; trois échecs consécutifs arrêtent le job.
`economy.ledger.checkpointDay` (1 à 28) n'est que l'**étiquette** des périodes :
le cron est codé, changer le jour sans changer le cron ne déplace que le nom.

Les fonctions pures de `src/services/ledger.service.ts` (périodes, coupure,
ouverture, écart, borne de purge) sont la spécification que le SQL de
`src/repositories/ledger.repo.ts` implémente ; `tests/ledger-checkpoint.test.ts`
(18 tests) les vérifie sans base, `tests/integration/ledger-retention.test.ts`
(4 scénarios) rejoue la migration, le checkpoint sous verrou, une purge
effective, le refus en dérive et l'immuabilité résiduelle sur un PostgreSQL réel.

---

## 2. Les 58 tables, par domaine

### 2.1 Cœur joueur — `src/db/schema/core.ts` (9)

| Table | Rôle | Points notables |
|---|---|---|
| `users` | Identité, monnaies, niveau, XP, prestige, énergie, bannissement éco, score de suspicion, compagnon équipé, dernier serveur vu | `discord_id` UNIQUE **partiel** (`deleted_at IS NULL`) ; `CHECK (coins >= 0)`, `CHECK (gems >= 0)`, `CHECK (level BETWEEN 1 AND 120)`, `CHECK (prestige BETWEEN 0 AND 20)` ; `equipped_pet_key` sans clé étrangère (catalogue TypeScript) |
| `settings` | Langue, fuseau, notifications MP par famille (`notify_crops`, `notify_animals`, `notify_energy`, `notify_market`, `notify_coop`, `daily_reminder`), rappels en salon (`channel_reminders`), confidentialité, mode compact | 1–1 avec `users` |
| `farms` | Nom, couleur d'accent, bannière, biographie, capacité d'entrepôt, slots d'artisanat, compteurs | 1–1 avec `users` ; `warehouse_capacity` est la borne réellement appliquée à ce que le joueur **produit** depuis l'audit (F-03) |
| `plots` | Une ligne par parcelle : index, état, fertilité, arrosage, herbes, nuisibles | UNIQUE `(user_id, slot)` ; `CHECK (fertility BETWEEN 0 AND 100)` ; `last_weeded_at` (0011) est l'ancre temporelle du désherbage, sans laquelle `/weed` ne faisait que remettre un compteur à zéro |
| `bank_accounts` | Solde, plafond, intérêts cumulés, dernier versement | `CHECK (balance >= 0)`, `CHECK (balance <= capacity)` |
| `daily_streaks` | Série en cours, meilleure série, dernière réclamation, jetons de gel | |
| `referrals` | Parrain → filleul, paliers atteints, récompenses versées | *trigger* anti-boucle |
| `votes` | Votes top.gg, horodatage, récompense versée | index sur `(user_id, voted_at)` ; la protection contre la relivraison du webhook top.gg vit en Redis (`claimOnce`, fenêtre = cooldown de vote), pas ici |
| `cooldowns` | Persistance des cooldowns longs (le court terme vit en Redis) | |

### 2.2 Agriculture — `src/db/schema/farming.ts` (5)

| Table | Rôle | Points notables |
|---|---|---|
| `planted_crops` | Une culture en terre : `planted_at`, `ready_at`, arrosage, nuisible, engrais, mutation, repousses restantes | **Cœur du modèle temporel** — l'état est dérivé de ces horodatages, jamais tické |
| `owned_buildings` | Bâtiment possédé, niveau, slots, capacité | UNIQUE `(user_id, building_key)` |
| `owned_animals` | Espèce, **variante** (`normal` / `shiny` / `golden`), jauges matérialisées, âge, généalogie, maladie, décès | `died_at` en suppression logique ; `variant NOT NULL DEFAULT 'normal'` (0014) — le cheptel existant est devenu « normal » d'un coup, sans réécriture ligne à ligne ; index **partiel** `owned_animals_variant_idx (variant, user_id) WHERE variant <> 'normal'`, parce que les variantes rares sont ~2 % du cheptel |
| `inventory` | Objets par `(user, item, qualité, mutation)` | **`mutation NOT NULL DEFAULT 'none'`** : un `NULL` casserait l'unicité en PostgreSQL, donc la valeur « aucune » est explicite |
| `crafting_queue` | Production en cours et produits à collecter | **Index unique partiel** `(building_id, slot_index) WHERE collected = false` : un slot ne peut porter qu'une production active, mais l'historique reste |

### 2.3 Mine — `src/db/schema/mining.ts` (1)

`mine_progress` : un puits par joueur (`user_id` UNIQUE), profondeur courante,
record, minerais extraits ; `CHECK (current_depth >= 1 AND deepest_reached >=
current_depth)`. C'est une progression **durable**, d'où une table — à la
différence de la pêche, dont l'état de ferrage (éphémère, sans valeur d'audit)
vit en Redis avec un TTL court.

### 2.4 Économie — `src/db/schema/economy.ts` (12)

| Table | Rôle | Points notables |
|---|---|---|
| `transactions` | **Grand livre.** Montant signé, type (41 valeurs), `balance_after`, référence, contrepartie, `metadata` | **IMMUABLE en `UPDATE`** ; `DELETE` réservé à la purge de rétention (§ 4) ; index `(user_id, created_at DESC)` qui sert `/history`, et `(user_id, currency)` (0011) qui sert l'audit. L'almanach y écrit `shop_purchase` / `item_key = 'almanac'` / `metadata.day` : ce champ est **lu** par la requête de repli de `/almanac`, ne pas le retirer |
| `market_prices` | Prix courant, prix de base, volume, pression | Une ligne par objet échangeable ; `current_price` est la valeur que comparent les alertes |
| `market_price_history` | Historique horaire pour les graphiques | BIGSERIAL, purgée par `maintenance:cleanup` après `market.historyRetentionDays` (30) |
| `shop_stock` | Boutique du jour et marché noir (`category = 'black_market'`) : objet, prix, remise, stock, limite par joueur | Régénérée quotidiennement |
| `shop_purchases` | Achats cumulés par `(joueur, article en vente)` | UNIQUE `(user_id, shop_stock_id)` (0011) : `per_user_limit` n'était comparé qu'à la quantité d'**un** achat, la limite « 1 par joueur » du marché noir se contournait en achetant dix fois |
| `auction_listings` | Annonces HDV : prix, enchère, expiration, état | index partiel sur les annonces actives |
| `auction_bids` | Mises, remboursement | |
| `standing_orders` | Ordres d'achat permanents : objet, qualité/mutation (NULL = indifférent), prix unitaire maximal, quantité restante, état | index `(status, item_key, max_unit_price)` pour le rapprochement ; verrouillé `FOR UPDATE` avant toute dépense depuis l'audit (F-01) |
| `trades` | Sessions d'échange P2P, état, confirmations | Les deux confirmations sont réinitialisées à toute modification |
| `trade_items` | Contenu de chaque côté d'un échange | |
| `economy_snapshots` | Instantané horaire : masse monétaire, flux créés/détruits, joueurs actifs, écarts de journal, joueurs suspects | Source des métriques `harvester_economy_*` — `/metrics` ne recalcule jamais à la volée |
| `price_alerts` | « Préviens-moi quand {objet} passe {au-dessus\|en dessous} de {seuil} » : direction, seuil, état, prix déclencheur | `item_key → items_config ON UPDATE CASCADE` ; `CHECK (threshold > 0)` ; index `(status, item_key)` pour l'évaluation horaire et `(user_id, status)` pour `/alert list` ; `triggered` est terminal, `triggered_price` mémorise le prix qui a fait partir l'alerte |

### 2.5 Journal — `src/db/schema/ledger.ts` (1)

`ledger_checkpoints` : `(user_id, currency, period_start)` → `opening_balance`,
`transactions_through`, `drift`, `computed_at` ; index `ledger_checkpoints_period_idx`
pour la sélection des candidats à la purge (§ 1.5).

### 2.6 Progression — `src/db/schema/progression.ts` (5)

`user_quests` · `user_achievements` · `user_season_pass` · `user_events` ·
`leaderboard_snapshots`.

`user_quests.snapshot` est un **JSONB** figeant l'objectif tel qu'il a été attribué
(cible, quantité, récompense). Ainsi, un rééquilibrage de `quests.json` ne modifie
jamais rétroactivement une quête en cours. Le suivi de progression interroge ce JSONB
par **containment** :

```sql
${JSON.stringify(cleanTarget)}::jsonb @> (${userQuests.snapshot}->'objectiveTarget')
```

Le paramètre est **lié**, jamais interpolé — la première version de cette requête
utilisait `sql.raw(JSON.stringify(...))` et constituait une injection SQL ; elle a été
corrigée. Un index **GIN** sur `snapshot` sert cette recherche. Les succès de
collection (`discover_entry`, cible `{ kind }`) passent par le même chemin.

### 2.7 Social — `src/db/schema/social.ts` (5)

`guilds` (les coopératives ; nommées ainsi côté SQL, exposées en `coops` côté TS pour
éviter toute confusion avec les serveurs Discord) · `guild_members` ·
`guild_objectives` (avec `period` `weekly` / `daily` depuis la v2.6, UNIQUE
`(guild_id, objective_key, week_start, period)`) · `guild_treasury_log`
(**immuable**) · `farm_visits` (UNIQUE `(visitor_id, host_id, visit_date)` : un
seul coup de main récompensé par jour et par couple, contre le farming d'XP entre
deux comptes complices).

### 2.8 Collection — `src/db/schema/collection.ts` (1)

`discoveries` : une ligne par `(user_id, kind, entry_key)` — `kind` parmi
`crop`, `product`, `animal`, `fish`, `ore`, `variant` ; `entry_key` est une clé
de configuration ou `<espèce>:<variante>`, **sans clé étrangère** parce que les
familles pointent vers des tables `*_config` différentes (la validité est
garantie par le service, qui ne mappe que des clés de `getConfig()`). `count`
cumule les unités, `best_quality` et `best_variant` gardent le meilleur exemplaire
vu par `GREATEST` — c'est pour cela que les types `quality` et `animal_variant`
sont déclarés du plus commun au plus rare. L'écriture se fait dans `addItems`
(porte d'entrée unique des objets produits) **sous savepoint** : son échec est
journalisé et ne coûte jamais une récolte. Index `(kind, entry_key)` pour les
statistiques globales futures (« combien de joueurs ont vu une poule dorée ? »).

### 2.9 Compagnons — `src/db/schema/pets.ts` (1)

`owned_pets` : `(user_id, pet_key)` UNIQUE, `pet_key` sans clé étrangère (le
catalogue est `src/game/pets.ts`) ; celui qui est affiché vit sur
`users.equipped_pet_key`.

### 2.10 Intégrations — `src/db/schema/integrations.ts` (3)

`api_keys` (hachage SHA-256 de la clé, préfixe de 8 caractères, `revoked_at`) ·
`webhook_subscriptions` (URL, secret HMAC, évènements souscrits en JSONB,
`enabled`, `consecutive_failures` borné à 100, `last_status`) ·
`webhook_events` (file de livraison, `status` `pending` / `delivered` / `failed`,
`attempts` ≤ 10, `last_error`). Voir [07 — API publique](./07-api-publique.md).

### 2.11 Monde et système — `src/db/schema/system.ts` (6)

| Table | Rôle | Points notables |
|---|---|---|
| `weather` | Une ligne par jour, *seedée* par `WORLD_SEED` pour être identique sur tous les *shards* | UNIQUE `day` |
| `seasons` | Calendrier des saisons | |
| `notifications` | File de MP et de rappels : type (18 valeurs), payload i18n, `deliver_at`, `dedupe_key` UNIQUE | `claimed_at` / `claimed_by` (0011) : réservation atomique par `FOR UPDATE SKIP LOCKED`, parce que le worker tourne sur **chaque** shard hors BullMQ ; index partiel `notifications_claimable_idx (deliver_at) WHERE delivered = false` |
| `scheduled_tasks` | Registre persistant des 17 jobs : cron, dernière exécution, durée, `last_error` | UNIQUE `task_key` ; `/admin stats` le lit |
| `audit_logs` | Journal **immuable** des actions sensibles : `action`, cible, `payload` JSONB, `severity` | Actions notables : `ledger_mismatch`, `ledger_purge`, `suspicion`, `vote`, `account_export`, `account_delete`, `admin_*` ; index par acteur, cible, action et sévérité |
| `guild_settings` | Configuration par **serveur Discord** : langue, salons, `reminder_channel_id` et `reminder_batch_minutes` (0013, `CHECK BETWEEN 1 AND 1440`) | Le seul endroit où un `discord_guild_id` apparaît dans le schéma de jeu ; `users.last_guild_id` désigne le serveur destinataire des rappels |

> La table `migrations` n'est pas listée ici : elle est créée et possédée par
> `src/scripts/migrate.ts` en SQL brut. Un registre de migrations doit exister
> **avant** la première migration, il ne peut donc pas faire partie du schéma
> qu'elle applique.

### 2.12 Configuration miroir — `src/db/schema/config.ts` (9)

`crops_config` · `animals_config` · `items_config` · `recipes_config` ·
`buildings_config` · `quests_config` · `achievements_config` · `events_config` ·
`season_pass`.

Ces tables sont **alimentées par `npm run db:seed`** depuis les JSON. Elles ne sont
pas la source de vérité — les JSON le sont — mais elles permettent les jointures SQL
(classements par culture, statistiques agrégées, requêtes d'analyse) et portent
les **clés étrangères** de `inventory`, `owned_animals`, `planted_crops`,
`price_alerts` et `standing_orders`. Le seed est **idempotent** : il fait un
`UPSERT` sur les clés et ne touche **jamais** aux données joueur. Conséquence
d'exploitation : après un lot de contenu (les 14 cultures, 11 animaux, 16
recettes et 32 objets ajoutés en v2.8), **le seed doit être relancé** avant que
les joueurs ne puissent acheter les nouveautés — sans migration, puisque le
schéma ne change pas.

---

## 3. Verrouillage et concurrence

### 3.1 `SELECT … FOR UPDATE`, systématique

```ts
// src/db/client.ts
export async function lockUserRow(tx: Tx, userId: string) {
  const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!row) throw new GameError('USER_NOT_FOUND');
  return row;
}

export async function lockUserRows(tx: Tx, userIds: string[]) {
  const sorted = [...new Set(userIds)].sort();   // ← ordre déterministe
  return tx.select().from(users).where(inArray(users.id, sorted)).for('update');
}
```

Le tri dans `lockUserRows` n'est pas cosmétique : sans lui, un échange A→B et un
échange B→A simultanés prendraient les verrous en ordre inverse et
s'interbloqueraient. Avec le tri, toutes les transactions demandent les verrous dans
le même ordre — l'interblocage devient structurellement impossible. Le job de
checkpoint mensuel suit la même règle : ses lots sont triés par identifiant.

### 3.2 Le piège classique, évité

```
❌  lire le solde → vérifier → (fenêtre de course) → débiter
✅  ouvrir la transaction → verrouiller → relire → vérifier → débiter → commit
```

Toute validation faite **avant** le verrou est considérée comme une simple
optimisation (échouer tôt pour éviter d'ouvrir une transaction inutile). Elle est
**toujours refaite sous verrou**. C'est la règle que suivent tous les services —
y compris les blocages de `/account delete`, relus sous `lockUserRow` entre
l'affichage du bouton et le clic. Une exception connue et documentée : le
plafond quotidien des dons est lu hors transaction
([04 § 7.2](./04-equilibrage.md#72-les-exploitations-recherchées-et-pourquoi-elles-ne-fonctionnent-pas)).

### 3.3 Le filet en base

Même si un chemin de code oubliait la règle, `CHECK (coins >= 0)` fait échouer la
transaction. 102 contraintes de ce type couvrent soldes, quantités, niveaux, jauges
d'animaux, fertilité, capacités, seuils d'alerte, compteurs d'échecs de webhook.
Le code applicatif produit un message clair ; la contrainte garantit la correction.

---

## 4. Immuabilité des journaux

```sql
-- drizzle/0015_ledger_checkpoints.sql
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('harvester.ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'La table % est immuable : ni UPDATE ni DELETE ne sont autorisés (opération %).',
    TG_TABLE_NAME, TG_OP
    USING HINT = 'Écrivez une nouvelle ligne compensatoire au lieu de modifier l''historique ; seule la purge de rétention (job maintenance:cleanup) peut supprimer.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
```

`audit_logs` et `guild_treasury_log` gardent la fonction `reject_mutation()` de
`0001_triggers_and_guards.sql`, qui refuse tout. Pour `transactions`, l'`UPDATE`
reste interdit **sans exception** — une ligne de journal ne se corrige jamais,
elle se compense — et le `DELETE` ne passe que si la transaction courante a
posé `SET LOCAL harvester.ledger_purge = 'on'`, ce que seul
`ledgerRepo.deleteTransactionsThrough` fait. Un `DELETE` manuel, une cascade ou
un script oublié restent refusés ; **l'application elle-même ne peut pas
contourner ce garde-fou**, et c'est le point : un journal d'audit que le
processus audité peut réécrire n'a aucune valeur probante. On n'a pas désactivé
le *trigger* le temps de la purge parce qu'un `ALTER TABLE` prend un verrou
exclusif sur une table que chaque action de jeu écrit — chaque nuit.

Une correction comptable se fait par une **écriture compensatoire**, comme en
comptabilité réelle : `/admin give` et `/admin take` écrivent une ligne
`admin_grant` ou `admin_remove`, visible dans `/history` du joueur (famille
« autre »).

---

## 5. Index — 164, et pourquoi

Un index n'a pas été ajouté « au cas où » : chacun correspond à une requête réelle.

| Motif | Exemples |
|---|---|
| **Recherche par joueur** (le plus fréquent) | `plots(user_id)`, `inventory(user_id)`, `owned_animals(user_id)`, `user_quests(user_id)`, `price_alerts(user_id, status)` |
| **Tri de classement** | `users(coins DESC)`, `users(level DESC, total_xp DESC)`, `users(total_harvests DESC)`, `mine_progress(deepest_reached DESC)` — servent `/leaderboard` sans tri en mémoire |
| **Balayage temporel des jobs** | `planted_crops(ready_at)`, `auction_listings(expires_at)`, `scheduled_tasks(status, run_at)`, `webhook_events(status, created_at)`, `ledger_checkpoints(period_start)` — le job lit une plage, pas une table entière |
| **Journal par joueur** | `transactions(user_id, created_at DESC)` pour `/history` et l'export de compte ; `transactions(user_id, currency)` pour l'audit horaire, qui ne porte plus que sur les joueurs vus depuis 7 jours et les écritures postérieures au dernier checkpoint |
| **Unicité métier** | `users(discord_id) WHERE deleted_at IS NULL`, `plots(user_id, slot)`, `inventory(user_id, item_key, quality, mutation)`, `guild_members(user_id)`, `notifications(dedupe_key)`, `shop_purchases(user_id, shop_stock_id)`, `farm_visits(visitor_id, host_id, visit_date)` |
| **Index partiels** | `WHERE deleted_at IS NULL`, `WHERE status = 'active'`, `WHERE collected = false`, `WHERE delivered = false`, `WHERE variant <> 'normal'` — plus petits, plus rapides, et porteurs de la règle métier |
| **Index fonctionnel** | `lower(guilds.tag)` pour la recherche de coopérative insensible à la casse |
| **GIN** | `user_quests(snapshot)` pour la recherche JSONB par containment |
| **Statistiques** | `discoveries(kind, entry_key)`, `audit_logs(action, created_at DESC)`, `audit_logs(severity, created_at DESC)` |

`log_min_duration_statement=500` est activé dans `docker-compose.yml` : toute requête
dépassant 500 ms est journalisée, ce qui rend visible un index manquant en production.

---

## 6. Migrations et seed

```bash
npm run db:generate   # drizzle-kit : régénère le SQL depuis src/db/schema/
npm run db:migrate    # runner maison : applique, vérifie les hashes
npm run db:seed       # peuple les tables *_config depuis les JSON (idempotent)
```

Le runner (`src/scripts/migrate.ts`) :

1. crée `migrations` si absente ;
2. lit `drizzle/*.sql` par ordre lexicographique ;
3. pour chaque fichier déjà appliqué, **compare le hash SHA-256** et s'arrête en
   erreur en cas d'écart ;
4. applique chaque fichier neuf dans **sa propre transaction** — une migration
   échouée ne laisse jamais un schéma à moitié migré ;
5. enregistre nom, hash, durée et auteur (`applied_by`).

Le point 3 est ce qui empêche la dérive silencieuse entre environnements : modifier
un `.sql` déjà appliqué est une erreur, il faut créer un nouveau fichier.
La suite d'intégration rejoue toutes les migrations sur une base vierge à chaque
exécution — et le job `integration` de la CI aussi : une migration qui ne
s'applique pas sur une base vierge échoue là, pas en production.

| Fichier | Contenu |
|---|---|
| `0000_init.sql` | 48 tables, 137 index, 91 `CHECK` (généré par drizzle-kit) |
| `0001_triggers_and_guards.sql` | *triggers* `updated_at` et d'immuabilité, index partiels et fonctionnels, garde anti-boucle de parrainage, vue `ledger_integrity` (écrit à la main) |
| `0002_english_farm_name.sql` | nom de ferme par défaut en anglais |
| `0003_economy_snapshot_health.sql` | `economy_snapshots.ledger_mismatches` et `.suspicious_users` |
| `0004_item_categories_fish_ore.sql` | valeurs `fish` et `ore` de `item_category` (v2.1) |
| `0005_mine_progress.sql` | table `mine_progress` (v2.1) |
| `0006_api_and_webhooks.sql` | `api_keys`, `webhook_subscriptions`, `webhook_events`, `notification_type.auction_won` (v3.2) |
| `0007_coop_daily_objectives.sql` | `guild_objectives.period` et type `coop_objective_period` (v2.6) |
| `0008_standing_orders.sql` | table `standing_orders` (v2.6) |
| `0009_order_filled_notification.sql` | `notification_type.order_filled` |
| `0010_owned_pets.sql` | table `owned_pets` (v2.7) |
| `0011_audit_fixes.sql` | `plots.last_weeded_at`, unicité partielle de `discord_id`, réservation des notifications, `shop_purchases`, index d'audit, réparation des parcelles bloquées en `withered` |
| `0012_price_alerts.sql` | `price_alerts`, types `price_alert_direction` / `price_alert_status`, `notification_type.price_alert` |
| `0013_channel_reminders.sql` | `guild_settings.reminder_channel_id` / `.reminder_batch_minutes`, `settings.channel_reminders` |
| `0014_animal_variants_and_collection.sql` | type `animal_variant`, `owned_animals.variant`, type `discovery_kind`, table `discoveries`, `quest_objective.discover_entry` |
| `0015_ledger_checkpoints.sql` | table `ledger_checkpoints`, *trigger* `reject_ledger_mutation`, vue `ledger_integrity` recalée sur le dernier checkpoint |

Depuis `0011`, chaque migration est écrite à la main et **rejouable** : `IF NOT
EXISTS` partout, `DO … EXCEPTION WHEN duplicate_object` pour les types (PostgreSQL
n'a pas de `CREATE TYPE IF NOT EXISTS`), `ADD VALUE IF NOT EXISTS` pour les
énumérations, lecture de `pg_constraint` avant un `ADD CONSTRAINT`. Une valeur
d'énumération ajoutée n'est jamais utilisée dans la même transaction (seule
restriction de PostgreSQL) : le seed qui l'emploie tourne après. Ce qu'il faut
faire si une migration doit être rejouée est décrit dans
[08 — Exploitation](./08-exploitation.md#8-migration-à-rejouer).

---

## 7. Vue de contrôle du grand livre

```sql
CREATE OR REPLACE VIEW ledger_integrity AS
SELECT
  u.id                                                                   AS user_id,
  u.discord_id,
  u.coins                                                                AS wallet_balance,
  COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0)            AS ledger_balance,
  u.coins - (COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0)) AS drift
FROM users u
LEFT JOIN LATERAL (
  SELECT lc.opening_balance, lc.transactions_through
  FROM ledger_checkpoints lc
  WHERE lc.user_id = u.id AND lc.currency = 'coins'
  ORDER BY lc.period_start DESC
  LIMIT 1
) c ON true
LEFT JOIN transactions t
  ON t.user_id = u.id
 AND t.currency = 'coins'
 AND t.id > COALESCE(c.transactions_through, 0)
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.discord_id, u.coins, c.opening_balance
HAVING u.coins <> COALESCE(c.opening_balance, 0) + COALESCE(SUM(t.amount), 0);
```

Le `HAVING` est l'essentiel : la vue ne renvoie **que** les lignes en écart. En
exploitation normale elle est vide, et toute ligne qui y apparaît est un
incident. Depuis 0015, elle repart du dernier solde d'ouverture et retombe sur
la somme complète pour un joueur sans checkpoint — sans cela, après une première
purge, elle aurait signalé tous les joueurs purgés.

Le job `economy:snapshot` fait la même vérification toutes les heures
(`findLedgerMismatches`, restreinte aux joueurs vus depuis 7 jours, 100 lignes
au plus). Une ligne présente signifie qu'un solde a été modifié sans écriture au
grand livre : c'est soit un bug, soit une intrusion. Dans les deux cas, elle est
journalisée en `audit_logs` (`ledger_mismatch`), comptée dans
`economy_snapshots.ledger_mismatches` et exposée par
`harvester_economy_ledger_mismatches`. La marche à suivre est dans
[08 — Exploitation](./08-exploitation.md#1-écart-de-journal--0).

---

## 8. Types énumérés — 36

`src/db/schema/enums.ts` déclare 36 `CREATE TYPE … AS ENUM` : 4 octets stockés
au lieu d'une chaîne, validation par le moteur (impossible d'insérer une valeur
inconnue, même par un accès SQL direct), typage TypeScript direct. Ajouter une
valeur = `ALTER TYPE … ADD VALUE` (non bloquant depuis PostgreSQL 12). Ceux
qui ont bougé depuis la v1 :

| Type | Valeurs ajoutées | Depuis |
|---|---|---|
| `item_category` | `fish`, `ore` | 0004 |
| `notification_type` | `auction_won`, `order_filled`, `price_alert` (18 valeurs) | 0006, 0009, 0012 |
| `coop_objective_period` | nouveau : `weekly`, `daily` | 0007 |
| `standing_order_status` | nouveau : `active`, `fulfilled`, `cancelled`, `expired` | 0008 |
| `price_alert_direction`, `price_alert_status` | nouveaux : `above` / `below` ; `active`, `triggered`, `cancelled`, `expired` | 0012 |
| `animal_variant` | nouveau : `normal`, `shiny`, `golden` — **l'ordre compte** (`GREATEST`) | 0014 |
| `discovery_kind` | nouveau : `crop`, `product`, `animal`, `fish`, `ore`, `variant` | 0014 |
| `quest_objective` | `discover_entry` (23 valeurs) | 0014 |

`transaction_type` compte 41 valeurs. Règle pour en ajouter une : la classer dans
`HISTORY_FAMILIES` (`src/services/history.service.ts`) **et** lui donner une clé
`history.type.<type>` dans `fr/history.json` et `en/history.json` — un test
échoue sinon, pour que `/history` n'affiche jamais un type sans libellé.
