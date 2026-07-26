# 02 — Architecture technique

> Comment le bot est construit, et pourquoi ainsi. Le *quoi* est dans
> [01 — Cahier des charges](./01-cahier-des-charges.md).

---

## 1. Pile technique et arbitrages

| Composant | Choix | Version |
|---|---|---|
| Exécution | Node.js | 20 LTS |
| Langage | TypeScript `strict` + `noUncheckedIndexedAccess` | 5.9 |
| Discord | discord.js | 14.27 |
| Base | PostgreSQL | 16 |
| Cache / verrous / files | Redis | 7 |
| ORM | **Drizzle ORM** + `node-postgres` | 0.45 |
| Files planifiées | BullMQ (repli minuteur) | 5 |
| Validation | Zod | 4 |
| Journalisation | Pino | 10 |
| Images | `@napi-rs/canvas` | 0.1 |
| Dates | Luxon | 3 |
| Tests | Vitest | 4 |

### 1.1 Drizzle plutôt que Prisma — décision

Les deux ont été considérés sérieusement. Drizzle l'emporte sur quatre points
concrets pour *ce* projet :

1. **`SELECT … FOR UPDATE` de première classe.** `.for('update')` est natif. Prisma
   n'expose pas le verrouillage de ligne hors `$queryRaw`. Comme *toute* opération
   économique de ce bot en dépend, le point est décisif.
2. **Pas de génération de code, pas de moteur binaire.** Le projet compile et
   s'exécute hors ligne : `tsc --noEmit`, `vitest`, `render:preview` et
   `balance:report` fonctionnent **sans base de données ni téléchargement**. Avec
   Prisma, `prisma generate` est un préalable à toute vérification de type.
3. **Image Docker plus légère** : pas de moteur de requête natif à embarquer
   (~50 Mo de moins).
4. **SQL lisible.** Les requêtes complexes (agrégats de classement, `@>` sur JSONB,
   `ARRAY_AGG(DISTINCT …)`) s'écrivent en SQL balisé et typé, sans se battre contre
   un langage de requête intermédiaire.

Ce que Prisma aurait apporté et qu'on assume perdre : Prisma Studio (compensé par
`drizzle-kit studio`) et un moteur de migration plus opiniâtre (compensé par un
runner maison, § 6.3).

### 1.2 Pousse calculée à la lecture — décision fondamentale

**Aucun tick global n'existe.** À la plantation on écrit `planted_at` et `ready_at`
(calculé une fois, avec les modificateurs actifs). L'état d'une culture est
**dérivé** au moment où on la lit :

```ts
// src/game/growth.ts
const elapsed  = now - plantedAt;
const total    = readyAt - plantedAt;
const progress = clamp01(elapsed / total);
const stage    = Math.min(5, 1 + Math.floor(progress * 5));
```

Pourquoi c'est le bon choix, chiffres à l'appui :

| | Tick global | Calcul à la lecture |
|---|---|---|
| Écritures pour 50 000 joueurs × 50 parcelles, tick à la minute | **2 500 000 UPDATE/min** | **0** |
| Écritures réelles | à chaque tick | uniquement lors d'une action du joueur |
| Coût d'un joueur inactif | identique à un joueur actif | **nul** |
| Dérive si le bot est arrêté 2 h | les cultures ne poussent pas — il faut un rattrapage | aucune, `now - planted_at` est toujours exact |
| Plusieurs *shards* | doivent se coordonner pour ne pas ticker deux fois | aucune coordination nécessaire, la lecture est pure |
| Testabilité | il faut simuler le temps | il suffit de passer un `now` en paramètre |

Le corollaire est que **le temps est un paramètre explicite** partout dans
`src/game/**` : aucune fonction n'appelle `Date.now()` elle-même. C'est ce qui rend
les 90 tests déterministes.

Les jobs planifiés ne « font pas pousser » : ils gèrent uniquement des **événements
discrets** que la dérivation ne peut pas produire (apparition de nuisibles, dégâts,
flétrissement, mise à jour du marché, intérêts). Leur granularité peut être
grossière sans que le joueur le perçoive.

### 1.3 Graphiques en canvas maison plutôt que `chartjs-node-canvas`

`chartjs-node-canvas` embarque Chart.js et une couche d'adaptation supplémentaire
au-dessus de canvas, pour un besoin réel très étroit : **une** courbe de prix avec
grille et étiquettes. Le tracer directement (`src/render/chart.ts`, ~150 lignes)
supprime deux dépendances lourdes, garantit la cohérence visuelle avec les autres
images (même palette, mêmes polices, mêmes coins arrondis) et évite les problèmes
connus d'adaptation de version entre Chart.js et le backend canvas.

---

## 2. Arborescence et rôle de chaque module

