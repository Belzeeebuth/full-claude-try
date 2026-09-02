import { balance as getBalance } from '../config';
import { getDb } from '../db/client';
import { pruneMemoryLocks } from '../utils/lock';
import { pruneMemory } from '../framework/cooldown';
import { moduleLogger } from '../utils/logger';
import { liveRng } from '../game/rng';
import { pestConsequence, rollPest, rollWeatherDamage } from '../game/plot';
import { projectAnimal } from '../game/animals';
import { getConfig } from '../config';
import * as animalRepo from '../repositories/animal.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as farmRepo from '../repositories/farm.repo';
import * as inventoryRepo from '../repositories/inventory.repo';
import * as systemRepo from '../repositories/system.repo';
import * as coopService from '../services/coop.service';
import * as economyService from '../services/economy.service';
import * as ledgerService from '../services/ledger.service';
import * as marketService from '../services/market.service';
import * as miscService from '../services/misc.service';
import * as progressionService from '../services/progression.service';
import * as tradeService from '../services/trade.service';
import * as webhookService from '../services/webhook.service';
import { ensureSeasonCalendar, getWorldState } from '../services/world.service';
import { isPestRepelActive } from '../services/consumable.service';
import { currentWeekStart, toSqlDate, weeklyCycleKey } from '../utils/time';

const log = moduleLogger('jobs');

/**
 * ---------------------------------------------------------------------------
 * TÂCHES PLANIFIÉES
 * ---------------------------------------------------------------------------
 * Rappel de conception : la croissance des cultures et la décroissance des
 * jauges animales sont calculées À LA LECTURE. Les jobs ci-dessous ne font donc
 * PAS avancer le jeu ; ils gèrent uniquement ce qui doit arriver même quand le
 * joueur ne regarde pas :
 *   • événements du monde (météo, saison, nuisibles, dégâts) ;
 *   • fermetures à échéance (enchères, échanges, quêtes) ;
 *   • agrégats et instantanés (marché, classements, économie) ;
 *   • notifications sortantes.
 *
 * Chaque job est idempotent : le relancer deux fois ne double jamais un effet.
 */

export interface JobDefinition {
  key: string;
  /** Expression cron (UTC). */
  cron: string;
  description: string;
  run: () => Promise<string>;
}

