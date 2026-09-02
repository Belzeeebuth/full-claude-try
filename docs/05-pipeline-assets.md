# 05 — Pipeline d'assets graphiques

## Principe : rendu procédural par défaut, sprites en option

Le dépôt ne contient **aucun sprite**. Ce n'est pas un oubli : livrer des images
dans un dépôt de code pose un problème de licence (traçabilité de l'origine,
compatibilité des licences, redistribution), et le bot doit fonctionner
correctement dès le premier `npm run dev`.

Le renderer (`src/render/`) dessine donc **tout en vectoriel** — parcelles,
plantes à cinq stades, animaux, badges d'état, icônes météo, pièces et gemmes,
décor de saison, bâtiments, timbre de carte postale. Le résultat est propre et
cohérent (voir `npm run render:preview`).

Dès qu'un fichier PNG existe au bon chemin, il **remplace automatiquement** le
dessin procédural. Aucune ligne de code à modifier, aucun redémarrage : le cache
de sprites (`src/render/sprites.ts`, une entrée par fichier, absence mémorisée)
se vide au prochain démarrage.

### L'apparence d'une culture est une donnée, pas du code

Le dessin procédural n'est pas générique : chaque culture déclare dans
`crops.json` la **silhouette** à tracer et sa **palette**.

```json
"form": "vine",
"palette": { "leaf": "#5c9648", "leafDark": "#3d6630",
             "fruit": "#7b4bab", "fruitDark": "#54317a" }
```

Neuf silhouettes (`cropForms` dans `src/config/gameplay/schemas.ts`) couvrent
les 41 cultures. Ajouter une culture, c'est choisir une forme et quatre
couleurs — pas écrire du canvas.

| Silhouette | Cultures |
|---|---|
| `stalk` | 🌾 Blé, 🎍 Bambou |
| `root` | 🥕 Carotte, 🧅 Oignon, 🥔 Pomme de terre, 🧄 Ail, 🍠 Patate douce, 🫚 Ginseng, 🍄 Truffe |
| `leafy` | 🥬 Laitue, 🥦 Brocoli |
| `tall` | 🌽 Maïs, 🌻 Tournesol |
| `bush` | 🍅 Tomate, 🍓 Fraise, 🍆 Aubergine, 🫑 Poivron, 🌶️ Piment, 🫐 Myrtille, 🐉 Fruit du dragon |
| `vine` | 🥒 Concombre, 🫛 Petits pois, 🌿 Houblon, 🍇 Raisin, 🥝 Kiwi |
| `ground` | 🍈 Melon, 🍉 Pastèque, 🎃 Citrouille |
| `tree` | 🍵 Thé, ☕ Café, 🍫 Cacao, 🫒 Olive, 🍊 Mandarine, 🌸 Sakura, 🌳 Arbre-monde |
| `flower` | 🌹 Rose, 🪻 Lavande, 🌼 Vanille, 🌺 Safran, ❄️ Rose des glaces, ✨ Lotus étoilé |

Ces deux champs sont validés par le schéma Zod et couverts par
`tests/render-crops.test.ts`, qui refuse une culture sans palette : sans ce test,
une culture ajoutée plus tard retomberait silencieusement sur une apparence
neutre, et se confondrait avec les autres. C'était exactement le défaut de la
version précédente, où la couleur venait d'un hash du nom — tige toujours verte,
teinte de fruit sans rapport avec la plante.

### Même principe pour les animaux : silhouette et palette

`animals.json` porte, pour chacune des 24 espèces, une `form` parmi neuf
(`animalForms`) et une palette `{ body, bodyDark, accent, accentDark }`
(teintes réalistes : le plumage crème et la crête rouge de la poule, le bleu et
le vert du paon). `drawAnimalForm` (`src/render/sprites.ts`) les lit et dessine
l'espèce — avec un œil, un sens (`facing`), une graine de variation et les
indicateurs malade/endormi ; `drawAnimal()` ne sert plus que de repli à une
espèce qui n'aurait pas de `form`, ce qu'aucune n'est aujourd'hui.

