# 07 — API publique

> API REST en lecture seule, plus des webhooks sortants, pour les communautés
> qui veulent construire leur propre tableau de bord sans passer par Discord.
> v3.2 de la [roadmap](./06-roadmap.md).

---

## 1. Vue d'ensemble

- **Base URL** : `http://<hôte>:<HTTP_PORT>/api/v1/` — le même serveur HTTP que
  `/health` et `/metrics` (`src/http/api.ts`), pas de service séparé à déployer.
  `HTTP_PORT` vaut `3001` par défaut ; en production, mettez ce port derrière un
  reverse proxy TLS, la même façon que vous exposeriez `/metrics`.
- **Lecture seule.** Aucune route n'écrit quoi que ce soit dans le jeu. L'écriture
  (planification de production, mise en vente…) est prévue pour le tableau de
  bord officiel ([v3.1](./06-roadmap.md#v31--tableau-de-bord-web)), pas pour
  l'API tierce.
- **Coupe-circuit global** : `balance.api.enabled` (rechargeable à chaud via
  `/admin reload-config`). À `false`, l'API renvoie `503` partout, et la
  création de nouvelles clés/webhooks est refusée — les intégrations existantes
  restent enregistrées, elles cessent juste de fonctionner le temps de
  l'incident.

## 2. Authentification

Toutes les routes exigent une clé personnelle, créée avec `/apikey create`
[label]` depuis Discord :

```
/apikey create label:"Tableau de bord coopérative"
→ 🔑 Clé d'API créée
   Votre clé : hvst_3f8a1c9e2b7d4560a1b2c3d4e5f6…
   ⚠️ Elle ne sera plus jamais affichée.
```

La clé brute (`hvst_…`) n'est montrée **qu'une seule fois**, au moment de la
création — seul son hachage SHA-256 est conservé en base, exactement comme un
mot de passe. Envoyez-la dans l'en-tête `Authorization` de chaque requête :

```
GET /api/v1/me HTTP/1.1
Host: votre-bot.example.com
Authorization: Bearer hvst_3f8a1c9e2b7d4560a1b2c3d4e5f6…
```

Gestion des clés, toujours depuis Discord :

| Commande | Rôle |
|---|---|
| `/apikey create [label]` | Créer une clé (jusqu'à `balance.api.maxKeysPerUser`, 3 par défaut) |
| `/apikey list` | Lister vos clés actives (préfixe, libellé, dernier usage) |
| `/apikey revoke <prefix>` | Révoquer une clé par son préfixe (affiché par `list`) |

Une clé révoquée ou inconnue renvoie `401 invalid_api_key` immédiatement — elle
n'est jamais silencieusement ignorée.

## 3. Limitation de débit

Chaque clé a son propre quota glissant (`balance.api.rateLimitPerMinute`, 60
requêtes/minute par défaut), le même mécanisme que les cooldowns de commandes
Discord (fenêtre glissante en Redis). Au-delà :

```
HTTP/1.1 429 Too Many Requests
Retry-After: 12
Content-Type: application/json

{ "error": "rate_limited", "retryAfterMs": 11842 }
```

Respectez `Retry-After` plutôt que de réessayer en boucle serrée.

## 4. Endpoints

### `GET /api/v1/me`

Profil et statistiques du titulaire de la clé.

```json
{
  "discordId": "123456789012345678",
  "username": "PommeDeTerre",
  "level": 42,
  "xp": 1830,
  "totalXp": 512430,
  "prestige": 1,
  "coins": 84250,
  "gems": 120,
  "title": "Maître fermier",
  "badges": ["early_adopter", "top_10_wealth"],
  "stats": {
    "totalHarvests": 3021,
    "totalPlanted": 3140,
    "totalCoinsEarned": 940120,
    "totalCoinsSpent": 855870,
    "totalAnimalsRaised": 58,
    "totalCrafts": 412,
    "totalWatered": 2200,
    "totalHelpGiven": 76,
    "bestHarvestValue": 4200,
    "playtimeSeconds": 512400
  }
}
```

### `GET /api/v1/me/coop`

Coopérative du titulaire de la clé. `404 not_in_a_coop` s'il n'en a aucune.

```json
{
  "id": "0191f2b0-...-uuid",
  "name": "Les Fermiers du Nord",
  "tag": "FDN",
  "emblem": "🌾",
  "description": "Coopérative détendue, objectifs hebdomadaires réguliers.",
  "level": 12,
  "xp": 3400,
  "xpForNext": 5000,
  "progress": 0.68,
  "treasury": 128500,
  "memberCount": 18,
  "memberLimit": 25,
  "weeklyScore": 9200,
  "totalScore": 184300,
  "isPublic": true,
  "joinRequirementLevel": 5,
  "bonuses": {
    "growthSpeed": 0.12,
    "sellBonus": 0.06,
    "xpBonus": 0.06,
    "qualityBonus": 0.03
  },
  "role": "officer"
}
```

`role` n'apparaît que si le titulaire de la clé est bien membre de cette
coopérative (`owner`, `officer` ou `member`).

### Erreurs

Toutes les erreurs ont la forme `{ "error": "<code>" }` :

| HTTP | `error` | Cause |
|---|---|---|
| 401 | `missing_api_key` | En-tête `Authorization: Bearer …` absent |
| 401 | `invalid_api_key` | Clé inconnue ou révoquée |
| 404 | `player_not_found` | Compte joueur introuvable (rare : la clé implique normalement un compte) |
| 404 | `not_in_a_coop` | `/me/coop` demandé par un joueur sans coopérative |
| 404 | `not_found` | Route inexistante |
| 405 | `method_not_allowed` | Toute méthode autre que `GET` |
| 429 | `rate_limited` | Quota dépassé, voir `Retry-After` |
| 503 | `api_disabled` | Coupe-circuit `balance.api.enabled` actif |
| 500 | `internal_error` | Incident côté serveur, journalisé |

## 5. Webhooks sortants

Pour être notifié en temps quasi réel plutôt que d'interroger l'API en boucle.

### Inscription

```
/webhook create url:https://votre-service.example.com/hooks/harvester events:crop_ready
→ 🪝 Webhook créé
   Identifiant : 7c1e2b3a-...
   Secret de signature : 9f8e7d6c5b4a...
   ⚠️ Le secret ne sera plus jamais affiché.
```

| Commande | Rôle |
|---|---|
| `/webhook create <url> <events>` | `events` = `crop_ready`, `auction_won` ou `all` |
| `/webhook list` | Lister vos webhooks (identifiant, URL, évènements, statut) |
| `/webhook delete <id>` | Supprimer un webhook |
| `/webhook test <id>` | Envoyer un ping de test immédiat, hors file |

Limite : `balance.api.maxWebhooksPerUser` (3 par défaut). `url` doit être en
`http://` ou `https://` (`https://` recommandé — le corps transite en clair
sur `http://`).

### Format de livraison

Chaque évènement est une requête `POST` distincte vers votre URL :

```
POST /hooks/harvester HTTP/1.1
Content-Type: application/json
X-Harvester-Event: crop_ready
X-Harvester-Signature: 5f4dcc3b5aa765d61d8327deb882cf99...

{
  "event": "crop_ready",
  "data": { "plotSlot": 4, "cropKey": "wheat", "readyAt": "2026-07-28T14:32:00.000Z" },
  "sentAt": "2026-07-28T14:32:01.203Z"
}
```

### Vérification de signature

`X-Harvester-Signature` est un HMAC-SHA256 du corps brut de la requête, avec
le secret affiché à la création du webhook. Vérifiez-la **avant** de traiter
le corps, avec une comparaison à temps constant :

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValidSignature(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signatureHeader, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`rawBody` doit être le corps **tel que reçu**, avant tout `JSON.parse` — un
corps re-sérialisé peut différer octet pour octet (ordre des clés, espaces) et
casser la vérification.

### Évènements disponibles

| Évènement | Déclenché quand | Champs de `data` |
|---|---|---|
| `crop_ready` | Une parcelle du joueur devient récoltable | `plotSlot`, `cropKey`, `readyAt` |
| `auction_won` | Le joueur remporte une enchère à l'hôtel des ventes | `listingId`, `itemKey`, `quantity`, `quality`, `mutation`, `pricePaid` |

D'autres types d'évènements pourront s'ajouter ; un webhook abonné à `all`
recevra automatiquement les nouveaux types sans qu'il faille le reconfigurer —
un webhook abonné à une liste explicite ne recevra que celle-ci.

### Fiabilité et désactivation automatique

- Chaque évènement de jeu écrit une ligne dans une file d'attente **dans la
  même transaction** que l'action qui le déclenche : une récolte ou la clôture
  d'une enchère ne dépend jamais de la disponibilité de votre service.
- La livraison est un travail séparé, exécuté chaque minute, en **une seule
  tentative** par évènement (délai maximum `balance.api.webhookTimeoutMs`,
  5 secondes par défaut) — pas de reprise avec attente exponentielle, pour ne
  pas retarder indéfiniment une notification qui a du sens surtout fraîche.
- Après `balance.api.webhookMaxFailures` échecs **consécutifs** (10 par
  défaut), le webhook est automatiquement désactivé (visible via
  `/webhook list`). Recréez-le une fois votre point de terminaison rétabli.
- Répondez `2xx` rapidement, puis traitez l'évènement de façon asynchrone de
  votre côté : un traitement long côté récepteur ne doit pas faire échouer la
  livraison par dépassement de délai.

## 6. Ce qui n'existe pas (encore)

- Pas d'endpoint de classement (`/api/v1/leaderboard`) : la roadmap ne
  demandait que les statistiques de joueur et de coopérative, et les
  classements existants n'ont pas encore de forme stable à publier.
- Pas d'écriture. Prévue pour le tableau de bord officiel (v3.1), pas pour les
  intégrations tierces.
- Pas de pagination ni de recherche multi-joueurs : chaque clé ne voit que son
  propre titulaire, par conception — cette API n'est pas un export de la base
  des joueurs.
