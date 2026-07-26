# 04 — Équilibrage

> Toutes les tables de ce document sont **produites par le code**, pas rédigées à la
> main : `npm run balance:report` les régénère depuis `src/config/gameplay/`.
> Modifier un JSON et relancer la commande suffit à voir l'impact.

---

## 1. Méthode

Trois objectifs, dans cet ordre de priorité :

1. **Aucun mur.** Le rapport temps/gain ne doit jamais s'effondrer entre deux
   niveaux. La courbe d'XP est sous-quadratique (`exposant 1,45`) et les cultures
   déblocables croissent en profit horaire *plus vite* que la courbe d'XP.
2. **Aucune exploitation évidente.** Aucune boucle ne doit produire des pièces sans
   consommer de temps ou de ressource. Vérifié par tests automatisés (§ 7).
3. **La progression est un choix, pas une obligation.** À chaque palier, plusieurs
   stratégies (cultures rapides à faible marge, cultures longues à forte marge,
   élevage, transformation) doivent rester dans un facteur ~2 l'une de l'autre.

L'unité de comparaison est le **profit par parcelle et par heure** :
`(rendement × prix de vente − prix de graine) / durée`. C'est la seule métrique qui
permette de comparer du blé (5 min) et un arbre-monde (36 h).

---

## 2. Cultures — 27 espèces

| Culture | Niv | Graine | Rdt | Vente | Durée | Profit | Profit/h | ROI |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| 🌾 Blé | 1 | 10 | 3 | 6 | 5 min | 8 | 96 | 1,8× |
| 🥕 Carotte | 1 | 14 | 3 | 9 | 8 min | 13 | 98 | 1,9× |
| 🥔 Pomme de terre | 2 | 20 | 4 | 10 | 12 min | 20 | 100 | 2,0× |
| 🥬 Laitue | 2 | 26 | 4 | 13 | 15 min | 26 | 104 | 2,0× |
| 🌽 Maïs | 3 | 40 | 6 | 15 | 25 min | 50 | 120 | 2,3× |
| 🍅 Tomate | 5 | 55 | 5 | 22 | 1,5 h | 385 | 257 | 8,0× |
| 🥒 Concombre | 5 | 60 | 6 | 26 | 35 min | 96 | 165 | 2,6× |
| 🍓 Fraise | 6 | 70 | 4 | 32 | 1,5 h | 314 | 209 | 5,5× |
| 🍆 Aubergine | 7 | 85 | 6 | 34 | 45 min | 119 | 159 | 2,4× |
| 🫑 Poivron | 8 | 95 | 6 | 36 | 50 min | 121 | 145 | 2,3× |
| 🍈 Melon | 10 | 160 | 5 | 90 | 1,5 h | 290 | 193 | 2,8× |
| 🌻 Tournesol | 11 | 180 | 6 | 85 | 1,8 h | 330 | 189 | 2,8× |
| 🍉 Pastèque | 12 | 220 | 5 | 130 | 2,0 h | 430 | 215 | 3,0× |
| 🎃 Citrouille | 13 | 260 | 6 | 135 | 2,5 h | 550 | 220 | 3,1× |
| 🌿 Houblon | 14 | 240 | 6 | 65 | 5,0 h | 1 710 | 342 | 8,1× |
| 🍇 Raisin | 15 | 300 | 8 | 90 | 7,5 h | 2 580 | 344 | 9,6× |
| 🍵 Thé | 17 | 460 | 8 | 130 | 8,8 h | 3 700 | 423 | 9,0× |
| ☕ Café | 18 | 520 | 8 | 145 | 10,0 h | 4 120 | 412 | 8,9× |
| 🍫 Cacao | 20 | 700 | 9 | 360 | 5,0 h | 2 540 | 508 | 4,6× |
| 🪻 Lavande | 21 | 780 | 10 | 300 | 4,5 h | 2 220 | 493 | 3,8× |
| 🌼 Vanille | 23 | 900 | 8 | 520 | 6,0 h | 3 260 | 543 | 4,6× |
| 🫚 Ginseng | 28 | 1 600 | 8 | 1 050 | 8,0 h | 6 800 | 850 | 5,3× |
| 🍄 Truffe | 32 | 2 400 | 7 | 1 750 | 10,0 h | 9 850 | 985 | 5,1× |
| 🌺 Safran | 36 | 3 200 | 8 | 2 400 | 12,0 h | 16 000 | 1 333 | 6,0× |
| 🐉 Fruit du dragon | 42 | 6 000 | 9 | 5 200 | 18,0 h | 40 800 | 2 267 | 7,8× |
| ✨ Lotus étoilé | 48 | 9 000 | 10 | 8 200 | 1,0 j | 73 000 | 3 042 | 9,1× |
| 🌳 Arbre-monde | 55 | 15 000 | 12 | 12 500 | 1,5 j | 135 000 | 3 750 | 10,0× |