| Silhouette | Décrit | Espèces |
|---|---|---|
| `fowl` | volaille ronde | poule, canard, dinde |
| `longneck` | grand oiseau à long cou | oie, autruche, cygne, paon |
| `smallfurry` | petit mammifère à oreilles | lapin, cochon d'Inde |
| `woolly` | corps en nuage | mouton, alpaga, yack |
| `hoofed` | corps en boîte sur quatre pattes, cornes optionnelles | chèvre, âne, vache, cerf, cheval, licorne |
| `swine` | tonneau à groin | cochon |
| `insect` | petit corps ailé | abeille, ver à soie |
| `shelled` | dôme | tortue |
| `winged` | corps + ailes + queue | dragonnet, phénix |

| Espèce | Silhouette | Espèce | Silhouette | Espèce | Silhouette |
|---|---|---|---|---|---|
| 🐔 Poule | `fowl` | 🪿 Oie | `longneck` | 🦆 Canard | `fowl` |
| 🐰 Lapin | `smallfurry` | 🐹 Cochon d'Inde | `smallfurry` | 🐑 Mouton | `woolly` |
| 🦃 Dinde | `fowl` | 🐐 Chèvre | `hoofed` | 🫏 Âne | `hoofed` |
| 🐝 Abeille | `insect` | 🐄 Vache | `hoofed` | 🐖 Cochon | `swine` |
| 🐛 Ver à soie | `insect` | 🐢 Tortue | `shelled` | 🦙 Alpaga | `woolly` |
| 🦬 Yack | `woolly` | 🪶 Autruche | `longneck` | 🦌 Cerf | `hoofed` |
| 🐴 Cheval | `hoofed` | 🦢 Cygne | `longneck` | 🦚 Paon | `longneck` |
| 🐲 Dragonnet | `winged` | 🦄 Licorne | `hoofed` | 🔥 Phénix | `winged` |

`tests/content-animals.test.ts` exige une silhouette connue et une palette
complète par espèce, un accent distinct du corps, et que **toutes** les formes
du schéma soient réellement employées (la tortue existe pour couvrir `shelled`).

**Variantes.** Une bête dorée est dessinée avec la palette de l'espèce tirée
vers l'or, un reflet et une étoile en couronne ; une shiny reçoit cinq
étincelles semées sur sa graine (déterministes, donc stables d'une image à
l'autre). Un sprite PNG ne se reteinte pas : la marque est dessinée par-dessus.
La variante est immuable, l'identifiant de la bête (déjà dans la clé de cache)
suffit à distinguer les images.

## Arborescence et conventions de nommage

Ce que les renderers **chargent réellement** (`sprite('<catégorie>', '<nom>')`
dans `src/render/`) :

```
assets/
├── fonts/                          Polices .ttf/.otf, enregistrées au démarrage par canvas.ts
│   └── Harvest-Regular.ttf         → famille « Harvest » ; sans dossier, polices système
├── sprites/
│   ├── crops/
│   │   ├── wheat_1.png             Stade 1 : graine tout juste plantée      (image /farm)
│   │   ├── wheat_2.png             Stade 2 : germination
│   │   ├── wheat_3.png             Stade 3 : croissance
│   │   ├── wheat_4.png             Stade 4 : maturation
│   │   └── wheat_5.png             Stade 5 : prête à récolter
│   ├── animals/
│   │   └── chicken.png             Nom = clé de animals.json  (images /animals et pied de page de /farm)
│   ├── pets/
│   │   └── fox.png                 Nom = clé de game/pets.ts  (badge du compagnon sur /farm)
│   └── tiles/
│       └── soil.png                Parcelle labourée           (image /farm)
```

Les dossiers `sprites/buildings/`, `sprites/weather/`, `sprites/ui/` et
`banners/` existent (fichiers `.gitkeep`) et `tiles/soil_dry.png` /
`tiles/locked.png` sont cités dans l'en-tête de `sprites.ts`, mais **aucun rendu
ne les résout aujourd'hui** : bâtiments, météo, sol épuisé et parcelles
verrouillées sont dessinés en vectoriel quoi qu'il arrive, et y déposer un PNG
n'a pas d'effet. La carte postale (`/postcard`) est entièrement procédurale
elle aussi — elle passe par `drawCrop` et `drawAnimalForm`, pas par l'atlas.

**Règles :**

| Contrainte | Valeur | Pourquoi |
|---|---|---|
| Format | PNG 32 bits avec alpha | transparence indispensable pour superposer plante et terre |
| Taille des tuiles | 96 × 96 px | `balance.render.farm.tileSize` ; le renderer redimensionne au besoin |
| Taille des animaux | 96 × 96 px | même grille que les cultures |
| Poids par fichier | < 60 Ko | une ferme 8×8 charge jusqu'à 64 sprites |
| Nom de fichier | `snake_case`, exactement la clé de configuration | la résolution est automatique, aucune table de correspondance |

Une culture sans sprite au stade demandé retombe silencieusement sur le rendu
procédural : vous pouvez livrer les sprites **culture par culture**, sans
attendre un jeu complet.

## Formats des images

Tout vient de `balance.render` (rechargeable à chaud) :

| Rendu | Commande | Taille | Fichier joint |
|---|---|---|---|
| Ferme | `/farm`, `/visit` | grille × 96 px + en-tête 132 px, largeur ≤ 1 100 px | `farm.png` |
| Profil | `/profile` | 900 × 520 | `profil.png` |
| Marché | `/market-history` | 900 × 460 | `marche.png` |
| Classement | `/leaderboard` | 900 × 700 | `classement.png` |
| Étang | `/fish` | 900 × 500 | `peche.png` |
| Mine | `/mine` | 900 × 620 | `mine.png` |
| Basse-cour | `/animals` | 900 × 640, hauteur fixe : les enclos se partagent l'espace (1 colonne, 2 jusqu'à 4 bâtiments, 3 au-delà) | `animaux.png` |
| Carte postale | `/postcard` | 1 000 × 700, la scène s'adapte de 3×3 à 8×8 | `carte-postale.png` |

