# 05 — Pipeline d'assets graphiques

## Principe : rendu procédural par défaut, sprites en option

Le dépôt ne contient **aucun sprite**. Ce n'est pas un oubli : livrer des images
dans un dépôt de code pose un problème de licence (traçabilité de l'origine,
compatibilité des licences, redistribution), et le bot doit fonctionner
correctement dès le premier `npm run dev`.

Le renderer (`src/render/`) dessine donc **tout en vectoriel** — parcelles,
plantes à cinq stades, animaux, badges d'état, icônes météo, pièces et gemmes.
Le résultat est propre et cohérent (voir `npm run render:preview`).

Dès qu'un fichier PNG existe au bon chemin, il **remplace automatiquement** le
dessin procédural. Aucune ligne de code à modifier, aucun redémarrage : le cache
de sprites se vide au prochain démarrage, ou via `/admin reload-config`.

## Arborescence et conventions de nommage

```
assets/
├── fonts/                          Polices .ttf/.otf (facultatif)
│   └── Harvest-Regular.ttf         → enregistrée sous la famille « Harvest »
├── sprites/
│   ├── crops/
│   │   ├── wheat_1.png             Stade 1 : graine tout juste plantée
│   │   ├── wheat_2.png             Stade 2 : germination
│   │   ├── wheat_3.png             Stade 3 : croissance
│   │   ├── wheat_4.png             Stade 4 : maturation
│   │   └── wheat_5.png             Stade 5 : prête à récolter
│   ├── animals/
│   │   └── chicken.png             Nom = clé de animals.json
│   ├── buildings/
│   │   └── coop.png                Nom = clé de buildings.json
│   ├── tiles/
│   │   ├── soil.png                Parcelle labourée
│   │   ├── soil_dry.png            Parcelle épuisée (fertilité < 30)
│   │   └── locked.png              Parcelle verrouillée
│   ├── weather/
│   │   └── rainy.png               Nom = valeur de l'énumération weather_type
│   └── ui/
│       └── frame.png               Éléments d'interface
└── banners/
    └── event_autumn.png            Nom = champ `banner` de events.json
```

**Règles :**

| Contrainte | Valeur | Pourquoi |
|---|---|---|
| Format | PNG 32 bits avec alpha | transparence indispensable pour superposer plante et terre |
| Taille des tuiles | 96 × 96 px | `balance.render.farm.tileSize` ; le renderer redimensionne au besoin |
| Taille des animaux | 96 × 96 px | même grille que les cultures |
| Bannières | 1000 × 300 px | affichées en pleine largeur d'embed |
| Poids par fichier | < 60 Ko | une ferme 8×8 charge jusqu'à 64 sprites |
| Nom de fichier | `snake_case`, exactement la clé de configuration | la résolution est automatique, aucune table de correspondance |

Une culture sans sprite au stade demandé retombe silencieusement sur le rendu
procédural : vous pouvez livrer les sprites **culture par culture**, sans
attendre un jeu complet.

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

## Pourquoi les indicateurs critiques sont vectoriels

Les badges de la vue de ferme (prêt ✅, à arroser 💧, nuisibles 🐛), les icônes
météo, les pièces et les gemmes sont **dessinés à la main en canvas**, jamais en
emoji. Un emoji dépend d'une police couleur qui n'est pas garantie sur toutes les
machines : sans elle, l'image affiche des carrés « tofu ». Comme ce sont
précisément les informations dont le joueur a besoin d'un coup d'œil, elles ne
peuvent pas dépendre de l'environnement d'exécution.

Les emoji restent utilisés partout ailleurs — titres d'embed, champs, boutons —
où c'est le **client Discord** qui les rend, avec sa propre police.

## Cache et performance

- Chaque PNG généré est mis en cache dans **Redis**, la clé étant le hash SHA-1
  de **l'état rendu** (grille, stade de chaque culture, échéance arrondie à la
  minute, météo, monnaies). Un rafraîchissement sans changement réutilise
  l'image ; la moindre évolution invalide la clé.
- TTL par défaut : `RENDER_CACHE_TTL=120` secondes.
- Budget de rendu : `RENDER_TIMEOUT_MS=4000`. Au-delà, le renderer abandonne et
  la commande répond en **embed texte** — une interaction Discord doit être
  honorée en trois secondes.
- Toute erreur de rendu est capturée : le joueur reçoit la version texte, jamais
  une erreur.

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

## Prévisualiser sans lancer le bot

```bash
npm run render:preview      # → out/fr/
npm run render:preview:en   # → out/en/
```

Écrit `ferme.png`, `profil.png`, `marche.png` et `classement.png` à partir de
données factices. Ni base de données, ni Redis, ni token Discord requis : c'est la
boucle d'itération pour travailler le visuel.

Les deux langues sont produites dans des dossiers séparés, pour les comparer côte
à côte. **Toute chaîne dessinée dans une image passe par le catalogue i18n** — les
libellés de parcelles, la météo, la saison, les statistiques, les unités de durée
et le formatage des nombres suivent la langue du joueur. La locale fait d'ailleurs
partie de la clé de cache Redis : sans elle, un joueur anglophone recevrait
l'image française mise en cache par un francophone.