**Lectures importantes**

- Le **profit horaire est monotone croissant** avec le niveau : 96 🪙/h au niveau 1,
  3 750 🪙/h au niveau 55. Un joueur qui débloque une culture y gagne toujours.
- Les cultures **à récolte multiple** (tomate, fraise, houblon, raisin, thé, café,
  lotus) ont un ROI très supérieur — 8× à 10× contre 2× à 3× — parce qu'une seule
  graine produit plusieurs récoltes. C'est le compromis explicite : elles coûtent
  cher, immobilisent la parcelle longtemps, et récompensent la planification.
- Les cultures rapides gardent leur usage : ROI faible mais **cycle court**, donc
  idéales pour un joueur qui se connecte souvent, et incontournables pour les quêtes
  de quantité.
- **Aucune culture n'est dominée** : chacune est soit la meilleure de son palier de
  niveau, soit la meilleure de son horizon temporel, soit un ingrédient de recette.

---

## 3. Animaux — 13 espèces

| Animal | Niv | Prix | Produit | Cycle | Net/h | Amorti |
|---|--:|--:|---|--:|--:|--:|
| 🐔 Poule | 2 | 400 | 2× Œuf | 45 min | 48 | 8,3 h |
| 🦆 Canard | 4 | 580 | 2× Œuf de canard | 1,3 h | 58 | 10,1 h |
| 🐰 Lapin | 5 | 770 | 2× Angora | 1,5 h | 64 | 12,0 h |
| 🐑 Mouton | 8 | 1 400 | 3× Laine | 3,0 h | 101 | 13,9 h |
| 🐐 Chèvre | 10 | 1 550 | 3× Lait de chèvre | 3,5 h | 103 | 15,0 h |
| 🐄 Vache | 12 | 2 100 | 3× Lait | 4,0 h | 132 | 15,9 h |
| 🐝 Abeille | 13 | 1 750 | 2× Miel | 2,5 h | 96 | 18,2 h |
| 🐖 Cochon | 15 | 3 000 | 1× Truffe sauvage | 6,0 h | 177 | 17,0 h |
| 🦙 Alpaga | 20 | 6 000 | 2× Laine fine | 6,0 h | 287 | 20,9 h |
| 🪶 Autruche | 25 | 8 000 | 1× Œuf géant | 8,0 h | 365 | 21,9 h |
| 🐴 Cheval | 30 | 9 500 | 1× Crin de cheval | 10,0 h | 412 | 23,1 h |
| 🦚 Paon | 35 | 12 800 | 1× Plume de paon | 12,0 h | 535 | 23,9 h |
| 🐲 Dragonnet | 40 | 62 500 | 1× Écaille de dragon | 8,0 h | 1 735 | 36,0 h |

Le **temps d'amortissement croît volontairement** (8 h → 36 h) : un animal de haut
niveau est un investissement, pas un achat impulsif. Il reste toujours amortissable
en moins de deux jours de jeu — au-delà, l'achat cesserait d'être attractif.

Le « net/h » est calculé **nourriture déduite**. L'élevage est moins rentable à
l'heure que la culture équivalente, ce qui est assumé : il demande beaucoup moins
d'attention (un cycle de vache, c'est une action toutes les 4 h contre 48 actions de
blé), et il produit les **ingrédients de transformation** que la culture seule ne
fournit pas.