`balance.render.quality` (0,85) figure dans le schéma mais n'est lu par aucun
rendu aujourd'hui : les PNG sortent sans paramètre de compression.

## Ce que dessine chaque rendu

Le vocabulaire visuel a été enrichi (chantier R2) sans changer les interfaces
d'entrée des rendus — `tests/render-polish.test.ts` vérifie que chaque élément
ci-dessous change réellement l'image, à dimensions égales :

- **Ferme** — les trois mutations sont distinguables : `giant` dessinée ×1,25
  sur la même ligne de base (débord vers le haut, jamais sur la voisine),
  `rainbow` avec un liseré irisé, `ancient` en sépia doré avec halo. Le sol sous
  `balance.fertility.lowThreshold` (30) est pâle et craquelé. Décor de saison
  semé sur `farmId:decor` (graine distincte de celle des bâtiments) : fleurs au
  printemps, feuilles mortes en automne, neige et flocons en hiver, herbe jaunie
  et brins secs en canicule. Badge rond du compagnon équipé au coin de
  l'avatar, silhouettes des animaux en pied de page.
- **Profil** — la bannière encode le prestige (uni ; poussière d'étoiles au
  rang 1 ; constellation reliée à partir du rang 2, plus dense par rang), semée
  sur le pseudo. L'anneau de l'avatar est coloré par tranche de niveau
  (`levelRingColor` : 1–9 vert, 10–24 bleu, 25–49 violet, 50–74 or, 75–99
  orange, 100+ rouge avec second anneau).
- **Marché** — repères min/max de la série pointés et étiquetés (omis s'ils
  coïncident avec le dernier point), dernier prix en étiquette, ligne de
  référence avec pilule « référence », aire sous la courbe en dégradé.
- **Classement** — médailles vectorielles sur le podium ; ligne « votre rang »
  et ligne du spectateur bordées en vert.
- **Étang** — plans superposés (collines lointaines, rive, reflets, chemin de
  lumière par temps clair, roseaux au premier plan), pluie, neige et voile
  intégrés, tout semé sur saison + météo.
- **Mine** — strates alternées de part et d'autre du puits, étais, filons en
  grappes colorées par la rareté du palier (`depthRarity` : < 15 % de la
  profondeur commun, < 35 % peu commun, < 55 % rare, < 75 % épique, < 90 %
  légendaire, puis mythique), dessinés sous le voile des paliers verrouillés.
