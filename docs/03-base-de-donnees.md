# 03 — Base de données

> **49 tables · 138 index · 91 contraintes `CHECK` · 3 tables immuables.**
> Schéma ORM : `src/db/schema/*.ts`. SQL exécutable : `drizzle/0000_init.sql` et
> `drizzle/0001_triggers_and_guards.sql`.

---

## 1. Conventions transversales

### 1.1 Clés primaires : UUIDv7 pour les entités, BIGSERIAL pour les journaux

Les deux stratégies coexistent **délibérément**, chacune là où elle est bonne.

**UUIDv7 (`users`, `farms`, `plots`, `owned_animals`, `auction_listings`, …)**

- Un identifiant peut être **généré côté application avant l'insertion**. C'est ce
  qui permet de construire un `customId` de bouton (`plot:water:<userId>:<plotId>`)
  sans aller-retour supplémentaire vers la base.
- Pas de séquence partagée : deux *shards* insèrent en parallèle sans contention.
- Aucune fuite d'information : un identifiant BIGSERIAL exposé dans un composant
  Discord révélerait le nombre de joueurs et l'ordre d'inscription.
- **UUIDv7 et non v4** : les 48 premiers bits sont un horodatage millisecondes, donc
  les valeurs sont **croissantes dans le temps**. L'insertion dans un index B-tree
  reste séquentielle, sans la fragmentation de page qui rend l'UUIDv4 pénible à
  grande échelle. Implémentation : `src/utils/uuid.ts`.

**BIGSERIAL (`transactions`, `audit_logs`, `market_price_history`,
`guild_treasury_log`, `economy_snapshots`, `notifications`, `scheduled_tasks`)**

- Tables **append-only** à très fort volume : 8 octets contre 16, sur des dizaines
  de millions de lignes, c'est significatif en taille d'index comme en cache.
- L'ordre d'insertion est intrinsèquement l'ordre chronologique, ce qui est exactement
  la sémantique attendue d'un journal.
- Ces identifiants ne sont jamais exposés dans un composant Discord.

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

### 1.3 Temps : `TIMESTAMPTZ` partout

Aucun `TIMESTAMP` nu. Toutes les colonnes temporelles sont `TIMESTAMP WITH TIME ZONE`,
stockées en UTC. Les joueurs sont dans des fuseaux différents et les journalières
doivent se réinitialiser à minuit **local** : la conversion est faite à l'affichage
par Luxon, à partir de `settings.timezone`. Stocker en heure locale rendrait le calcul
des cycles impossible.

Chaque table d'entité porte `created_at` et `updated_at` (`DEFAULT now()`), ce dernier
maintenu par un *trigger* `set_updated_at` appliqué en boucle sur toutes les tables
concernées — pas par le code applicatif, qui pourrait l'oublier.

### 1.4 Suppression logique

`users.deleted_at`, `guilds.deleted_at`, `owned_animals.died_at`,
`auction_listings.cancelled_at`. Motifs :

- **RGPD** : une demande d'effacement doit être traçable et réversible pendant le
  délai de rétention.
- **Intégrité du grand livre** : supprimer physiquement un joueur casserait les
  références de `transactions` et rendrait l'audit économique impossible.
- **Continuité de jeu** : un animal mort reste consultable dans les statistiques.

Les requêtes de gameplay filtrent systématiquement `deleted_at IS NULL`, et les
index correspondants sont **partiels** (`WHERE deleted_at IS NULL`) : ils ne portent
donc que sur les lignes vivantes.

---

## 2. Les 49 tables, par domaine

### 2.1 Cœur joueur — `src/db/schema/core.ts` (9)

| Table | Rôle | Points notables |
|---|---|---|
| `users` | Identité, monnaies, niveau, XP, prestige, énergie, bannissement éco | `discord_id` UNIQUE ; `CHECK (coins >= 0)`, `CHECK (gems >= 0)`, `CHECK (level >= 1)` |
| `settings` | Langue, fuseau, notifications MP, confidentialité, mode compact | 1–1 avec `users` |
| `farms` | Nom, couleur d'accent, bannière, biographie, compteurs | 1–1 avec `users` |
| `plots` | Une ligne par parcelle : index, état, fertilité, arrosage, herbes | UNIQUE `(user_id, slot)` ; `CHECK (fertility BETWEEN 0 AND 100)` |
| `bank_accounts` | Solde, plafond, intérêts cumulés, dernier versement | `CHECK (balance >= 0)`, `CHECK (balance <= capacity)` |
| `daily_streaks` | Série en cours, meilleure série, dernière réclamation, tolérance | |
| `referrals` | Parrain → filleul, paliers atteints, récompenses versées | *trigger* anti-boucle |
| `votes` | Votes top.gg, horodatage, récompense versée | index sur `(user_id, voted_at)` |
| `cooldowns` | Persistance des cooldowns longs (le court terme vit en Redis) | |