```
harvester/
├── src/
│   ├── index.ts                 Point d'entrée : env → config → DB → Redis → jobs → HTTP → Discord
│   ├── shard.ts                 ShardingManager, pour > 2 500 serveurs
│   ├── client.ts                Construction du Client (intents minimaux, limites de cache)
│   │
│   ├── config/
│   │   ├── env.ts               Schéma Zod de l'environnement — échec au démarrage si invalide
│   │   ├── index.ts             Chargement, validation croisée et rechargement à chaud du gameplay
│   │   └── gameplay/            10 fichiers JSON : crops, animals, items, recipes, buildings,
│   │                            balance, quests, achievements, events, season-pass
│   │
│   ├── db/
│   │   ├── client.ts            Pool pg, helper `transaction()`, verrous de ligne
│   │   ├── redis.ts             3 connexions (principale, souscripteur, BullMQ)
│   │   └── schema/              48 tables Drizzle, réparties par domaine
│   │
│   ├── game/                    ⚠ MOTEUR PUR — aucune E/S, aucun import d'env, 100 % testable
│   │   ├── xp.ts  growth.ts  harvest.ts  quality.ts  market.ts  grid.ts
│   │   ├── money.ts  modifiers.ts  plot.ts  world.ts  animals.ts
│   │   └── energy.ts  prestige.ts  coop.ts  rng.ts
│   │
│   ├── repositories/            Accès aux données. SQL uniquement, aucune règle de jeu.
│   │   └── player · farm · inventory · economy · animal · progression · social · trade · system
│   │
│   ├── services/                Orchestration : règles + transactions + effets de bord
│   │   └── world · player · tracker · inventory · economy · farm · market · animal
│   │       · craft · progression · coop · trade · misc · consumable
│   │
│   ├── commands/                12 fichiers, ~70 commandes + 2 menus contextuels
│   ├── components/              buttons/ · selects/ · modals/ — chargés dynamiquement
│   ├── events/                  interactionCreate, guildCreate/Delete, rapport d'erreurs
│   │
│   ├── framework/
│   │   ├── registry.ts          Chargeur dynamique (le nom du dossier détermine le type)
│   │   ├── interaction.ts       Pipeline commun : maintenance, ban, cooldown, verrou, erreurs
│   │   ├── ui.ts                Fabriques d'embeds, boutons, pagination
│   │   ├── views.ts             Vues partagées commande ⇄ composant (source unique de vérité)
│   │   └── cooldown.ts          Cooldowns Redis (`SET NX PX`)
│   │
│   ├── render/                  canvas · sprites · farm · profile · chart · leaderboard · index
│   ├── jobs/                    definitions (15 tâches cron) · scheduler · notifications
│   ├── http/health.ts           /health et /metrics
│   ├── i18n/                    fr.json (défaut) · en.json
│   ├── utils/                   custom-id · lock · errors · format · time · logger · uuid
│   ├── types/                   Types partagés
│   └── scripts/                 migrate · seed · deploy-commands · balance-report · render-preview
│
├── drizzle/                     0000_init.sql (généré) · 0001_triggers_and_guards.sql (manuel)
├── tests/                       game-logic (60) · config-and-balance (30)
├── assets/                      sprites/ fonts/ banners/ — vides, remplaçables à chaud
└── docs/                        01 à 06
```

### Règle de dépendance, stricte et vérifiable

```
commands ──► services ──► repositories ──► db
components ─┘     │
                  ▼
                game/ (pur)          render/ (pur, sauf cache Redis)
```

- Une **commande** ne fait jamais de SQL. Elle parse, appelle un service, rend une vue.
- Un **service** ne connaît pas discord.js. Il reçoit des identifiants et des
  valeurs, renvoie des objets simples ou lève une `GameError` typée.
- Un **repository** ne connaît aucune règle de jeu. Il lit et écrit, point.
- **`src/game/**` n'importe rien** hors de lui-même et de `../config` (lecture
  seule). C'est ce qui permet de le tester sans base, sans Redis, sans Discord.

---

## 3. Flux d'une interaction

```
      Discord Gateway
            │
            ▼
  events/interaction-create.ts
            │
            ├─ isChatInputCommand ─────────┐
            ├─ isAutocomplete ─────┐       │
            ├─ isButton / isSelect │       │
            ├─ isModalSubmit       │       │
            └─ isContextMenu       │       │
                                   │       │
                                   ▼       ▼
                        registry.resolve(customId | commandName)
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │ framework/interaction.ts     │
                    │  1. mode maintenance ?       │
                    │  2. joueur banni éco ?       │
                    │  3. parseCustomId + assertOwner
                    │  4. cooldown Redis           │
                    │  5. verrou anti-double-clic  │
                    │  6. defer (Update ou Reply)  │
                    └──────────────┬───────────────┘
                                   ▼
                            services/*.service.ts
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        game/* (pur)      db.transaction()        tracker.service
      règles, calculs     ├ SELECT … FOR UPDATE   quêtes, succès,
      déterministes       ├ validation sous verrou passe, stats
                          ├ écritures
                          └ ligne de grand livre
                                   │
                                   ▼
                            framework/views.ts
                          (embed + composants + image)
                                   │
                                   ▼
                       render/index.ts ──► cache Redis
                          │        └─ échec/timeout ──► repli texte
                          ▼
                       AttachmentBuilder → editReply
```

