<div align="center">

<img src="assets/brand/harvester-avatar.png" alt="Harvester" width="132">

# 🌾 Harvester

**Jeu de ferme persistant pour Discord — prêt pour la production.**

27 cultures · 13 animaux · 32 recettes · 18 bâtiments · ~70 commandes
48 tables PostgreSQL · images générées · économie fermée et auditée

</div>

---

## Sommaire

1. [Ce que c'est](#1-ce-que-cest)
2. [Prérequis](#2-prérequis)
3. [Installation en 10 minutes](#3-installation-en-10-minutes)
4. [Créer l'application Discord](#4-créer-lapplication-discord)
5. [Configuration](#5-configuration)
6. [Déploiement avec Docker](#6-déploiement-avec-docker)
7. [Déploiement sans Docker (PM2 / systemd)](#7-déploiement-sans-docker-pm2--systemd)
8. [Commandes](#8-commandes)
9. [Exploitation au quotidien](#9-exploitation-au-quotidien)
10. [Développement](#10-développement)
11. [Dépannage](#11-dépannage)
12. [Documentation](#12-documentation)

---

## 1. Ce que c'est

Un jeu de gestion de ferme joué entièrement dans Discord. Chaque joueur possède
**une ferme globale liée à son compte Discord** — elle le suit sur tous les serveurs.
La boucle est classique et éprouvée : semer, entretenir, récolter, transformer,
vendre, réinvestir, monter de niveau, débloquer.

Les partis pris qui structurent tout le reste :

- **Aucun pay-to-win.** Les gemmes ne s'achètent pas. Aucun point d'entrée n'existe
  dans le code pour en vendre.
- **Sessions de 2 à 5 minutes.** Toute action utile tient en une commande.
- **Économie fermée et vérifiée.** Chaque mouvement de pièces écrit une ligne de
  grand livre dans la même transaction SQL ; l'invariant est contrôlé toutes les
  30 minutes.
- **Pas de tick global.** La pousse est calculée à la lecture depuis les
  horodatages. Un joueur inactif ne coûte rien. Voir
  [02 § 1.2](./docs/02-architecture.md#12-pousse-calculée-à-la-lecture--décision-fondamentale).

---

## 2. Prérequis

| Outil | Version | Note |
|---|---|---|
| Node.js | **20 LTS ou plus** | `node --version` |
| npm | 10+ | fourni avec Node 20 |
| PostgreSQL | **16** | ou le service Docker fourni |
| Redis | **7** | ou le service Docker fourni |
| Docker + Compose | récent | *optionnel mais recommandé* |

Sous Linux hors Docker, `@napi-rs/canvas` est un binaire précompilé et n'exige
aucune bibliothèque système. Pour que les emoji s'affichent correctement dans les
images, installez une police couleur :

```bash
sudo apt install fonts-noto-color-emoji fonts-dejavu-core
```

L'image Docker le fait déjà.

---

## 3. Installation en 10 minutes

```bash
# 1. Récupérer le projet et installer
git clone <votre-dépôt> harvester && cd harvester
npm install

# 2. Configurer
cp .env.example .env
$EDITOR .env          # au minimum : DISCORD_TOKEN, DISCORD_CLIENT_ID, BOT_OWNER_IDS

# 3. Lancer PostgreSQL et Redis
docker compose up -d db redis

# 4. Créer le schéma et charger la configuration de jeu
npm run db:migrate
npm run db:seed

# 5. Publier les commandes slash
npm run commands:deploy

# 6. Démarrer
npm run dev           # développement, rechargement à chaud
```

Le bot est en ligne. Tapez `/start` dans un serveur où il est invité.

> **Vérification sans rien installer.** `npm run balance:report` et
> `npm run render:preview` fonctionnent **sans base ni Redis ni token** (voir
> `src/scripts/offline-env.ts`) : le premier
> imprime toutes les tables d'équilibrage, le second écrit quatre PNG dans `out/`.
> C'est le moyen le plus rapide de voir ce que le projet produit.

---

## 4. Créer l'application Discord

1. Ouvrez le [portail développeur Discord](https://discord.com/developers/applications)
   → **New Application**.
2. Onglet **Bot** → **Reset Token** → copiez le jeton dans `DISCORD_TOKEN`.
   *Ce jeton ne s'affiche qu'une fois.*
3. Onglet **General Information** → copiez l'**Application ID** dans
   `DISCORD_CLIENT_ID`.
4. **Aucun intent privilégié n'est nécessaire.** Harvester n'utilise que l'intent
   `Guilds` : il ne lit aucun message et n'énumère aucun membre. Laissez *Message
   Content Intent* et *Server Members Intent* **désactivés**.
5. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot` et `applications.commands`
   - Permissions : `Send Messages`, `Embed Links`, `Attach Files`,
     `Use External Emojis`, `Read Message History`
6. Ouvrez l'URL générée et invitez le bot sur votre serveur.

Pour récupérer votre identifiant Discord (`BOT_OWNER_IDS`) : activez le mode
développeur (*Paramètres → Avancés*), puis clic droit sur votre nom → *Copier
l'identifiant*.

---

## 5. Configuration

### 5.1 Variables d'environnement

Le fichier `.env` est validé par **Zod au démarrage** : une variable manquante ou
malformée fait échouer le lancement immédiatement, avec le nom du champ fautif.
`.env.example` est intégralement commenté ; voici l'essentiel.

**Obligatoires**

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Jeton du bot |
| `DISCORD_CLIENT_ID` | Identifiant de l'application |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/harvester` |
| `REDIS_URL` | `redis://host:6379` |
| `BOT_OWNER_IDS` | Identifiants autorisés à `/admin`, séparés par des virgules |

**Recommandées**

| Variable | Défaut | Rôle |
|---|---|---|
| `DISCORD_DEV_GUILD_ID` | — | Publie les commandes sur **un** serveur : propagation **instantanée** au lieu d'une heure. Indispensable en développement, à retirer en production. |
| `DISCORD_ERROR_CHANNEL_ID` | — | Salon privé recevant les erreurs et alertes économiques |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | — | Salon des annonces `/admin announce` |
| `NODE_ENV` | `development` | `production` en exploitation |
| `LOG_LEVEL` | `info` | `debug` pour diagnostiquer |
| `LOG_PRETTY` | `false` | `true` en développement (sortie lisible) |
| `HTTP_PORT` | `3001` | `/health`, `/ready`, `/metrics`, `/api/v1/*` |

**Réglages de jeu modifiables sans redéploiement**

| Variable | Défaut | Rôle |
|---|---|---|
| `SEASON_LENGTH_DAYS` | `14` | Durée d'une saison en jours réels |
| `GLOBAL_GROWTH_MULTIPLIER` | `1.0` | `< 1` accélère la pousse (événements) |
| `GLOBAL_ECONOMY_MULTIPLIER` | `1.0` | Multiplie tous les gains |
| `ENERGY_SYSTEM_ENABLED` | `true` | Système d'énergie ; `false` pour un rythme libre |
| `MARKET_UPDATE_MINUTES` | `60` | Fréquence de recalcul des prix |
| `RENDER_ENABLED` | `true` | `false` bascule tout en embeds texte |
| `RENDER_CACHE_TTL` | `120` | Durée du cache d'images (s) |
| `RENDER_TIMEOUT_MS` | `4000` | Budget de rendu avant repli texte |
| `MAINTENANCE_MODE` | `false` | Bloque le jeu sauf `/admin` |
| `QUEUES_ENABLED` | `true` | BullMQ ; `false` = minuteurs (mono-processus **uniquement**) |
| `SHARDING_TOTAL` | `auto` | Nombre de shards. **Ne jamais nommer cette variable `SHARD_COUNT`** : ce nom appartient au protocole interne de discord.js. |

### 5.2 Équilibrage — les 10 fichiers JSON

Tout le gameplay vit dans `src/config/gameplay/` :

| Fichier | Contenu |
|---|---|
| `crops.json` | 27 cultures |
| `animals.json` | 13 espèces |
| `items.json` | ~85 objets explicites (138 avec les dérivés) |
| `recipes.json` | 32 recettes |
| `buildings.json` | 18 bâtiments |
| `balance.json` | Tous les nombres : XP, prestige, parcelles, fertilité, qualité, marché, taxes, cooldowns… |
| `quests.json` | 52 quêtes |
| `achievements.json` | 28 succès |
| `events.json` | 6 événements |
| `season-pass.json` | 30 paliers |

Le contenu est **bilingue** : chaque entrée porte `name`/`description` en français
et `nameEn`/`descriptionEn` en anglais. Le chargeur dérive une variante complète de
la configuration par langue, si bien que `getConfig(locale)` renvoie des entrées dont
`name` est déjà traduit — aucun des ~140 points d'affichage n'a à s'en occuper. Un
test échoue si une entrée n'a pas sa traduction.

Ils sont validés par Zod **avec vérification croisée** : une recette référençant un
ingrédient inexistant, un animal exigeant un bâtiment absent ou une quête ciblant une
culture inconnue empêchent le démarrage, avec un message précis.

**Rechargement à chaud** : `/admin reload-config`. Si la nouvelle configuration est
invalide, elle est **rejetée** et l'ancienne reste active — un JSON mal formé ne peut
pas mettre le bot à terre.

Après toute modification, exécutez `npm run balance:report` pour voir l'impact
chiffré, et `npm test` pour vérifier qu'aucun invariant d'équilibrage n'est cassé.

---

## 6. Déploiement avec Docker

```bash
# Configurer
cp .env.example .env && $EDITOR .env

# Infrastructure
docker compose up -d db redis

# Schéma et données de configuration.
# Noter le suffixe `:prod` : l'image finale ne contient ni `tsx` (devDependency)
# ni les sources TypeScript, uniquement `dist/`. Les variantes sans suffixe sont
# réservées au développement.
docker compose run --rm bot npm run db:migrate:prod
docker compose run --rm bot npm run db:seed:prod
docker compose run --rm bot npm run commands:deploy:prod

# Tout démarrer
docker compose up -d

# Suivre
docker compose logs -f bot
```

L'image est construite en **quatre étapes** : dépendances, compilation (`tsc` **et**
`npm test` — une image ne se construit pas si les tests échouent), dépendances de
production seules, image finale. Résultat : ~180 Mo, sans sources TypeScript ni
outillage de développement, exécutée par un utilisateur non privilégié (uid 10001).

Le `HEALTHCHECK` interroge `/health`, qui vérifie **Discord et PostgreSQL** : un
processus vivant mais déconnecté est déclaré malsain et redémarré.

Les sprites sont montés en lecture seule depuis `./assets` : les remplacer ne
nécessite **pas** de reconstruire l'image.

### Mise à jour

```bash
git pull
docker compose build bot
docker compose run --rm bot npm run db:migrate:prod   # si une migration est arrivée
docker compose up -d bot
```

---

## 7. Déploiement sans Docker (PM2 / systemd)

```bash
npm ci --omit=dev        # dépendances de production
npm run build            # compile vers dist/ et copie config + traductions
npm run db:migrate:prod
npm run db:seed:prod
npm run commands:deploy:prod
```

### PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name harvester --time
pm2 save && pm2 startup
```

Au-delà de 2 500 serveurs, utilisez `dist/shard.js` :

```bash
pm2 start dist/shard.js --name harvester-shards --time
```

### systemd

```ini
# /etc/systemd/system/harvester.service
[Unit]
Description=Harvester
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=harvester
WorkingDirectory=/opt/harvester
EnvironmentFile=/opt/harvester/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now harvester
journalctl -u harvester -f
```

> **Un seul processus doit exécuter les tâches planifiées.** Si vous lancez
> plusieurs instances sans *sharding*, laissez `QUEUES_ENABLED=true` (BullMQ
> dédoublonne) ou mettez `SCHEDULER_ENABLED=false` sur toutes sauf une.

---

## 8. Commandes

### Démarrage

| Commande | Rôle |
|---|---|
| `/start [code]` | Accueil et code de parrainage |
| `/tutorial` | Guide interactif paginé |
| `/help [category]` | Aide complète |
| `/lang [language]` | Changer la langue de l'interface (français / anglais) |
| `/apikey create\|list\|revoke` | Clés d'API personnelles pour l'API publique en lecture |
| `/webhook create\|list\|delete\|test` | Webhooks sortants vers un service tiers (récolte prête, enchère remportée) |

### Ferme

| Commande | Rôle |
|---|---|
| `/farm [@user]` | Vue de la ferme **(image)** |
| `/plant <seed> [plot] [quantity]` | Semer |
| `/harvest [plot]` | Récolter une parcelle ou tout |
| `/water [plot]` | Arroser |
| `/fertilize <fertilizer> [plot]` | Fertiliser |
| `/weed [plot]` | Désherber |
| `/treat [plot]` | Traiter les nuisibles |
| `/plots` | État détaillé, paginé |
| `/buy-plot` | Étendre la ferme |
| `/crops [rarity] [season]` | Encyclopédie des cultures |
| `/fish` | Pêcher à l'étang, minijeu de timing **(image)** |
| `/mine` | Miner un peu plus profond **(image)** |

### Élevage

| Commande | Rôle |
|---|---|
| `/animals` | Vos animaux **(image)** |
| `/buy-animal <species> [quantity]` | Acheter |
| `/feed [animal]` | Nourrir un animal ou tous |
| `/collect [animal]` | Collecter les produits |
| `/heal <animal>` | Soins vétérinaires |
| `/pet <animal>` | Augmenter le bonheur |
| `/breed <parent1> <parent2>` | Reproduction |
| `/sell-animal <animal>` | Vendre |

### Économie

| Commande | Rôle |
|---|---|
| `/shop [category]` | Boutique du jour |
| `/buy <item> [quantity]` | Acheter |
| `/sell <item> [quantity\|all]` | Vendre |
| `/market [category]` | Cours actuels |
| `/market-history <item>` | Graphique de prix **(image)** |
| `/inventory [category] [page]` | Inventaire paginé |
| `/item <name>` | Fiche détaillée |
| `/use <item> [quantity]` | Consommer |
| `/discard <item> <quantity>` | Jeter |
| `/bank balance\|deposit\|withdraw\|upgrade` | Banque |
| `/gift <@user> <amount>` | Don (taxé) |
| `/black-market` | Marché noir tournant, stock très limité, niveau 30+ |

### Transformation

| Commande | Rôle |
|---|---|
| `/craft <recipe> [quantity]` | Lancer une production |
| `/recipes [category]` | Recettes disponibles |
| `/production` | Productions en cours et collecte |
| `/buildings` | Vos bâtiments |
| `/build` | Construire ou améliorer |

### Progression

| Commande | Rôle |
|---|---|
| `/profile [@user]` | Carte de profil **(image)** |
| `/stats [@user]` | Statistiques détaillées |
| `/balance [@user]` | Monnaies |
| `/settings` | Langue, fuseau, notifications, confidentialité, mode compact |
| `/prestige` | Renaissance (niveau 60) |
| `/quests [type]` | Quêtes en cours |
| `/reroll-quest <quest>` | Relance payante |
| `/achievements [category]` | Succès |
| `/pass` | Passe saisonnier |
| `/daily` | Récompense quotidienne et série |
| `/vote` | Récompense de vote top.gg |
| `/companion list\|equip\|unequip` | Compagnons de ferme cosmétiques, débloqués par niveau |

### Social et échanges

| Commande | Rôle |
|---|---|
| `/coop create\|join\|leave\|info\|members\|invite\|kick\|promote\|treasury\|contribute\|objectives` | Coopératives |
| `/leaderboard [type] [scope]` | Classements **(image)** |
| `/visit <@user>` | Visiter une ferme |
| `/assist <@user>` | Aider (gain mutuel) |
| `/referral` | Votre code et vos filleuls |
| `/auction list\|sell\|buy\|my-listings\|cancel` | Hôtel des ventes |
| `/order create\|list\|cancel` | Ordres d'achat permanents sur l'hôtel des ventes |
| `/trade <@user>` | Échange direct sécurisé |

### Monde

| Commande | Rôle |
|---|---|
| `/weather` | Météo du jour et effets |
| `/season` | Saison en cours |
| `/event` | Événement actif |
| `/encyclopedia <term>` | Recherche universelle |

### Administration — `BOT_OWNER_IDS` uniquement

| Commande | Rôle |
|---|---|
| `/admin give\|take` | Ajuster les ressources d'un joueur |
| `/admin reset <@user> <reason>` | Réinitialiser un joueur |
| `/admin eco-ban <@user> <duration> <reason>` | Bannissement économique |
| `/admin maintenance <enabled> [message]` | Mode maintenance |
| `/admin announce` | Annonce globale (modal) |
| `/admin reload-config` | Recharger le gameplay à chaud |
| `/admin stats` | Tableau de bord |
| `/admin lookup <@user>` | Inspecter un joueur |
| `/admin market-update` | Forcer une mise à jour du marché |

### Menus contextuels

Clic droit sur un membre → **Voir la ferme** · **Proposer un échange**.

---

## 9. Exploitation au quotidien

### Points de contrôle HTTP

| Route | Rôle |
|---|---|
| `GET /health` (ou `/healthz`) | Discord **et** PostgreSQL — utilisé par Docker |
| `GET /ready` | Prêt à recevoir du trafic |
| `GET /metrics` | Compteurs, latences, files, santé du grand livre |
| `GET /api/v1/*` | API publique en lecture, à clé — voir [07 — API publique](./docs/07-api-publique.md) |

### Sauvegardes

```bash
# Sauvegarde
docker compose exec -T db pg_dump -U harvester harvester | gzip > backup-$(date +%F).sql.gz

# Restauration
gunzip -c backup-2026-07-26.sql.gz | docker compose exec -T db psql -U harvester harvester
```

Redis ne contient que du cache, des cooldowns et des files : sa perte est sans
conséquence sur les données de jeu. **PostgreSQL est la seule source de vérité à
sauvegarder.**

### Surveiller l'économie

```sql
-- Écarts entre solde et grand livre. La vue filtre déjà : elle doit être VIDE.
SELECT * FROM ledger_integrity;

-- Masse monétaire et flux, heure par heure
SELECT * FROM economy_snapshots ORDER BY created_at DESC LIMIT 24;
```

`/admin stats` donne la même chose depuis Discord. Le job `economy_snapshot` alerte
automatiquement dans le salon d'erreurs si la masse monétaire croît de plus de 8 %
par jour.

### Mode maintenance

```
/admin maintenance état:true message:Migration en cours, retour dans 10 minutes
```

Toutes les commandes de jeu répondent alors par un message d'attente ; `/admin`
reste accessible.

---

## 10. Développement

```bash
npm run dev              # rechargement à chaud (tsx watch)
npm run typecheck        # tsc --noEmit
npm test                 # 125 tests, sans infrastructure (logique pure + config)
npm run test:watch       # mode veille
npm run test:coverage    # couverture (seuil 70 % sur src/game/**)
npm run test:integration # suite Testcontainers (Docker requis) : transactions concurrentes
npm run db:studio        # explorateur de base Drizzle
npm run balance:report   # tables d'équilibrage
npm run render:preview   # écrit 4 PNG dans out/fr/
npm run render:preview:en # les mêmes en anglais, dans out/en/
npm run brand            # régénère l'avatar et la bannière du bot
npm run commands:clear   # retire les commandes publiées
```

### Organisation du code

```
src/
├── commands/      Parse les options, appelle un service, rend une vue. Jamais de SQL.
├── components/    buttons/ selects/ modals/ — chargés dynamiquement par nom de dossier
├── services/      Règles + transactions. Ne connaît pas discord.js.
├── repositories/  SQL uniquement. Ne connaît aucune règle de jeu.
├── game/          Moteur PUR : aucune E/S, entièrement testable
├── render/        Génération d'images canvas
├── jobs/          15 tâches planifiées
└── framework/     Registre, pipeline d'interaction, vues partagées, cooldowns
```

La règle de dépendance est stricte :
`commands → services → repositories → db`, et `game/` n'importe rien d'autre que
lui-même. C'est ce qui permet aux 125 tests rapides de tourner **sans base de
données** ; `tests/integration/` (Testcontainers) est le seul endroit qui en
démarre une, volontairement séparé (`npm run test:integration`).

### Ajouter une culture

1. Ajoutez une entrée dans `src/config/gameplay/crops.json` (les graines et récoltes
   correspondantes sont **dérivées automatiquement** — pas d'objets à créer à la main).
2. `npm run balance:report` pour vérifier le profit horaire par rapport aux voisines.
3. `npm test` — les invariants d'équilibrage sont testés.
4. `npm run db:seed` pour propager dans `crops_config`.
5. Optionnel : déposez `assets/sprites/crops/<clé>_1.png` à `_5.png`.

Aucune ligne de code à écrire.

---

## 11. Dépannage

| Symptôme | Cause et solution |
|---|---|
| **Les commandes n'apparaissent pas** | Les commandes globales mettent jusqu'à 1 h à se propager. Définissez `DISCORD_DEV_GUILD_ID` et relancez `npm run commands:deploy` : la publication par serveur est instantanée. Vérifiez aussi que le scope `applications.commands` était bien coché à l'invitation. |
| **`Invalid environment` au démarrage** | Zod indique le champ fautif et pourquoi. Comparez avec `.env.example`. |
| **`ECONNREFUSED` PostgreSQL/Redis** | Services non démarrés (`docker compose up -d db redis`) ou `DATABASE_URL`/`REDIS_URL` pointant vers `localhost` depuis un conteneur — utilisez `db` et `redis`. |
| **`tsx: not found`** | Vous avez lancé un script de développement dans l'image de production. Celle-ci ne contient que `dist/` : utilisez les variantes `db:migrate:prod`, `db:seed:prod`, `commands:deploy:prod`. |
| **`failed to bind host port`** | Un autre service occupe déjà 6379 ou 5432 sur l'hôte (Redis système, autre pile Docker). Le port publié ne sert qu'à vous connecter depuis l'hôte : changez-le dans `.env` (`REDIS_PORT=6380`, `POSTGRES_PORT=5433`). Le bot passe par le réseau Docker interne et n'est pas concerné. |
| **`relation "users" does not exist`** | `npm run db:migrate` n'a pas été exécuté. |
| **Le migrateur refuse de démarrer** | Un fichier `.sql` déjà appliqué a été modifié : le hash ne correspond plus. C'est intentionnel. Restaurez le fichier et créez une **nouvelle** migration. |
| **Emoji en carrés dans les images** | Police couleur absente : `apt install fonts-noto-color-emoji`. Les indicateurs critiques (prêt, arrosage, nuisibles, météo, monnaies) sont dessinés en vectoriel et ne sont **jamais** affectés. |
| **Images non générées** | Le rendu dépasse `RENDER_TIMEOUT_MS` ou échoue : le bot bascule silencieusement en embed texte. Passez `LOG_LEVEL=debug` pour voir la cause. |
| **Tâches exécutées deux fois** | Plusieurs processus avec `QUEUES_ENABLED=false`. Passez à `true` (BullMQ dédoublonne) ou `SCHEDULER_ENABLED=false` partout sauf sur une instance. |
| **`Unknown interaction`** | Traitement dépassant 3 s sans `defer`. Le framework `defer` systématiquement ; si cela survient, c'est une commande ajoutée hors du pipeline. |

---

## 12. Documentation

| Document | Contenu |
|---|---|
| [01 — Cahier des charges](./docs/01-cahier-des-charges.md) | Périmètre fonctionnel complet, décision ferme globale, règles de jeu |
| [02 — Architecture](./docs/02-architecture.md) | Pile, arborescence commentée, flux d'interaction, transactions, montée en charge |
| [03 — Base de données](./docs/03-base-de-donnees.md) | 48 tables, stratégie de clés, verrouillage, immuabilité, index |
| [04 — Équilibrage](./docs/04-equilibrage.md) | Toutes les tables chiffrées et leur justification |
| [05 — Pipeline d'assets](./docs/05-pipeline-assets.md) | Conventions de nommage, sources libres, licences, cache |
| [06 — Roadmap](./docs/06-roadmap.md) | Extensions v2 et v3, dette technique, hors périmètre |
| [07 — API publique](./docs/07-api-publique.md) | Authentification, endpoints, webhooks, vérification de signature |

---

<div align="center">
<sub>Bon jeu. 🌱</sub>
</div>