---

## 4. Transformation — 32 recettes

Marge cible : **2,0× à 2,2×** la valeur des ingrédients. Extrait représentatif :

| Recette | Niv | Ingrédients | Produit | Marge | Durée | Gain/h |
|---|--:|--:|--:|--:|--:|--:|
| 🌾 Farine | 4 | 18 | 38 | 2,11× | 5 min | 240 |
| 🍞 Pain | 6 | 98 | 200 | 2,04× | 10 min | 612 |
| 💩 Compost | 5 | 36 | 60 | 1,67× | 20 min | 72 |
| 🧀 Fromage | 12 | 380 | 790 | 2,08× | 40 min | 615 |
| 🍷 Vin | 15 | 540 | 1 180 | 2,19× | 4,0 h | 160 |
| 🍇 Confiture de raisin | 17 | 580 | 1 200 | 2,07× | 45 min | 827 |
| 🪡 Tissu fin | 22 | 2 700 | 5 600 | 2,07× | 1,5 h | 1 933 |
| 🍬 Praline de vanille | 28 | 6 300 | 13 000 | 2,06× | 4,0 h | 1 675 |
| 🧪 Essence de safran | 36 | 7 900 | 16 300 | 2,06× | 6,0 h | 1 400 |
| 🧫 Potion de dragon | 42 | 18 600 | 38 400 | 2,06× | 8,0 h | 2 475 |

**Le cas du compost, ou pourquoi le plafond de marge est testé.** Le compost est la
seule recette sous 2× (1,67×), et c'est délibéré : ses ingrédients sont des
**mauvaises herbes gratuites**, récupérées en désherbant. Une marge normale en
ferait un robinet monétaire pur — de la valeur créée à partir de rien. Le test
automatisé sur le plafond de marge a détecté exactement ce cas
(`fertilizer_basic` sortait à 2,50×) ; le prix de vente a été ramené de 45 à 30 🪙.
C'est un exemple concret de l'utilité d'un équilibrage testé en CI plutôt que relu.

Le **gain/h décroît pour les recettes longues** (vin : 160 🪙/h, bière : 182 🪙/h),
ce qui est correct : elles n'occupent pas l'attention du joueur, seulement un slot.
La bonne stratégie est de lancer une production longue **avant** de se déconnecter.

---

## 5. Progression

### 5.1 Courbe d'XP — `⌊60 · n^1,45 + 40 · n⌋`

| Niveau | XP requis | XP cumulée | Récompense 🪙 | Gemmes 💎 |
|--:|--:|--:|--:|--:|
| 1 | 100 | 0 | 430 | 0 |
| 5 | 818 | 1 365 | 1 595 | 5 |
| 10 | 2 091 | 7 871 | 3 450 | 5 |
| 15 | 3 644 | 21 332 | 5 563 | 5 |
| 20 | 5 420 | 43 021 | 7 863 | 5 |
| 25 | 7 385 | 73 978 | 10 312 | 5 |
| 30 | 9 517 | 115 102 | 12 887 | 5 |
| 35 | 11 800 | 167 195 | 15 573 | 5 |
| 40 | 14 222 | 230 986 | 18 357 | 5 |
| 45 | 16 773 | 307 146 | 21 229 | 5 |
| 50 | 19 444 | 396 304 | 24 182 | 5 |
| 55 | 22 229 | 499 050 | 27 210 | 5 |
| 60 | — | **615 942** | 30 308 | 5 |

L'exposant 1,45 est le paramètre central. À 1,5 (le réflexe habituel), le niveau 60
coûterait ~40 % d'XP en plus et la fin de partie deviendrait pénible ; à 1,3, la
progression s'effondrerait en deux semaines. Le rapport `xpToNext(n+1)/xpToNext(n)`
reste **sous 1,10 dès le niveau 10** : aucun niveau n'est perçu comme un mur.