- **Basse-cour** — ciel, herbe et voile météo partagés avec la ferme
  (`src/render/scenery.ts`), un enclos par bâtiment d'élevage (sol propre,
  clôture, icône, occupation « 3/8 »), bêtes en grille semée sur `farmId`,
  pastilles **uniquement si actionnables** (collecter, nourrir, soigner ;
  caresser seulement si bonheur < 70, sinon toute la basse-cour en aurait une),
  bête repue et heureuse qui dort, au plus 24 bêtes visibles puis « +N »,
  bandeau récapitulatif (vivants, affamés, malades, prêts).
- **Carte postale** — tirage presque carré (10×9) pour que la grille occupe
  la photo, arbres et fleurs saisonniers dans les marges d'une petite ferme,
  timbre dont le sujet est la culture la plus plantée (sinon l'espèce la plus
  nombreuse, sinon une culture de saison), cachet daté dans le fuseau du
  fermier, légende manuscrite ≤ 60 caractères nettoyée (mentions,
  `@everyone`, liens, markdown, caractères invisibles et bidi, retours à la
  ligne) — une légende faite uniquement d'emoji sans police couleur retombe
  sur la salutation. Les pièces sont masquées si `settings.privacy = private`.

`src/render/canvas.ts` expose les briques partagées : toile hors écran,
teinte, liseré, dégradé arc-en-ciel, pilule, étoile.

## Pourquoi les indicateurs critiques sont vectoriels

Les badges de la vue de ferme (prêt ✅, à arroser 💧, nuisibles 🐛), les icônes
météo, les pièces et les gemmes sont **dessinés à la main en canvas**, jamais en
emoji. Un emoji dépend d'une police couleur qui n'est pas garantie sur toutes les
machines : sans elle, l'image affiche des carrés « tofu ». Comme ce sont
précisément les informations dont le joueur a besoin d'un coup d'œil, elles ne
peuvent pas dépendre de l'environnement d'exécution.

Là où un emoji **est** dessiné (badges de profil, titre du graphique), `font()`
déclare une **pile** de familles — le texte, puis la police emoji : Canvas
n'applique le repli qu'aux familles listées dans `ctx.font`, jamais à celles
simplement enregistrées dans le process. C'est la correction de l'audit qui a
fait passer un glyphe de 0 à 347 pixels colorés ; deux tests figent la pile.

Les emoji restent utilisés partout ailleurs — titres d'embed, champs, boutons —
où c'est le **client Discord** qui les rend, avec sa propre police.

## Accessibilité : texte alternatif et contraste

Toute l'interface est une image ; une pièce jointe sans `description` n'est
annoncée qu'en « farm.png » par un lecteur d'écran, et la seule issue était le
mode compact — qui retire les images à tout le monde. Depuis le chantier C-01 :

- **Chaque rendu a sa fonction pure `describeX()`** à côté de `renderX()`
  (ferme, profil, graphique, classement, étang, mine, basse-cour, carte
  postale), qui produit une description factuelle dans la langue du spectateur
  : nom, météo, compteurs, prochaine récolte et parcelles à
  récolter/arroser/traiter, cultures mutées et parcelles épuisées pour la
  ferme ; niveau, XP, monnaies et statistiques pour le profil ; objet, prix,
  tendance, bornes et période pour le graphique ; les dix classés et le rang du
  spectateur ; saison et météo pour l'étang ; profondeur, record et paliers
  verrouillés pour la mine ; bâtiments, bêtes et variantes rares pour la
  basse-cour.
- `render()` la passe à `AttachmentBuilder` sur les **deux** chemins, cache
  compris. Elle n'entre pas dans la clé de cache ni dans le contrat des
  workers : quelques concaténations ne valent pas un second format de cache.
  Aucune horloge dans `describeFarm` : la prochaine récolte se lit dans
  `msRemaining`, figé par le service, donc la description est reproductible.