export const jobs: JobDefinition[] = [
  {
    key: 'market:update',
    cron: '0 * * * *',
    description: 'Recalculates market prices from supply and demand',
    async run() {
      const updated = await marketService.updateMarket();
      return `${updated} prices updated`;
    },
  },

  {
    key: 'shop:rotate',
    cron: '5 0 * * *',
    description: 'Generates the daily shop and the black market',
    async run() {
      const entries = await marketService.rotateShop();
      const blackMarketEntries = await marketService.rotateBlackMarket();
      return `${entries} shop articles, ${blackMarketEntries} black market`;
    },
  },

  {
    key: 'world:weather',
    cron: '0 0 * * *',
    description: 'Sets the daily weather and updates the active season',
    async run() {
      await ensureSeasonCalendar();
      const world = await getWorldState();
      return `${world.weather.label} (${world.season.season})`;
    },
  },

  {
    key: 'farm:pests',
    cron: '0 */2 * * *',
    description: 'Spawns pests and applies weather damage',
    async run() {
      const balance = getBalance();
      const config = getConfig();
      const world = await getWorldState();
      const candidates = await farmRepo.findPlotsForPestRoll(500);
      const windowMs = 2 * 3_600_000;
      let pests = 0;
      let damaged = 0;

      // Les 500 parcelles d'un cycle appartiennent à bien moins de 500 fermes :
      // on mémorise par joueur et par ferme au lieu de refaire les mêmes
      // lectures parcelle après parcelle (4 GET Redis × 500 auparavant).
      const repelByUser = new Map<string, boolean>();
      const reductionByFarm = new Map<string, number>();

      const repelFor = async (userId: string): Promise<boolean> => {
        const known = repelByUser.get(userId);
        if (known !== undefined) return known;
        const active = await isPestRepelActive(userId);
        repelByUser.set(userId, active);
        return active;
      };

      /**
       * Réduction des dégâts météo apportée par les bâtiments (la serre au
       * premier chef). Elle était câblée à zéro : le joueur payait 90 000 pièces
       * une protection que ce job ignorait.
       */
      const damageReductionFor = async (farmId: string): Promise<number> => {
        const known = reductionByFarm.get(farmId);
        if (known !== undefined) return known;
        let reduction = 0;
        for (const owned of await animalRepo.listBuildings(farmId)) {
          const tier = config.buildings
            .get(owned.buildingKey)
            ?.tiers.find((entry) => entry.tier === owned.building.tier);
          if (tier?.effect?.weatherDamageReduction !== undefined) {
            reduction = Math.max(reduction, tier.effect.weatherDamageReduction);
          }
        }
        reductionByFarm.set(farmId, reduction);
        return reduction;
      };

      for (const candidate of candidates) {
        const repelActive = await repelFor(candidate.userId);
        const rng = liveRng(`pest:${candidate.plotId}`);

        const pest = rollPest(
          {
            windowMs,
            weatherPestChance: world.weather.pestChance,
            repelActive,
            weedLevel: candidate.weedLevel,
          },
          balance,
          rng,
        );

        if (pest) {
          await farmRepo.updatePlot(candidate.plotId, {
            pestType: pest,
            pestAppearedAt: new Date(),
            pestDeadlineAt: new Date(Date.now() + balance.pests.deadlineHours * 3_600_000),
          });
          pests += 1;

          await systemRepo.enqueueNotification({
            userId: candidate.userId,
            type: 'crop_withering',
            payload: {
              titleKey: 'notifications.pest_title',
              bodyKey: 'notifications.pest_body',
              params: { slot: candidate.slot, hours: balance.pests.deadlineHours },
            },
            dedupeKey: `pest:${candidate.plotId}:${toSqlDate(new Date())}`,
          });
        }

        // Dégâts météo (orage, gel) : indépendants des nuisibles, mais atténués
        // par la serre — que ce job ignorait purement et simplement.
        const damage = rollWeatherDamage(
          {
            damageChance: world.weather.damageChance,
            damageReduction: await damageReductionFor(candidate.farmId),
          },
          rng,
        );
        if (damage > 0) {
          const plots = await farmRepo.getPlotBySlot(candidate.farmId, candidate.slot);
          if (plots?.crop) {
            await farmRepo.updatePlantedCrop(plots.crop.id, {
              damagePenalty: Math.min(1, Number(plots.crop.damagePenalty) + damage).toFixed(3),
            });
            damaged += 1;
          }
        }
      }

      return `${pests} pests, ${damaged} plots damaged`;
    },
  },

  {
    key: 'farm:pest-consequences',
    cron: '30 */2 * * *',
    description: 'Applies the consequences of ignored pests',
    async run() {
      const balance = getBalance();
      const db = getDb();
      const { and, lte, isNotNull, eq, sql } = await import('drizzle-orm');
      const schema = await import('../db/schema');

      const overdue = await db
        .select({ plotId: schema.plots.id, cropId: schema.plantedCrops.id })
        .from(schema.plots)
        .innerJoin(schema.plantedCrops, eq(schema.plantedCrops.plotId, schema.plots.id))
        .where(
          and(
            isNotNull(schema.plots.pestDeadlineAt),
            lte(schema.plots.pestDeadlineAt, new Date()),
            sql`${schema.plots.pestType} IS NOT NULL`,
          ),
        )
        .limit(300);

      let applied = 0;
      for (const entry of overdue) {
        const outcome = pestConsequence(balance, liveRng(`pest-out:${entry.plotId}`));
        await farmRepo.updatePlantedCrop(entry.cropId, {
          damagePenalty: outcome.damagePenalty.toFixed(3),
          withered: outcome.withered,
        });
        await farmRepo.updatePlot(entry.plotId, {
          pestType: null,
          pestAppearedAt: null,
          pestDeadlineAt: null,
          ...(outcome.withered ? { state: 'withered' as const } : {}),
        });
        applied += 1;
      }
      return `${applied} plots affected`;
    },
  },

  {
    key: 'farm:wither',
    cron: '15 * * * *',
    description: 'Withers crops left too long',
    async run() {
      const withered = await farmRepo.witherOverdueCrops(new Date(), 500);
      return `${withered} crops withered`;
    },
  },

  {
    key: 'animals:decay',
    cron: '0 */3 * * *',
    description: 'Materialises hunger, happiness and health; triggers illness and death',
    async run() {
      const balance = getBalance();
      const config = getConfig();
      const now = new Date();
      const rows = await animalRepo.findAnimalsForDecay(new Date(now.getTime() - 3 * 3_600_000), 500);

      let sick = 0;
      let died = 0;
      let notified = 0;

      for (const row of rows) {
        const animalConfig = config.animals.get(row.animal.animalKey);
        if (!animalConfig) continue;

        const status = projectAnimal(
          {
            animalKey: row.animal.animalKey,
            hunger: row.animal.hunger,
            happiness: row.animal.happiness,
            health: row.animal.health,
            statsUpdatedAt: row.animal.statsUpdatedAt,
            lastFedAt: row.animal.lastFedAt,
            lastCollectedAt: row.animal.lastCollectedAt,
            lastPettedAt: row.animal.lastPettedAt,
            productionReadyAt: row.animal.productionReadyAt,
            pendingProduction: row.animal.pendingProduction,
            qualityMultiplier: Number(row.animal.qualityMultiplier),
            isSick: row.animal.isSick,
            isAlive: row.animal.isAlive,
            bornAt: row.animal.bornAt,
          },
          animalConfig,
          now,
          balance,
        );

        if (status.shouldDie) {
          await animalRepo.killAnimal(row.animal.id, 'negligence', now);
          died += 1;
          await systemRepo.enqueueNotification({
            userId: row.animal.userId,
            type: 'animal_sick',
            payload: {
              titleKey: 'notifications.animal_death_title',
              bodyKey: 'notifications.animal_death_body',
              params: { name: row.name },
            },
            dedupeKey: `death:${row.animal.id}`,
          });
          continue;
        }

        await animalRepo.updateAnimal(row.animal.id, {
          hunger: status.hunger,
          happiness: status.happiness,
          health: status.health,
          isSick: status.sick,
          statsUpdatedAt: now,
        });
        if (status.sick && !row.animal.isSick) sick += 1;

        if (status.hungry) {
          const enqueued = await systemRepo.enqueueNotification({
            userId: row.animal.userId,
            type: 'animal_hungry',
            payload: {
              titleKey: 'notifications.animal_hungry_title',
              bodyKey: 'notifications.animal_hungry_body',
              params: { name: row.name, hunger: status.hunger },
            },
            dedupeKey: `hungry:${row.animal.id}:${toSqlDate(now)}`,
          });
          if (enqueued) notified += 1;
        }
      }

      return `${rows.length} animals processed, ${sick} sick, ${died} deaths, ${notified} alerts`;
    },
  },

  {
    key: 'crops:ready-notify',
    cron: '*/10 * * * *',
    description: 'Notifies players whose crops are ready',
    async run() {
      const ready = await farmRepo.findCropsReadyForNotification(300);
      let queued = 0;
      for (const crop of ready) {
        const enqueued = await systemRepo.enqueueNotification({
          userId: crop.userId,
          type: 'crop_ready',
          payload: {
            titleKey: 'notifications.crop_ready_title',
            bodyKey: 'notifications.crop_ready_body',
            params: { slot: crop.plotSlot },
          },
          dedupeKey: `ready:${crop.userId}:${crop.plotSlot}:${crop.readyAt.toISOString()}`,
        });
        if (enqueued) queued += 1;
        if (enqueued) {
          await webhookService.enqueueEvent(crop.userId, 'crop_ready', {
            plotSlot: crop.plotSlot,
            cropKey: crop.cropKey,
            readyAt: crop.readyAt.toISOString(),
          });
        }
      }
      return `${queued} notifications scheduled`;
    },
  },

  {
    key: 'auctions:expire',
    cron: '*/5 * * * *',
    description: 'Closes expired auctions and refunds losing bids',
    async run() {
      const result = await tradeService.closeExpiredListings(50);
      const trades = await tradeService.expireTrades(50);
      const filled = await tradeService.matchStandingOrders(50);
      const expiredOrders = await tradeService.expireStandingOrders(100);
      return `${result.sold} sold, ${result.returned} returned, ${trades} trades expired, ${filled} orders filled, ${expiredOrders} orders expired`;
    },
  },

  {
    key: 'webhooks:dispatch',
    cron: '* * * * *',
    description: 'Delivers pending outgoing webhook events',
    async run() {
      const result = await webhookService.dispatchPending(100);
      return `${result.delivered} delivered, ${result.failed} failed`;
    },
  },

  {
    key: 'quests:expire',
    cron: '10 0 * * *',
    description: 'Expires quests from the elapsed cycle',
    async run() {
      const expired = await progressionService.expireQuests(new Date());
      return `${expired} quests expired`;
    },
  },

  {
    key: 'coop:objectives',
    cron: '*/15 * * * *',
    description: 'Distributes rewards for completed co-op objectives',
    async run() {
      const distributed = await coopService.distributeObjectiveRewards(20);
      return `${distributed} objectives rewarded`;
    },
  },

  {
    key: 'bank:interest',
    cron: '0 3 * * *',
    description: 'Pays daily bank interest',
    async run() {
      // Solde minimal en dessous duquel l'intérêt s'arrondirait à zéro : ces
      // comptes doivent être écartés par le SQL, sinon ils monopolisent le lot
      // en revenant chaque jour sans que leur échéance n'avance jamais.
      const rate = getBalance().bank.tiers[0]?.interestRate ?? 0.01;
      const minimumBalance = Math.max(1, Math.ceil(1 / Math.max(rate, 0.0001)));

      const accounts = await economyRepo.findAccountsForInterest(
        new Date(Date.now() - 86_400_000),
        500,
        minimumBalance,
      );
      const now = new Date();
      const { withTransaction } = await import('../db/client');
      let total = 0;
      let skipped = 0;

      for (const account of accounts) {
        const raw = Math.floor(account.balance * Number(account.interestRate));
        const interest = Math.min(raw, account.interestCap);
        if (interest <= 0) {
          // Échéance repoussée quand même : sans cela le compte est re-servi
          // demain, et après-demain, à la place d'un compte éligible.
          await economyRepo.skipInterest(account.id, now);
          skipped += 1;
          continue;
        }
        await withTransaction(async (tx) => {
          await economyRepo.applyInterest(account.id, interest, now, tx);
        });
        total += interest;
      }
      return `${accounts.length} accounts, ${total} coins of interest, ${skipped} skipped`;
    },
  },

  {
    key: 'economy:snapshot',
    cron: '30 * * * *',
    description: 'Captures an economic snapshot and checks the ledger',
    async run() {
      const snapshot = await economyRepo.captureEconomySnapshot(new Date(Date.now() - 3_600_000));
      const mismatches = await economyService.auditLedger(100);
      const suspiciousUsers = await economyRepo.countSuspiciousUsers(
        getBalance().economy.suspicionThresholds.review,
      );
      await economyRepo.recordSnapshotHealth(snapshot.id, {
        ledgerMismatches: mismatches.length,
        suspiciousUsers,
      });
      return `supply ${snapshot.totalCoins} 🪙, ${mismatches.length} drift(s), ${suspiciousUsers} flagged`;
    },
  },

  {
    key: 'ledger:checkpoint',
    cron: '0 5 1 * *',
    description: 'Freezes the monthly opening balances of the ledger',
    async run() {
      // Une heure après la purge nocturne, jamais en même temps : les deux
      // touchent `transactions` à des identifiants disjoints, mais autant ne
      // pas les faire se disputer le pool à 04:00.
      const result = await ledgerService.checkpointLedger(new Date());
      return (
        `${result.written} checkpoints for ${result.periodStart}, ` +
        `${result.drifts} drift(s), ${result.failedBatches} failed batch(es)`
      );
    },
  },

  {
    key: 'leaderboard:weekly',
    cron: '0 0 * * 1',
    description: 'Freezes leaderboards and resets weekly counters',
    async run() {
      const periodKey = weeklyCycleKey(new Date(Date.now() - 86_400_000));
      const captured = await miscService.snapshotLeaderboards(periodKey);
      await progressionService.weeklyReset();
      await coopService.weeklyReset();
      return `${captured} rows frozen for ${periodKey}`;
    },
  },

  {
    key: 'maintenance:cleanup',
    cron: '0 4 * * *',
    description: 'Purges history, empty stacks and stale locks',
    async run() {
      const balance = getBalance();
      const before = new Date(Date.now() - balance.market.historyRetentionDays * 86_400_000);
      const history = await economyRepo.purgeOldHistory(before);
      const shop = await economyRepo.purgeOldShopStock(
        toSqlDate(new Date(Date.now() - 7 * 86_400_000)),
      );
      const stacks = await inventoryRepo.pruneEmptyStacks();
      const locks = pruneMemoryLocks() + pruneMemory();
      // En dernier : c'est la seule étape qui touche au journal comptable, et
      // un refus (dérive, absence de checkpoint) ne doit priver de rien les
      // purges qui précèdent. Jamais de suppression sans solde d'ouverture.
      const ledger = await ledgerService.purgeLedger(new Date());
      return (
        `${history} history points, ${shop} shop rows, ${stacks} empty stacks, ${locks} locks, ` +
        `${ledger.deleted} ledger rows (${ledger.pairs} purged, ${ledger.skipped} skipped, cutoff ${ledger.cutoffPeriod})`
      );
    },
  },
];

/** Job additionnel : purge des objectifs de coopérative de la semaine passée. */
export function currentWeek(): string {
  return currentWeekStart(new Date());
}

export { log as jobsLogger };