### 2.2 Agriculture — `src/db/schema/farming.ts` (5)

| Table | Rôle | Points notables |
|---|---|---|
| `planted_crops` | Une culture en terre : `planted_at`, `ready_at`, arrosage, nuisible, engrais | **Cœur du modèle temporel** — l'état est dérivé de ces horodatages, jamais tické |
| `owned_animals` | Espèce, jauges matérialisées, âge, maladie, décès | `died_at` en suppression logique |
| `owned_buildings` | Bâtiment possédé, niveau, slots, capacité | UNIQUE `(user_id, building_key)` |
| `inventory` | Objets par `(user, item, qualité, mutation)` | **`mutation NOT NULL DEFAULT 'none'`** : un `NULL` casserait l'unicité en PostgreSQL, donc la valeur « aucune » est explicite |
| `crafting_queue` | Production en cours et produits à collecter | **Index unique partiel** `(building_id, slot_index) WHERE collected = false` : un slot ne peut porter qu'une production active, mais l'historique reste |

### 2.3 Économie — `src/db/schema/economy.ts` (9)

| Table | Rôle | Points notables |
|---|---|---|
| `transactions` | **Grand livre.** Montant signé, type (41 valeurs), `balance_after`, référence | **IMMUABLE** (*trigger*) ; index sur `(user_id, created_at DESC)` |
| `market_prices` | Prix courant, prix de base, volume, pression | Une ligne par objet échangeable |
| `market_price_history` | Historique horaire pour les graphiques | BIGSERIAL, purgée par `cleanup` |
| `shop_stock` | Boutique du jour : objet, prix, remise, stock | Régénérée quotidiennement |
| `auction_listings` | Annonces HDV : prix, enchère, expiration, état | index partiel sur les annonces actives |
| `auction_bids` | Mises, remboursement | |
| `trades` | Sessions d'échange P2P, état, confirmations | Les deux confirmations sont réinitialisées à toute modification |
| `trade_items` | Contenu de chaque côté d'un échange | |
| `economy_snapshots` | Instantané horaire : masse monétaire, flux, écarts | Support de la détection d'anomalies |

### 2.4 Progression — `src/db/schema/progression.ts` (7)

`user_quests` · `user_achievements` · `season_pass` · `user_season_pass` ·
`user_events` · `leaderboard_snapshots` · `farm_visits`.

`user_quests.snapshot` est un **JSONB** figeant l'objectif tel qu'il a été attribué
(cible, quantité, récompense). Ainsi, un rééquilibrage de `quests.json` ne modifie
jamais rétroactivement une quête en cours. Le suivi de progression interroge ce JSONB
par **containment** :

```sql
${JSON.stringify(cleanTarget)}::jsonb @> (${userQuests.snapshot}->'objectiveTarget')
```

Le paramètre est **lié**, jamais interpolé — la première version de cette requête
utilisait `sql.raw(JSON.stringify(...))` et constituait une injection SQL ; elle a été
corrigée. Un index **GIN** sur `snapshot` sert cette recherche.

### 2.5 Social — `src/db/schema/social.ts` (5)

`guilds` (les coopératives ; nommées ainsi côté SQL, exposées en `coops` côté TS pour
éviter toute confusion avec les serveurs Discord) · `guild_members` ·
`guild_objectives` · `guild_treasury_log` (**immuable**) · `guild_settings` (le seul
endroit où un `guild_id` Discord apparaît dans le schéma).

### 2.6 Monde et système — `src/db/schema/system.ts` (5)

`weather` (une ligne par jour, *seedée* pour être identique sur tous les *shards*) ·
`seasons` · `notifications` · `scheduled_tasks` · `audit_logs` (**immuable**) ·
`migrations`.

### 2.7 Configuration miroir — `src/db/schema/config.ts` (9)