- `src/render/alt-text.ts` : `clampAltText` tronque à **1 024 caractères**
  (limite Discord — une description de 1 025 caractères est rejetée **en bloc**,
  image comprise) sur une frontière de mot, en respectant l'espace fine
  insécable des nombres français ; `listSome` borne les énumérations
  (« et N autres »). Clés dans `src/i18n/locales/{fr,en}/render_alt.json`
  (`render_alt.*`, une clé par phrase). `tests/render-alt-text.test.ts`
  vérifie contenu, borne et absence de clé fuitée dans les deux langues.
- **Contraste** : `tests/render-contrast.test.ts` calcule luminance relative
  et ratio WCAG 2.x pour chaque couple réellement dessiné de `PALETTE` (texte et
  texte atténué sur carte, panneaux translucides composés sur blanc — pire
  cas —, haut du classement, ligne du spectateur, barres, or, couleurs de
  tendance). Seuils : **4,5:1** pour le texte courant et l'or, **3:1** pour les
  grands chiffres (prix du graphique, 18 px gras). Ajouter une couleur de texte
  impose d'ajouter son couple au tableau `PAIRS`.

## Cache et performance

- Chaque PNG généré est mis en cache dans **Redis** sous
  `harvester:render:<type>:<sha1>`, le hash portant sur **l'état rendu**
  (grille, stade de chaque culture, échéance arrondie à la minute, météo,
  monnaies, locale — pour la basse-cour : bâtiments, bêtes et pastilles
  décidées, pas les jauges brutes). Un rafraîchissement sans changement
  réutilise l'image ; la moindre évolution invalide la clé. Une image de plus
  de 2 Mo n'est pas mise en cache.
- TTL par défaut : `RENDER_CACHE_TTL=120` secondes.
- Le dessin est fait par `RENDER_WORKERS` threads (2 par défaut,
  `src/render/pool.ts`), démarrés au boot : le thread principal — donc la
  passerelle Discord — n'est jamais bloqué par une image. La file est bornée à
  `max(4, workers × 6)` ; au-delà, le rendu est refusé et la commande répond en
  texte plutôt que d'accumuler des images que plus personne n'attend.
- Budget : `RENDER_TIMEOUT_MS=4000`. Au-delà, la commande répond en **embed
  texte** — une interaction Discord doit être honorée en trois secondes — mais le
  worker termine son image, qui alimente le cache pour l'affichage suivant.
  Seul un rendu bloqué au-delà du seuil dur (4 × le budget, 20 s minimum) est
  interrompu, worker compris.
- Toute erreur de rendu est capturée : le joueur reçoit la version texte, jamais
  une erreur. `/settings compact-mode:true` court-circuite le rendu de toutes
  les images.