**Point clé** : `framework/views.ts` est appelé **aussi bien** par la commande
`/farm` que par le bouton « rafraîchir ». Une vue n'existe qu'une fois. C'est ce
qui garantit qu'un bouton ne peut pas dériver de la commande qu'il prolonge.

---

## 4. Transactions et intégrité économique

Toute opération qui touche un solde suit le **même squelette en 7 étapes**,
documenté dans `src/services/farm.service.ts` et respecté partout :

```ts
// 1. Lecture hors transaction : contexte, configuration, calculs préparatoires
const ctx = await loadContext(userId);

// 2-7 dans une seule transaction
return db.transaction(async (tx) => {
  // 2. VERROUS, dans un ordre déterministe (identifiants triés → pas d'interblocage)
  const user = await lockUserRow(tx, userId);

  // 3. VALIDATION SOUS VERROU — on revalide tout : entre 1 et 2, l'état a pu changer
  if (user.coins < cost) throw new GameError('INSUFFICIENT_FUNDS');

  // 4. CONSOMMATION (débit, retrait d'inventaire)
  await economyRepo.debit(tx, userId, cost, 'seed_purchase');

  // 5. PRODUCTION (écriture du résultat)
  await farmRepo.plant(tx, plotId, crop, readyAt);

  // 6. SUIVI (quêtes, succès, statistiques) — dans la MÊME transaction
  await tracker.track(tx, userId, 'plant', { cropId });

  // 7. COMMIT implicite. En cas d'exception : rollback total.
});
```

Trois invariants en découlent :

1. **Le grand livre est complet.** `economyRepo.debit/credit` écrit une ligne
   `transactions` (montant signé + `balance_after`) dans la même transaction que la
   modification du solde. Il n'existe aucun chemin de code qui modifie `users.coins`
   sans passer par là — sauf `recordGenesisLedger`, qui écrit la ligne d'origine
   d'un solde initial **sans** toucher au solde (utilisé à la création de compte et
   au prestige, précisément pour ne pas créditer deux fois).
2. **Aucun solde négatif.** Ceinture *et* bretelles : validation applicative sous
   verrou, plus `CHECK (coins >= 0)` en base.
3. **Vérification périodique.** Le job `economy_snapshot` recalcule
   `SUM(transactions.amount)` par joueur et le compare à `users.coins` (vue
   `ledger_integrity`). Un écart est un bug ou une triche : il est journalisé et
   remonté dans le salon d'erreurs.

**Interblocages.** Les opérations à deux joueurs (échange, don, achat HDV)
verrouillent via `lockUserRows(tx, ids)` qui **trie les identifiants** avant de
verrouiller. Deux transactions symétriques prennent donc les verrous dans le même
ordre : l'interblocage est structurellement impossible.

---

## 5. Cache, verrous et files Redis

Trois connexions distinctes, parce que `ioredis` bascule une connexion en mode
souscription exclusif et que BullMQ exige `maxRetriesPerRequest: null` :

| Connexion | Usage |
|---|---|
| `redis` | cache, cooldowns, verrous, boosts temporaires, cache de rendu |
| `subscriber` | pub/sub inter-*shards* (rechargement de config, annonces) |
| `bullmq` | files de tâches planifiées |

**Verrou anti-double-clic** : `SET lock:<user>:<action> <token> NX PX 5000`. Le
détenteur seul peut relâcher (comparaison du jeton) ; l'expiration garantit qu'un
processus tué ne bloque personne plus de 5 secondes.

**Cooldowns** : `SET cd:<user>:<cmd> 1 NX PX <ms>` puis `PTTL` pour le message
d'attente. Configurés par commande dans `balance.json`, donc modifiables à chaud.

**Cache de rendu** : clé = `render:<type>:<sha1(état)>`, TTL 120 s. Le hash porte
sur l'état *rendu* (stades, échéances arrondies à la minute, météo, monnaies) :
rafraîchir sans changement réutilise l'image, la moindre évolution invalide la clé.

---

## 6. Planification

### 6.1 Les 15 tâches