`crops_config` · `animals_config` · `items_config` · `recipes_config` ·
`buildings_config` · `quests_config` · `achievements_config` · `events_config`.

Ces tables sont **alimentées par `npm run db:seed`** depuis les JSON. Elles ne sont
pas la source de vérité — les JSON le sont — mais elles permettent les jointures SQL
(classements par culture, statistiques agrégées, requêtes d'analyse) sans charger la
configuration dans chaque requête. Le seed est **idempotent** : il fait un `UPSERT`
sur les clés et ne touche **jamais** aux données joueur.

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
le même ordre — l'interblocage devient structurellement impossible.

### 3.2 Le piège classique, évité

```
❌  lire le solde → vérifier → (fenêtre de course) → débiter
✅  ouvrir la transaction → verrouiller → relire → vérifier → débiter → commit
```

Toute validation faite **avant** le verrou est considérée comme une simple
optimisation (échouer tôt pour éviter d'ouvrir une transaction inutile). Elle est
**toujours refaite sous verrou**. C'est la règle que suivent les 14 services.

### 3.3 Le filet en base

Même si un chemin de code oubliait la règle, `CHECK (coins >= 0)` fait échouer la
transaction. 91 contraintes de ce type couvrent soldes, quantités, niveaux, jauges
d'animaux, fertilité, capacités. Le code applicatif produit un message clair ; la
contrainte garantit la correction.

---

## 4. Immuabilité des journaux

```sql
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La table % est immuable (append-only).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
```

Appliqué à `transactions`, `audit_logs` et `guild_treasury_log`. **L'application
elle-même ne peut pas contourner ce garde-fou** : c'est le point. Un journal d'audit
que le processus audité peut réécrire n'a aucune valeur probante. Une correction
comptable se fait par une **écriture compensatoire**, comme en comptabilité réelle.

La purge de rétention, si elle devient nécessaire, se fera par une migration
explicite qui désactive puis réactive le *trigger* — une opération volontaire,
tracée, jamais un `DELETE` de routine.

---

## 5. Index — 138, et pourquoi

Un index n'a pas été ajouté « au cas où » : chacun correspond à une requête réelle.

| Motif | Exemples |
|---|---|
| **Recherche par joueur** (le plus fréquent) | `plots(user_id)`, `inventory(user_id)`, `owned_animals(user_id)`, `user_quests(user_id)` |
| **Tri de classement** | `users(coins DESC)`, `users(level DESC, xp DESC)`, `users(total_harvests DESC)` — servent `/leaderboard` sans tri en mémoire |
| **Balayage temporel des jobs** | `planted_crops(ready_at)`, `auction_listings(expires_at)`, `scheduled_tasks(run_at)` — le job lit une plage, pas une table entière |
| **Unicité métier** | `users(discord_id)`, `plots(user_id, slot)`, `inventory(user_id, item_key, quality, mutation)`, `guild_members(user_id)` |
| **Index partiels** | `WHERE deleted_at IS NULL`, `WHERE status = 'active'`, `WHERE collected = false` — plus petits, plus rapides, et porteurs de la règle métier |
| **Index fonctionnel** | `lower(guilds.tag)` pour la recherche de coopérative insensible à la casse |
| **GIN** | `user_quests(snapshot)` pour la recherche JSONB par containment |

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
5. enregistre nom, hash et durée.

Le point 3 est ce qui empêche la dérive silencieuse entre environnements : modifier
un `.sql` déjà appliqué est une erreur, il faut créer un nouveau fichier.

---

## 7. Vue de contrôle du grand livre

```sql
CREATE OR REPLACE VIEW ledger_integrity AS
SELECT u.id,
       u.discord_id,
       u.coins                                   AS balance,
       COALESCE(SUM(t.amount), 0)                AS ledger_sum,
       u.coins - COALESCE(SUM(t.amount), 0)      AS drift
FROM users u
LEFT JOIN transactions t ON t.user_id = u.id
WHERE u.deleted_at IS NULL
GROUP BY u.id;
```

Le job `economy_snapshot` interroge cette vue toutes les 30 minutes. `drift ≠ 0`
signifie qu'un solde a été modifié sans écriture au grand livre : c'est soit un bug,
soit une intrusion. Dans les deux cas, la ligne est journalisée et remontée dans le
salon d'erreurs privé. En exploitation normale, `drift` est identiquement nul.