- Jauges `harvester_render_workers`, `harvester_render_busy`,
  `harvester_render_queued` sur `/metrics` ; symptômes et remèdes en
  [08 § 5](./08-exploitation.md#5-file-de-rendu-saturée).

## Identité visuelle du bot

```bash
npm run brand
```

Écrit dans `assets/brand/` :

| Fichier | Taille | Usage |
|---|---|---|
| `harvester-avatar.png` | 512 × 512 | Avatar de l'application Discord |
| `harvester-avatar-256.png` | 256 × 256 | Icône de serveur, favicon |
| `harvester-banner.png` | 680 × 240 | Bannière de profil de l'application (**anglais**) |
| `harvester-banner-fr.png` | 680 × 240 | Même bannière, accroche française |

Ces images sont dessinées en vectoriel par `src/render/brand.ts`, sans aucun asset
externe : elles n'engagent donc **aucune licence tierce** et sont régénérables à
n'importe quelle taille. Ce sont les seules images du dépôt à être commitées, parce
qu'elles nous appartiennent.

Deux contraintes ont guidé la composition :

- **Discord rogne l'avatar en cercle.** Rien d'important ne sort du disque inscrit,
  et les angles du carré sont traités comme perdus.
- **L'avatar doit tenir à 32 px** (liste des membres). D'où un épi de blé en fuseau,
  dense et centré, plutôt qu'une scène détaillée : c'est la silhouette qui porte la
  reconnaissance à cette taille, pas le détail.

La bannière par défaut est en **anglais** : Discord n'en accepte qu'une seule par
application, et elle est vue de tous les joueurs quelle que soit leur langue —
contrairement aux images de jeu, qui suivent le réglage de chacun. La variante
française est produite en même temps, pour un site ou un serveur francophone.

Le nom et l'accroche se changent sans toucher au code :

```bash
BRAND_NAME="MA FERME" BRAND_TAGLINE="Ma propre accroche" npm run brand
```

## Sources d'assets libres recommandées

Toutes les licences ci-dessous autorisent l'usage commercial. **Vérifiez toujours
la licence du pack précis** au moment du téléchargement.

| Source | Licence | Contenu | Lien |
|---|---|---|---|
| Kenney.nl | CC0 (domaine public) | tuiles, cultures, interface, icônes | <https://kenney.nl/assets> |
| OpenGameArt — filtre CC0 | CC0 / CC-BY | sprites de ferme, animaux | <https://opengameart.org> |
| Itch.io — « farming asset pack » | variable, souvent CC0 ou payante | packs complets cohérents | <https://itch.io/game-assets/tag-farming> |
| Game-icons.net | CC-BY 3.0 | icônes vectorielles (outils, ressources) | <https://game-icons.net> |
| Twemoji | CC-BY 4.0 | emoji en PNG/SVG, utile pour l'interface | <https://github.com/twitter/twemoji> |

**Polices** (à déposer dans `assets/fonts/`) :

| Police | Licence | Usage |
|---|---|---|
| Inter | SIL OFL 1.1 | texte d'interface, très lisible en petit corps |
| Nunito | SIL OFL 1.1 | plus ronde, cohérente avec un univers de ferme |
| DejaVu Sans | licence libre Bitstream | repli par défaut, présente dans l'image Docker |
| Noto Color Emoji | SIL OFL 1.1 | **installée dans le Dockerfile** ; sans elle, les emoji dessinés dans une image apparaissent en carrés |

> ⚠️ **Attribution CC-BY.** Si vous utilisez des assets sous CC-BY, l'attribution
> est obligatoire. Ajoutez un fichier `assets/CREDITS.md` et une mention dans
> `/help` — c'est une obligation légale, pas une politesse.

## Prévisualiser sans lancer le bot

```bash
npm run render:preview      # → out/fr/  (6 PNG)
npm run render:preview:en   # → out/en/
npm run render:matrix       # → out/matrix/  (26 PNG)
```

`render:preview` écrit `ferme.png`, `profil.png`, `marche.png`, `classement.png`,
`animaux.png` (15 bêtes de toutes formes, 5 enclos, chaque pastille représentée)
et `carte-postale.png` (la même ferme que `ferme.png`, sans son tableau de bord)
à partir de données factices. `render:matrix` couvre **tous** les rendus dans
leurs cas limites : grilles 3×3 et 8×8, deux cas **entre** deux paliers (10 et
26 parcelles — c'est là que le décalage corrigé en F-02 se voyait), orage,
printemps, automne, hiver clair et neigeux, canicule, mutations, sol épuisé,
profils aux prestiges 0/1/2/4, marché en hausse, en baisse et sans historique,
classement, étang aux quatre saisons, mine en début et en profondeur. Ni base
de données, ni Redis, ni token Discord requis (`src/scripts/offline-env.ts`
pose des valeurs de remplacement) : c'est la boucle d'itération pour
travailler le visuel.

Les deux langues sont produites dans des dossiers séparés, pour les comparer côte
à côte. **Toute chaîne dessinée dans une image passe par le catalogue i18n** — les
libellés de parcelles, la météo, la saison, les statistiques, les unités de durée
et le formatage des nombres suivent la langue du joueur. Depuis le chantier de
socle, chaque fonctionnalité apporte ses clés dans son propre fragment
`src/i18n/locales/{fr,en}/<fonctionnalité>.json`, fusionné avec `fr.json` /
`en.json` au chargement : `render_alt.json` (textes alternatifs),
`render_animals.json` (libellés de la basse-cour), `render_polish.json`
(mutations, repères du graphique), `postcard.json`, `collection.json`,
`history.json`, `almanac.json`, `alerts.json`, `reminders.json`, `account.json`.
Un test compare les catalogues fusionnés fr/en clé à clé. La locale fait
partie de la clé de cache Redis : sans elle, un joueur anglophone recevrait
l'image française mise en cache par un francophone.