| Tâche | Fréquence | Rôle |
|---|---|---|
| `market` | horaire | Recalcule les prix selon offre/demande |
| `daily_shop` | 00:05 | Génère la boutique du jour |
| `world` | 00:00 | Fixe la météo, met à jour la saison |
| `pests` | toutes les 2 h | Fait apparaître nuisibles et dégâts météo |
| `pest_damage` | toutes les 2 h (+30) | Applique les conséquences des nuisibles ignorés |
| `wither` | horaire (+15) | Fait faner les cultures abandonnées |
| `animals` | toutes les 3 h | Matérialise faim/bonheur/santé, maladies, décès |
| `harvest_notify` | 10 min | Prévient les joueurs opt-in |
| `auctions` | 5 min | Clôture les enchères, rembourse les mises perdantes |
| `quests` | 00:10 | Expire les quêtes du cycle écoulé |
| `coop_objectives` | 15 min | Distribue les récompenses collectives |
| `bank_interest` | 03:00 | Verse les intérêts |
| `economy_snapshot` | 30 min | Instantané économique + vérification du grand livre |
| `weekly_reset` | lundi 00:00 | Fige les classements, réinitialise les compteurs |
| `cleanup` | 04:00 | Purge historiques, piles vides, verrous |

### 6.2 Déduplication entre *shards*

Avec `QUEUES_ENABLED=true`, chaque tâche est enregistrée comme *repeatable job*
BullMQ avec un `jobId` stable. Peu importe combien de *shards* démarrent : BullMQ
dédoublonne, la tâche s'exécute **une seule fois**. Le repli minuteur
(`QUEUES_ENABLED=false`) convient au développement mono-processus et est
explicitement déconseillé en production multi-*shard*.

### 6.3 Migrations

`src/scripts/migrate.ts` est un runner maison volontairement strict :

- il applique les fichiers `drizzle/*.sql` dans l'ordre, chacun dans **sa** transaction ;
- il enregistre le **hash SHA-256** de chaque fichier appliqué ;
- il **refuse de démarrer** si un fichier déjà appliqué a été modifié — c'est la
  garantie qu'un environnement ne dérive pas silencieusement d'un autre.

`0000_init.sql` est généré par `drizzle-kit` (48 tables, 137 index, 91 contraintes
`CHECK`). `0001_triggers_and_guards.sql` est écrit à la main : *triggers*
`updated_at`, *triggers* d'immuabilité, index partiels et fonctionnels, garde
anti-boucle de parrainage, vue `ledger_integrity`.

---

## 7. Montée en charge

**Jusqu'à ~2 500 serveurs** : un seul processus suffit. Les intents sont réduits à
`Guilds` (aucun `GuildMembers`, aucun `MessageContent` : rien à demander à Discord,
donc pas de vérification d'intent privilégié), et les caches discord.js sont
limités à zéro pour tout ce qui n'est pas nécessaire.

**Au-delà** : `npm run start:sharded` lance `ShardingManager`. Comme aucun état de
jeu ne vit en mémoire — tout est en PostgreSQL et Redis — un *shard* est
interchangeable et redémarrable sans conséquence. Les jobs restent dédupliqués par
BullMQ.

**Points de contention identifiés et traités** : la ligne `users` du joueur (verrou
court, transactions de quelques millisecondes) ; la table `market_prices` (une
seule écriture par heure, par le job) ; l'inventaire (unicité sur
`(user, item, quality, mutation)` + `onConflictDoUpdate`, donc pas de course).

---

## 8. Erreurs, sécurité, observabilité

**Erreurs.** `GameError` porte un code et un message joueur ; toute autre exception
est capturée par `framework/interaction.ts`, journalisée avec son contexte
(utilisateur, commande, identifiant d'interaction) et postée dans
`DISCORD_ERROR_CHANNEL_ID`. Le joueur reçoit un message générique — jamais une
trace de pile.

**Sécurité.**
- Aucun secret dans le code ; `.env` validé par Zod au démarrage, **échec immédiat**
  si un champ manque ou est malformé.
- Toute entrée utilisateur est validée : bornes sur les options numériques,
  longueurs maximales, listes blanches d'énumérations, filtrage des noms.
- `assertOwner` sur chaque composant.
- Requêtes exclusivement paramétrées (aucun `sql.raw` avec une valeur utilisateur ;
  le seul usage de JSONB dynamique passe par un paramètre lié `::jsonb`).
- L'image Docker tourne en utilisateur non privilégié (uid 10001).

**Observabilité.** Pino en JSON structuré avec `service`, `shard`, `mod` ;
`GET /health` vérifie Discord **et** PostgreSQL (un processus vivant mais
déconnecté est déclaré malsain et redémarré par Docker) ; `GET /metrics` expose
compteurs de commandes, latences, taille des files et santé du grand livre.
