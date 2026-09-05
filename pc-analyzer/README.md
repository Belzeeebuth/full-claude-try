# PC Analyzer — analyse, diagnostic virtuel et comparaison de PC, Windows **et** Linux

Outil web pour coller un lien ou une référence de PC (Amazon, Fnac, Boulanger, Cdiscount…) et obtenir
instantanément une fiche technique détaillée, un diagnostic virtuel (forces, faiblesses, réparabilité,
évolutivité), la **compatibilité Linux composant par composant et distribution par distribution**, et des
estimations de FPS **Windows / Linux natif / Linux via Proton** avec les paliers ProtonDB.

Ce dossier est un sous-projet indépendant du dépôt (il a son propre outillage). Il contient la structure
technique complète du projet : documentation d'architecture, schéma PostgreSQL validé, et le moteur de calcul
testé. Les applications (web, API, worker) sont spécifiées dans les docs et restent à créer.

## Contenu

| Chemin | Contenu | État |
|---|---|---|
| [`docs/01-stack-technique.md`](./docs/01-stack-technique.md) | Stack recommandée (front, API, base, scraping, matching), architecture, modules, API, UX, exploitation, feuille de route | ✅ |
| [`docs/02-base-de-donnees.md`](./docs/02-base-de-donnees.md) | Modèle de données : référentiel composants + **critères Linux**, produits, jeux/ProtonDB/bancs, exploitation, sources de données | ✅ |
| [`docs/03-algorithmes.md`](./docs/03-algorithmes.md) | Algorithmes : compatibilité Linux, recommandation de distributions, estimation FPS (Windows vs Proton), charges pro, scores de diagnostic | ✅ |
| [`packages/db/migrations/0001_init.sql`](./packages/db/migrations/0001_init.sql) | Schéma PostgreSQL 16 (21 tables, énumérations, index trigramme, vue moteur) | ✅ validé dans PGlite |
| [`packages/db/seed/0001_reference_seed.sql`](./packages/db/seed/0001_reference_seed.sql) | Jeu de données de référence illustratif (distributions, composants, support Linux, alias, jeux, ProtonDB, bancs) | ✅ |
| [`packages/engine/src`](./packages/engine/src) | Moteur TypeScript pur : `linux/compatibility.ts`, `linux/distro-recommender.ts`, `performance/fps-estimator.ts`, `performance/pro-workloads.ts`, types, fixtures | ✅ 44 tests |
| [`apps/demo`](./apps/demo) | Démo statique publiée sur GitHub Pages : le moteur exécuté dans le navigateur sur les six configurations de démonstration (fiche, diagnostic, Linux, FPS, pro, comparateur) | ✅ |

## Démo en ligne

La démo statique est publiée par le workflow GitHub Pages du dépôt sous
**https://belzeeebuth.github.io/full-claude-try/pc-analyzer/** (les pages Harvester restent à la racine).
Elle ne scrape rien : coller un lien marchand montre la détection du marchand et de la référence, puis
invite à choisir une configuration de démonstration ; tout le reste (compatibilité Linux par distribution,
recommandations, FPS Windows / natif / Proton, charges pro, comparateur) est calculé dans le navigateur par le
moteur.

## Démarrage

```bash
cd pc-analyzer
npm ci                           # (si le lockfile est régénéré : npm install --legacy-peer-deps, bug npm sur les peer deps de vitest)
npm test                         # tests du moteur
npm run typecheck
npm run db:check                 # rejoue migration + seed dans PGlite (Postgres en WebAssembly)
npm run build:demo               # construit la démo statique dans apps/demo/dist
```

## Aperçu du moteur

```ts
import { evaluateLinuxCompatibility, recommendDistros, estimateFps } from '@pc-analyzer/engine';
import { LEGION_5, DISTROS, BENCHMARKS, game } from '@pc-analyzer/engine/fixtures';

const report = evaluateLinuxCompatibility(LEGION_5, { distro: DISTROS[0] });
// report.overall → { badge: 'orange', score: 88, summary: 'Compatible avec ajustements sur Ubuntu 24.04 LTS : Installer le pilote propriétaire nvidia ; Enrôler la clé MOK …' }

const fps = estimateFps(LEGION_5, game('cyberpunk-2077'), { resolution: '1080p', preset: 'ultra', benchmarks: BENCHMARKS });
// fps.windows.avg → 64.8   fps.linuxProton.avg → 51.8   fps.linux.protonTier → 'gold'

recommendDistros(LEGION_5, DISTROS, { usage: 'gaming', experience: 'beginner' });
// → Bazzite, Pop!_OS, Linux Mint, Ubuntu, Fedora…
```

Le moteur ne fait aucune I/O : il tourne à l'identique dans l'API (résultats mis en cache) et dans le
navigateur (changer de résolution, de preset ou d'OS sans appel serveur).

## Arborescence cible

```
pc-analyzer/
├── apps/demo     ✅ démo statique (GitHub Pages) ├── packages/engine   ✅ moteur + tests
├── apps/web      Next.js 15 (à créer)            ├── packages/db       ✅ SQL + seed + vérification
├── apps/api      NestJS / Fastify (à créer)
├── apps/worker   Crawlee / Playwright (à créer)
└── docs/         ✅ 01 stack · 02 base de données · 03 algorithmes
```

Les valeurs des fixtures et du seed (indices de performance, versions de noyau, paliers ProtonDB) sont
indicatives : en production elles sont importées et rafraîchies par les jobs décrits dans le doc 02 § 6.
