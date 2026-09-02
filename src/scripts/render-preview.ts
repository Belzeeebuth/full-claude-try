import './offline-env';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { balance as getBalance, getConfig } from '../config';
import { renderAnimals, type AnimalsRenderAnimal } from '../render/animals';
import { renderFarm } from '../render/farm';
import { renderMarketChart } from '../render/chart';
import { renderProfile } from '../render/profile';
import { renderLeaderboard } from '../render/leaderboard';
import { growthStageIndex, pickStampSubject, renderPostcard, type PostcardPlot } from '../render/postcard';
import { gridSizeFor, slotToCoords } from '../game/grid';
import { translate } from '../i18n';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('preview');

/**
 * Prévisualisation du rendu sans base de données ni Discord.
 *
 *   npm run render:preview
 *
 * Écrit six PNG dans `out/`. Indispensable pour itérer sur le visuel : on
 * modifie `src/render/**`, on relance, on regarde — au lieu de démarrer le bot,
 * de peupler une ferme et de taper une commande.
 */
async function main(): Promise<void> {
  // Une langue par exécution, dans son propre dossier : c'est la façon la plus
  // simple de comparer côte à côte les deux rendus.
  //   PREVIEW_LOCALE=en npm run render:preview
  const locale = process.env.PREVIEW_LOCALE ?? 'fr';
  // Catalogue LOCALISÉ, comme le reçoivent les vues : sinon la prévisualisation
  // anglaise montre des enclos et des bêtes aux noms français.
  const config = getConfig(locale);
  const balance = getBalance();
  const outDir = join(process.cwd(), 'out', locale);
  mkdirSync(outDir, { recursive: true });

  const now = Date.now();
  const unlocked = 25;
  const grid = gridSizeFor(unlocked, balance);
  const cropKeys = ['wheat', 'tomato', 'pumpkin', 'grape', 'melon', 'coffee'];

  const plots = Array.from({ length: balance.plots.maxPlots }, (_, index) => {
    const slot = index + 1;
    // `slotToCoords` et non un calcul maison : la prévisualisation doit
    // montrer la géométrie réellement servie aux joueurs, sans quoi elle ne
    // peut pas révéler un décalage entre la grille et le placement des slots.
    const coords = slotToCoords(slot, balance);
    const locked = slot > unlocked;
    const planted = !locked && slot % 4 !== 0;
    const stages = ['planted', 'sprouting', 'growing', 'maturing', 'ready'] as const;

    return {
      slot,
      x: coords.x,
      y: coords.y,
      state: locked ? ('locked' as const) : planted ? ('growing' as const) : ('empty' as const),
      fertility: 40 + ((slot * 7) % 60),
      fertilityLabel: 'Bonne',
      weedLevel: slot % 9 === 0 ? 55 : 4,
      pestType: slot % 11 === 0 ? ('insects' as const) : null,
      pestDeadlineAt: null,
      unlockCost: 800,
      crop: planted
        ? {
            key: cropKeys[slot % cropKeys.length]!,
            name: config.crops.get(cropKeys[slot % cropKeys.length]!)?.name ?? 'Culture',
            emoji: config.crops.get(cropKeys[slot % cropKeys.length]!)?.emoji ?? '🌱',
            rarity: 'common',
            growth: {
              stage: stages[slot % stages.length]!,
              progress: (slot % 5) / 5,
              ready: slot % 5 === 4,
              withered: slot === 13,
              msRemaining: 60_000 * (slot * 6),
              readyAt: new Date(now + 60_000 * slot * 6),
              withersAt: null,
              needsWater: slot % 3 === 0,
              missedWaterings: 0,
              nextWaterAt: null,
            },
            mutation: slot === 7 ? ('rainbow' as const) : ('none' as const),
            regrowRemaining: slot % 6 === 0 ? 2 : 0,
            waterGiven: 1,
            waterNeeded: 2,
            fertilizerKey: null,
          }
        : undefined,
    };
  }).slice(0, unlocked + 6);

  const farmBuffer = await renderFarm({
    locale,
    view: {
      farmId: 'preview',
      name: 'Ferme des Trois Chênes',
      grid,
      plots: plots as never,
      counts: { ready: 5, growing: 14, empty: 6, locked: 6, withered: 1, pests: 2 },
      world: {
        season: {
          season: 'summer',
          index: 1,
          gameYear: 1,
          startsAt: new Date(),
          endsAt: new Date(),
          key: 'summer_y1',
          progress: 0.42,
        },
        weather: {
          weather: 'rainy',
          emoji: '🌧️',
          label: 'Pluie',
          description: 'Arrosage gratuit.',
          yieldModifier: 1.1,
          growthModifier: 1,
          freeWatering: true,
          damageChance: 0,
          pestChance: 0.09,
          temperature: 19,
          season: 'summer',
          day: '2026-07-26',
        },
        activeEvents: [],
        eventModifiers: {} as never,
      } as never,
      modifiers: {} as never,
      nextReadyAt: new Date(now + 900_000),
      unlockedPlots: unlocked,
      nextPlotCost: 4_550,
    },
    player: { username: 'Marion', level: 24, coins: 1_284_500, gems: 148, avatarUrl: null },
    xp: { current: 4_200, needed: 9_800 },
    theme: 'classic',
    // Comme dans `farmView` : silhouette et palette du catalogue, pour voir le
    // pied de page tel que le joueur le verra.
    animalsPreview: ['chicken', 'cow', 'bee', 'sheep', 'dragonet'].map((key) => ({
      emoji: config.animals.get(key)?.emoji ?? '🐾',
      animalKey: key,
      form: config.animals.get(key)?.form ?? null,
      palette: config.animals.get(key)?.palette ?? null,
    })),
    buildingsPreview: [
      { key: 'house', tier: 2 },
      { key: 'barn', tier: 3 },
      { key: 'well', tier: 1 },
      { key: 'greenhouse', tier: 1 },
      { key: 'mill', tier: 2 },
      { key: 'coop', tier: 2 },
    ],
    equippedPetKey: 'fox',
  });
  writeFileSync(join(outDir, 'ferme.png'), farmBuffer);

  const profileBuffer = await renderProfile({
    locale,
    username: 'Marion',
    displayName: 'Marion des Champs',
    avatarUrl: null,
    title: 'Fermier confirmé',
    badges: ['🏆', '🌾', '🔥'],
    level: 24,
    prestige: 1,
    xp: { current: 4_200, needed: 9_800 },
    coins: 1_284_500,
    gems: 148,
    bank: 450_000,
    energy: { current: 78, max: 130 },
    stats: {
      harvests: 12_480,
      animals: 63,
      crafts: 1_204,
      plots: 25,
      streak: 34,
      achievements: 17,
      bestHarvest: 84_200,
      coinsEarned: 8_940_000,
    },
    coop: { name: 'Les Amis du Blé', tag: 'BLE', level: 7, role: 'officer' },
    themeColor: '#7ec850',
    bannerStyle: 'sunset',
    farmName: 'Ferme des Trois Chênes',
    createdAt: new Date('2026-02-14T09:00:00Z'),
  });
  writeFileSync(join(outDir, 'profil.png'), profileBuffer);

  const points = Array.from({ length: 32 }, (_, index) => ({
    price: 90 + Math.round(Math.sin(index / 3) * 22 + index * 1.4),
    recordedAt: new Date(now - (32 - index) * 3_600_000),
  }));
  const chartBuffer = await renderMarketChart({
    locale,
    title: 'Melon',
    emoji: '🍈',
    points,
    basePrice: 90,
    currentPrice: points.at(-1)!.price,
    trend: 0.083,
    demandIndex: 1.12,
  });
  writeFileSync(join(outDir, 'marche.png'), chartBuffer);

  const leaderboardBuffer = await renderLeaderboard({
    locale,
    // Les libellés viennent du catalogue, comme dans la vraie commande : sinon
    // la prévisualisation anglaise afficherait un classement au titre français
    // et donnerait une fausse impression de traduction incomplète.
    title: translate(locale, 'leaderboard.wealth'),
    emoji: '🪙',
    unit: translate(locale, 'leaderboard.unit.wealth'),
    scopeLabel: translate(locale, 'leaderboard.scope.global'),
    entries: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      name: ['Marion', 'Théo', 'Aïcha', 'Luc', 'Sofia', 'Yanis', 'Emma', 'Noah', 'Léa', 'Gabriel'][index]!,
      score: 5_000_000 - index * 420_000,
      extra: translate(locale, 'leaderboard.entry_level', { level: 60 - index * 3 }),
      isViewer: index === 3,
    })),
    viewer: { rank: 4, score: 3_740_000 },
  });
  writeFileSync(join(outDir, 'classement.png'), leaderboardBuffer);

  // Basse-cour : une bête de chaque silhouette au moins, et chaque pastille
  // représentée une fois — c'est ici qu'on voit si une forme est illisible.
  const species = (key: string, index: number, overrides: Partial<AnimalsRenderAnimal> = {}): AnimalsRenderAnimal => {
    const animal = config.animals.get(key);
    if (!animal) throw new Error(`espèce inconnue dans la prévisualisation : ${key}`);
    const product = config.items.get(animal.productItemKey);
    return {
      id: `preview-${index}-${key}`,
      animalKey: key,
      name: animal.name,
      nickname: null,
      emoji: animal.emoji,
      form: animal.form ?? null,
      palette: animal.palette ?? null,
      buildingKey: animal.buildingKey,
      hunger: 80,
      happiness: 75,
      health: 100,
      hungry: false,
      sick: false,
      canCollect: false,
      canFeed: true,
      canPet: false,
      readyProduction: 0,
      productEmoji: product?.emoji ?? '📦',
      ...overrides,
    };
  };
  const barnyard = [
    species('chicken', 1, { nickname: 'Poulette', hungry: true, hunger: 20 }),
    species('chicken', 2, { canCollect: true, readyProduction: 2 }),
    species('duck', 3, { happiness: 92 }),
    species('goose', 4, { canPet: true, happiness: 40 }),
    species('turkey', 5),
    species('rabbit', 6, { nickname: 'Pompon', canPet: true, happiness: 55 }),
    species('sheep', 7, { sick: true, health: 45 }),
    species('tortoise', 8, { happiness: 95, hunger: 90 }),
    species('peacock', 9, { canCollect: true, readyProduction: 1 }),
    species('cow', 10, { nickname: 'Marguerite', canCollect: true, readyProduction: 3 }),
    species('pig', 11, { hungry: true, hunger: 10, canPet: true, happiness: 30 }),
    species('horse', 12),
    species('bee', 13, { canCollect: true, readyProduction: 4 }),
    species('dragonet', 14, { happiness: 96, hunger: 88 }),
    species('unicorn', 15, { sick: true, health: 60 }),
  ];
  const animalsBuffer = await renderAnimals({
    locale,
    farmId: 'preview',
    ownerName: 'Marion',
    season: 'summer',
    weather: 'sunny',
    buildings: [
      { key: 'coop', name: config.buildings.get('coop')?.name ?? 'coop', tier: 2, capacity: 8, used: 5 },
      { key: 'pen', name: config.buildings.get('pen')?.name ?? 'pen', tier: 1, capacity: 4, used: 4 },
      { key: 'barn', name: config.buildings.get('barn')?.name ?? 'barn', tier: 2, capacity: 6, used: 3 },
      { key: 'apiary', name: config.buildings.get('apiary')?.name ?? 'apiary', tier: 1, capacity: 3, used: 1 },
      { key: 'mythic_pen', name: config.buildings.get('mythic_pen')?.name ?? 'lair', tier: 1, capacity: 3, used: 2 },
    ],
    animals: barnyard,
    totals: { alive: barnyard.length, hungry: 2, sick: 2, ready: 5 },
  });
  writeFileSync(join(outDir, 'animaux.png'), animalsBuffer);

  // Carte postale : la MÊME ferme que `ferme.png`, sans son tableau de bord.
  // C'est ici qu'on juge si la carte donne envie d'être partagée — légende
  // longue, prestige, bêtes de plusieurs formes, timbre à la culture préférée.
  const postcardPlots: PostcardPlot[] = plots.map((plot) => ({
    slot: plot.slot,
    x: plot.x,
    y: plot.y,
    locked: plot.state === 'locked',
    fertility: plot.fertility,
    crop: plot.crop
      ? {
          key: plot.crop.key,
          stage: growthStageIndex(plot.crop.growth.stage),
          ready: plot.crop.growth.ready,
          withered: plot.crop.growth.withered,
        }
      : null,
  }));
  const postcardAnimals = ['chicken', 'cow', 'sheep', 'bee', 'dragonet', 'pig'].map((key) => ({
    animalKey: key,
    emoji: config.animals.get(key)?.emoji ?? '🐾',
    form: config.animals.get(key)?.form ?? null,
    palette: config.animals.get(key)?.palette ?? null,
  }));
  const postcardBuffer = await renderPostcard({
    locale,
    farmId: 'preview',
    farmName: 'Ferme des Trois Chênes',
    farmer: { name: 'Marion', level: 24, prestige: 1, coins: 1_284_500 },
    caption:
      locale === 'en'
        ? 'First melons of the summer, come and taste them!'
        : "Premiers melons de l'été, venez goûter !",
    date: new Date('2026-09-02T10:00:00Z'),
    timezone: 'Europe/Paris',
    season: 'summer',
    weather: { weather: 'sunny', label: 'Ensoleillé', temperature: 26 },
    grid,
    plots: postcardPlots,
    animals: postcardAnimals,
    buildings: [
      { key: 'house', tier: 2 },
      { key: 'barn', tier: 3 },
      { key: 'well', tier: 1 },
      { key: 'greenhouse', tier: 1 },
      { key: 'mill', tier: 2 },
    ],
    stamp: pickStampSubject(postcardPlots, postcardAnimals),
  });
  writeFileSync(join(outDir, 'carte-postale.png'), postcardBuffer);

  log.info(
    {
      ferme: farmBuffer.byteLength,
      profil: profileBuffer.byteLength,
      marche: chartBuffer.byteLength,
      classement: leaderboardBuffer.byteLength,
      animaux: animalsBuffer.byteLength,
      cartePostale: postcardBuffer.byteLength,
    },
    `✅ 6 images écrites dans ${outDir} (langue : ${locale})`,
  );
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, 'prévisualisation impossible');
  process.exit(1);
});