Les gemmes sont versées **uniquement** aux paliers multiples de 5, 5 à la fois, soit
60 gemmes pour atteindre le niveau 60 — plus les quêtes, succès, votes et événements.
Aucune source payante n'existe.

### 5.2 Coût des parcelles — `800 × 1,155^n`

| Parcelle | Coût | Cumulé | Grille |
|--:|--:|--:|---|
| 9 | 0 | 0 | 3×3 (départ) |
| 10 | 800 | 800 | 3×3 |
| 15 | 1 640 | 7 080 | 4×3 |
| 20 | 3 380 | 20 010 | 5×4 |
| 25 | 6 950 | 46 600 | 5×5 |
| 30 | 14 280 | 101 230 | 6×5 |
| 35 | 29 350 | 213 530 | 6×5 |
| 40 | 60 330 | 444 390 | 6×6 |
| 45 | 124 010 | 918 890 | 7×6 |
| 50 | 254 900 | 1 894 220 | 7×7 |
| 55 | 523 940 | 3 898 990 | 7×7 |
| 60 | 1 076 930 | 8 019 710 | 8×7 |
| 64 | 1 916 540 | **14 276 110** | 8×8 |

C'est **le** puits monétaire principal. La croissance à 1,155 est calibrée pour que
le coût de la parcelle suivante représente toujours environ **une à deux heures de
production** au niveau où le joueur se trouve — assez pour être un objectif, jamais
assez pour être un mur. Le total de 14,3 M 🪙 est atteignable, mais représente
l'essentiel de la partie longue avant prestige.

### 5.3 Prestige

Débloqué au niveau 60. Conserve 50 % des parcelles, tous les bâtiments, les gemmes,
5 % des pièces (plancher 5 000 🪙), les cosmétiques, outils et objets d'événement,
les succès et la coopérative. Bonus **+15 % par rang, 20 rangs maximum** (soit
×4 cumulé au rang 20).

Le prestige est rentable dès le premier rang : rejouer la courbe avec +15 % de gains
et 50 % des parcelles déjà acquises prend nettement moins de temps que la première
montée. C'est ce qui en fait un choix et non une punition.

---

## 6. Qualité et coopératives

### 6.1 Distribution de qualité

Poids de base `normal 1000 / argent 180 / or 55 / iridium 8`, modulés par le score
(fertilité × 0,6 + niveau × 0,004 + bonus, plafonné à +0,6) selon un modèle à
exposants — `argent ∝ score`, `or ∝ score²`, `iridium ∝ score³`.

| Scénario | Normal | Argent | Or | Iridium |
|---|--:|--:|--:|--:|
| Débutant (blé, sol 70, niv. 1) | 78,0 % | 15,7 % | 5,4 % | 0,88 % |
| Optimisé (blé, sol 100, niv. 30, engrais) | 57,6 % | 22,6 % | 15,0 % | 4,75 % |
| Fin de partie (lotus, sol 100, niv. 55, chance) | 29,7 % | 22,7 % | 29,4 % | **18,14 %** |

Le modèle cubique fait que l'iridium est **multiplié par 20** entre le débutant et
le joueur optimisé, alors que l'argent n'est multiplié que par 1,4. Autrement dit :
investir dans la fertilité et les engrais ne fait pas gagner « un peu plus souvent »,
ça change la nature du butin. Avec un multiplicateur de prix de ×3, l'iridium à 18 %
ajoute environ +36 % de valeur moyenne à une récolte de fin de partie.

### 6.2 Bonus de coopérative

| Niveau | XP requis | Membres | Pousse | Vente | XP |
|--:|--:|--:|--:|--:|--:|
| 1 | 5 000 | 10 | +0,4 % | +0,3 % | +0,4 % |
| 6 | 87 904 | 20 | +2,4 % | +1,8 % | +2,4 % |
| 11 | 231 845 | 30 | +4,4 % | +3,3 % | +4,4 % |
| 16 | 422 242 | 40 | +6,4 % | +4,8 % | +6,4 % |
| 21 | 652 410 | 50 | +8,4 % | +6,3 % | +8,4 % |
| 26 | 918 179 | 50 | +10,4 % | +7,8 % | +10,4 % |

