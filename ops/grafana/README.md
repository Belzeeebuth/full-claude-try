# Tableau de bord Grafana — Harvester

`harvester-dashboard.json` est un tableau de bord Grafana prêt à importer, branché
sur les métriques que le bot expose en `GET /metrics` (`src/http/health.ts`,
registre dans `src/http/metrics.ts`).

## Ce qu'il montre

| Ligne | Panneaux | Métriques |
|---|---|---|
| Interactions et erreurs | interactions/s, taux d'erreurs **par code**, erreurs internes, part d'interactions en erreur, erreurs par type | `harvester_interactions_total`, `harvester_commands_total`, `harvester_errors_total{code,kind}` |
| Latence | p50 / p95 / p99 **par commande** avec la ligne rouge des 3 s de Discord, commandes au-delà de 2,5 s, p95 des composants par namespace | `harvester_command_duration_seconds`, `harvester_component_duration_seconds` |
| Pool de rendu | file d'attente, occupation, rendus en attente | `harvester_render_workers`, `harvester_render_busy`, `harvester_render_queued` |
| Économie | masse monétaire, ratio faucet/sink (seuil visuel à **1**), écarts de journal, joueurs suspects, actifs 24 h, total, âge de l'instantané, pièces créées/détruites, gemmes | `harvester_economy_*` |
| Santé du process | latence WebSocket, serveurs, uptime | `harvester_ws_ping_ms`, `harvester_guilds`, `harvester_uptime_seconds` |

Deux variables en haut du tableau : la **source Prometheus** et l'**instance**
(un shard, ou toutes). Les compteurs sont sommés entre shards ; les jauges
économiques, identiques d'un shard à l'autre puisqu'elles viennent de la base,
sont lues avec `max()` pour ne pas être multipliées.

## Importer

1. Grafana → **Dashboards** → **New** → **Import**.
2. **Upload dashboard JSON file** et choisir `harvester-dashboard.json`
   (ou coller son contenu).
3. Dans la liste **Prometheus**, sélectionner la source de données qui scrape le
   bot, puis **Import**.

Le tableau garde l'identifiant `harvester-observability` : réimporter le fichier
après une mise à jour remplace la version en place (cocher *Overwrite*).

## Faire scraper `/metrics` par Prometheus

Le bot sert `/metrics` sur `HTTP_PORT` (3001 par défaut). Si `HTTP_METRICS_TOKEN`
est renseigné, Prometheus doit présenter ce jeton en `Authorization: Bearer` :

```yaml
scrape_configs:
  - job_name: harvester
    scrape_interval: 15s
    static_configs:
      - targets: ['harvester:3001']   # un target par shard
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/harvester-metrics-token
```

L'étiquette `instance` que Prometheus ajoute à chaque cible alimente la variable
du même nom dans le tableau.

## Lire les panneaux de latence

`harvester_command_duration_seconds` est mesurée dans `handleCommand`
(`src/events/interaction-create.ts`) du reçu de l'interaction jusqu'à la réponse,
**quel que soit le résultat** — succès, refus, cooldown, erreur. Les seaux
`2.5` et `5` encadrent les 3 secondes que Discord accorde avant d'afficher
« L'application ne répond pas » : le panneau *Commandes au-delà de 2,5 s* compte
directement les observations sorties du seau `2.5`, sans dépendre de
l'interpolation de `histogram_quantile`.

Les étiquettes sont bornées à la source (`src/http/metrics.ts`) : codes d'erreur
issus de l'union `GameErrorCode` + `internal|not_owner|busy|maintenance`, noms de
commandes du registre, namespaces de composants enregistrés. Toute autre valeur
apparaît sous `other`.
