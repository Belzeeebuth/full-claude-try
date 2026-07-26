import { balance as getBalance, getConfig } from '../config';
import { cumulativePlotCost, plotCostTable } from '../game/grid';
import { qualityDistribution, qualityScore } from '../game/quality';
import { xpTable } from '../game/xp';
import { coopXpForNext } from '../game/coop';

/**
 * Rapport d'équilibrage — `npm run balance:report`.
 *
 * Tout est DÉRIVÉ des fichiers de configuration : modifier `crops.json` et
 * relancer met le tableau à jour. C'est ce rapport qui alimente
 * `docs/04-equilibrage.md`, et les mêmes invariants sont vérifiés par les tests
 * (`tests/balance.test.ts`) — un déséquilibre casse donc la CI, pas seulement la
 * documentation.
 */

const NUMBER = new Intl.NumberFormat('fr-FR');

function pad(value: string | number, width: number, align: 'left' | 'right' = 'right'): string {
  const text = String(value);
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

function heading(title: string): void {
  console.log(`\n${'═'.repeat(96)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(96));
}

function cropReport(): void {
  const config = getConfig();
  heading('CULTURES — rentabilité par parcelle et par heure');
  console.log(
    `${pad('Culture', 20, 'left')} ${pad('Niv', 4)} ${pad('Graine', 8)} ${pad('Rdt', 4)} ${pad('Vente', 8)} ${pad('Durée', 9)} ${pad('Profit', 10)} ${pad('Profit/h', 10)} ${pad('ROI', 6)}`,
  );
  console.log('─'.repeat(96));

  for (const crop of config.cropList) {
    // Une culture repousseuse amortit sa graine sur plusieurs cycles : on
    // calcule sur la durée TOTALE (premier cycle + repousses).
    const cycles = 1 + crop.regrowCycles;
    const totalSeconds = crop.growthSeconds + crop.regrowCycles * crop.regrowSeconds;
    const gross = crop.sellPrice * crop.baseYield * cycles;
    const profit = gross - crop.seedPrice;
    const perHour = Math.round((profit / totalSeconds) * 3_600);
    const roi = gross / Math.max(1, crop.seedPrice);

    console.log(
      `${pad(`${crop.emoji} ${crop.name}`, 20, 'left')} ${pad(crop.requiredLevel, 4)} ${pad(NUMBER.format(crop.seedPrice), 8)} ${pad(crop.baseYield, 4)} ${pad(NUMBER.format(crop.sellPrice), 8)} ${pad(formatDuration(totalSeconds), 9)} ${pad(NUMBER.format(profit), 10)} ${pad(NUMBER.format(perHour), 10)} ${pad(`${roi.toFixed(1)}×`, 6)}`,
    );
  }
}

function animalReport(): void {
  const config = getConfig();
  heading('ANIMAUX — rentabilité et amortissement');
  console.log(
    `${pad('Animal', 20, 'left')} ${pad('Niv', 4)} ${pad('Prix', 9)} ${pad('Produit', 16, 'left')} ${pad('Cycle', 8)} ${pad('Net/h', 9)} ${pad('Amorti', 9)}`,
  );
  console.log('─'.repeat(96));

  for (const animal of config.animalList) {
    const product = config.items.get(animal.productItemKey);
    const feed = config.items.get(animal.feedItemKey);
    const cycleHours = animal.productionSeconds / 3_600;
    const revenue = ((product?.sellPrice ?? 0) * animal.productQuantity) / cycleHours;
    const cost = ((feed?.basePrice ?? 0) * animal.feedPerCycle) / cycleHours;
    const net = revenue - cost;
    const price = animal.price > 0 ? animal.price : animal.priceGems * 250; // gemme ≈ 250 pièces
    const payback = net > 0 ? price / net : Infinity;

    console.log(
      `${pad(`${animal.emoji} ${animal.name}`, 20, 'left')} ${pad(animal.requiredLevel, 4)} ${pad(NUMBER.format(price), 9)} ${pad(`${animal.productQuantity}× ${product?.name ?? '?'}`, 16, 'left')} ${pad(formatDuration(animal.productionSeconds), 8)} ${pad(NUMBER.format(Math.round(net)), 9)} ${pad(Number.isFinite(payback) ? `${payback.toFixed(1)} h` : '—', 9)}`,
    );
  }
}

function recipeReport(): void {
  const config = getConfig();
  heading('RECETTES — valeur ajoutée de la transformation');
  console.log(
    `${pad('Recette', 24, 'left')} ${pad('Niv', 4)} ${pad('Ingrédients', 10)} ${pad('Produit', 10)} ${pad('Marge', 8)} ${pad('Durée', 8)} ${pad('Gain/h', 9)}`,
  );
  console.log('─'.repeat(96));

  for (const recipe of config.recipeList) {
    const ingredients = recipe.ingredients as Array<{ itemKey: string; quantity: number }>;
    const inputValue = ingredients.reduce((sum, ingredient) => {
      const item = config.items.get(ingredient.itemKey);
      return sum + (item?.sellPrice ?? 0) * ingredient.quantity;
    }, 0);
    const output = config.items.get(recipe.outputItemKey);
    const outputValue = (output?.sellPrice ?? 0) * recipe.outputQuantity;
    const margin = inputValue > 0 ? outputValue / inputValue : 0;
    const gainPerHour = Math.round(((outputValue - inputValue) / recipe.durationSeconds) * 3_600);

    console.log(
      `${pad(`${recipe.emoji} ${recipe.name}`, 24, 'left')} ${pad(recipe.requiredLevel, 4)} ${pad(NUMBER.format(inputValue), 10)} ${pad(NUMBER.format(outputValue), 10)} ${pad(`${margin.toFixed(2)}×`, 8)} ${pad(formatDuration(recipe.durationSeconds), 8)} ${pad(NUMBER.format(gainPerHour), 9)}`,
    );
  }
}

function progressionReport(): void {
  const balance = getBalance();
  heading("PROGRESSION — courbe d'XP et récompenses de palier");
  console.log(
    `${pad('Niveau', 7)} ${pad('XP requis', 12)} ${pad('XP cumulée', 14)} ${pad('Récompense', 12)} ${pad('Gemmes', 7)}`,
  );
  console.log('─'.repeat(96));

  const table = xpTable(balance);
  for (const row of table) {
    if (row.level % 5 !== 0 && row.level !== 1 && row.level !== balance.progression.maxLevel) continue;
    console.log(
      `${pad(row.level, 7)} ${pad(NUMBER.format(row.xpForNext), 12)} ${pad(NUMBER.format(row.cumulative), 14)} ${pad(NUMBER.format(row.rewardCoins), 12)} ${pad(row.rewardGems, 7)}`,
    );
  }
  const last = table.at(-1);
  console.log(
    `\n  Total pour atteindre le niveau ${balance.progression.maxLevel} : ${NUMBER.format(last?.cumulative ?? 0)} XP`,
  );
}

function plotReport(): void {
  const balance = getBalance();
  heading('PARCELLES — coût d\'extension');
  console.log(`${pad('Parcelle', 9)} ${pad('Coût', 14)} ${pad('Cumulé', 16)} ${pad('Grille', 8)}`);
  console.log('─'.repeat(96));

  for (const row of plotCostTable(balance)) {
    if (row.slot < balance.plots.startingUnlocked) continue;
    if (row.slot % 5 !== 0 && row.slot !== balance.plots.startingUnlocked && row.slot !== balance.plots.maxPlots) {
      continue;
    }
    console.log(
      `${pad(row.slot, 9)} ${pad(NUMBER.format(row.cost), 14)} ${pad(NUMBER.format(row.cumulative), 16)} ${pad(`${row.gridWidth}×${row.gridHeight}`, 8)}`,
    );
  }
  console.log(
    `\n  Coût total pour passer de ${balance.plots.startingUnlocked} à ${balance.plots.maxPlots} parcelles : ${NUMBER.format(cumulativePlotCost(balance.plots.startingUnlocked, balance.plots.maxPlots, balance))} 🪙`,
  );
}

function qualityReport(): void {
  const config = getConfig();
  const balance = getBalance();
  heading('QUALITÉ — distribution selon le score');

  const scenarios = [
    { label: 'Débutant (blé, sol 70, niv. 1)', crop: 'wheat', fertility: 70, level: 1, luck: 0 },
    { label: 'Optimisé (blé, sol 100, niv. 30, engrais)', crop: 'wheat', fertility: 100, level: 30, luck: 0.25 },
    { label: 'Fin de partie (lotus, sol 100, niv. 55, chance)', crop: 'star_lotus', fertility: 100, level: 55, luck: 0.6 },
  ];

  console.log(`${pad('Scénario', 46, 'left')} ${pad('Normal', 9)} ${pad('Argent', 9)} ${pad('Or', 9)} ${pad('Iridium', 9)}`);
  console.log('─'.repeat(96));

  for (const scenario of scenarios) {
    const crop = config.crops.get(scenario.crop);
    if (!crop) continue;
    const score = qualityScore(
      crop,
      {
        fertility: scenario.fertility,
        level: scenario.level,
        fertilizerQualityBoost: scenario.luck > 0 ? 0.25 : 0,
        qualityBonus: 0,
        luck: scenario.luck,
      },
      balance,
    );
    const distribution = qualityDistribution(score, balance);
    console.log(
      `${pad(scenario.label, 46, 'left')} ${pad(`${(distribution.normal * 100).toFixed(1)} %`, 9)} ${pad(`${(distribution.silver * 100).toFixed(1)} %`, 9)} ${pad(`${(distribution.gold * 100).toFixed(1)} %`, 9)} ${pad(`${(distribution.iridium * 100).toFixed(2)} %`, 9)}`,
    );
  }
}

function sinkReport(): void {
  const balance = getBalance();
  heading('PUITS MONÉTAIRES — ce qui retire des pièces de l\'économie');
  const sinks = [
    ['Taxe de vente', `${(balance.economy.salesTaxRate * 100).toFixed(1)} % de chaque vente (exonéré < niv. ${balance.economy.salesTaxFreeLevel})`],
    ['Décote de vente directe', `${(balance.economy.sellDirectPenalty * 100).toFixed(0)} % sous le prix du marché`],
    ['Commission hôtel des ventes', `${(balance.auction.commissionRate * 100).toFixed(0)} % du prix de vente`],
    ['Frais de mise en vente', `${(balance.auction.listingFeeRate * 100).toFixed(0)} % (min. ${balance.auction.minListingFee} 🪙), non remboursables`],
    ['Taxe sur les dons', `${(balance.economy.giftTaxRate * 100).toFixed(0)} %, plafond ${NUMBER.format(balance.economy.giftDailyLimit)} 🪙/jour`],
    ['Taxe sur les échanges', `${(balance.trade.taxRate * 100).toFixed(0)} % des pièces échangées`],
    ['Parcelles', `${NUMBER.format(cumulativePlotCost(balance.plots.startingUnlocked, balance.plots.maxPlots, balance))} 🪙 au total`],
    ['Bâtiments', 'plusieurs millions cumulés sur tous les paliers'],
    ['Graines, nourriture, vétérinaire', 'coût récurrent proportionnel à la production'],
    ['Relance de quête', `${NUMBER.format(balance.quests.rerollCostCoins)} 🪙 ×${balance.quests.rerollCostGrowth} par relance`],
    ['Création de coopérative', `${NUMBER.format(balance.coop.creationCostCoins)} 🪙`],
  ];
  for (const [name, detail] of sinks) {
    console.log(`  • ${pad(name ?? '', 32, 'left')} ${detail}`);
  }
}

function coopReport(): void {
  const balance = getBalance();
  heading('COOPÉRATIVES — progression et bonus');
  console.log(`${pad('Niveau', 8)} ${pad('XP requis', 14)} ${pad('Membres', 9)} ${pad('Pousse', 9)} ${pad('Vente', 9)} ${pad('XP', 9)}`);
  console.log('─'.repeat(96));
  for (let level = 1; level <= balance.coop.maxLevel; level += 5) {
    const bonuses = balance.coop.bonusesPerLevel;
    console.log(
      `${pad(level, 8)} ${pad(NUMBER.format(coopXpForNext(level, balance)), 14)} ${pad(Math.min(50, balance.coop.baseMemberLimit + balance.coop.memberLimitPerLevel * (level - 1)), 9)} ${pad(`+${(bonuses.growthSpeed * level * 100).toFixed(1)} %`, 9)} ${pad(`+${(bonuses.sellBonus * level * 100).toFixed(1)} %`, 9)} ${pad(`+${(bonuses.xpBonus * level * 100).toFixed(1)} %`, 9)}`,
    );
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3_600;
  return hours >= 24 ? `${(hours / 24).toFixed(1)} j` : `${hours.toFixed(1)} h`;
}

function main(): void {
  console.log('\n🌾 HARVESTBOT — RAPPORT D\'ÉQUILIBRAGE');
  console.log(`Généré depuis src/config/gameplay/ • ${new Date().toISOString()}`);
  cropReport();
  animalReport();
  recipeReport();
  progressionReport();
  plotReport();
  qualityReport();
  coopReport();
  sinkReport();
  console.log('\n');
}

if (require.main === module) {
  main();
}

export { cropReport, animalReport, recipeReport, progressionReport };