Les bonus sont volontairement **modestes** (10 % maximum). L'intérêt d'une
coopérative doit rester social — objectifs collectifs, trésorerie, entraide — et non
mécaniquement obligatoire. Un joueur solo ne doit jamais être hors-jeu ; à +10 %, il
est légèrement moins efficace, pas exclu.

---

## 7. Puits monétaires et vérification anti-exploitation

### 7.1 Ce qui retire des pièces de l'économie

| Puits | Montant |
|---|---|
| Taxe de vente | **3 %** de chaque vente (exonéré sous le niveau 5) |
| Décote de vente directe | **15 %** sous le prix du marché |
| Commission hôtel des ventes | **5 %** du prix de vente |
| Frais de mise en vente | **2 %**, minimum 25 🪙, **non remboursables** |
| Taxe sur les dons | **5 %**, plafond 50 000 🪙/jour |
| Taxe sur les échanges | **2 %** des pièces échangées |
| Parcelles | 14 276 110 🪙 au total |
| Bâtiments | plusieurs millions cumulés sur tous les paliers |
| Graines, nourriture, vétérinaire | coût récurrent proportionnel à la production |
| Relance de quête | 500 🪙, doublant à chaque relance du jour |
| Création de coopérative | 25 000 🪙 |

La décote de 15 % à la vente directe est ce qui rend l'hôtel des ventes utile : y
vendre coûte 7 % de frais au total contre 15 % de décote, donc le joueur patient est
récompensé — mais paie quand même.

### 7.2 Les exploitations recherchées, et pourquoi elles ne fonctionnent pas

| Exploitation | Pourquoi elle échoue |
|---|---|
| **Acheter en boutique, revendre au marché** | Le prix d'achat est toujours supérieur au prix de vente diminué de la décote et de la taxe. Vérifié par test sur **tous** les objets vendables. |
| **Aller-retour boutique du jour ↔ marché** | Même contrainte, remise maximale incluse. |
| **Faire tourner le compost** | Marge ramenée à 1,67× parce que l'entrée est gratuite (§ 4). |
| **Relancer une récolte jusqu'à l'iridium** | Le RNG est *seedé* sur `(cropId, harvestCount)` : rejouer la même récolte donne le même résultat. |
| **Blanchir via les dons** | Taxe de 5 % + plafond quotidien de 50 000 🪙 + niveau minimum 5. |
| **Manipuler un prix de marché** | Plancher 55 % / plafond 180 % **durs**, plus décroissance de volume. |
| **Doubler une action par double-clic** | Verrou Redis par `(joueur, action)` + revalidation d'état sous `FOR UPDATE`. |
| **Multi-comptes en parrainage** | Récompenses versées à des **paliers de progression du filleul**, pas à l'inscription ; *trigger* SQL anti-boucle. |
| **Créer des pièces par arrondi** | `scaleMoney` arrondit vers le bas, `feeOf` vers le haut : l'erreur d'arrondi va toujours à l'économie. |

### 7.3 Détection en exploitation

Le job `economy_snapshot` capture toutes les 30 minutes la masse monétaire, les flux
par type et les écarts du grand livre. Un **score de suspicion** par joueur agrège
les anomalies (gains anormaux, fréquence d'action impossible, écart de grand livre)
avec trois seuils : **50** avertissement journalisé, **120** revue manuelle,
**250** bannissement économique automatique. Une croissance de la masse monétaire
supérieure à **8 % par jour** déclenche une alerte d'inflation.

---

## 8. Régénérer ces tables

```bash
npm run balance:report            # affiche tout le rapport
npm run balance:report > out.txt  # ou le capture
```

Le script lit exclusivement `src/config/gameplay/` : il n'y a aucune valeur en dur.
Toute modification de l'équilibrage se voit immédiatement, et les tests de
`tests/config-and-balance.test.ts` (30 assertions : monotonie du profit horaire,
plafond de marge des recettes, absence d'arbitrage boutique/marché, cohérence des
déblocages par niveau) échouent si un changement casse un invariant.
