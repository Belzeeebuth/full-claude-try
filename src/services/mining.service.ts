import { balance as getBalance, getConfig } from '../config';
import { lockUserRow, withTransaction } from '../db/client';
import { eligibleOre, maxDepthForLevel, rollAdvance, rollOre, type OreConfig } from '../game/mining';
import { liveRng } from '../game/rng';
import { gameError } from '../utils/errors';
import * as inventoryService from './inventory.service';
import * as miningRepo from '../repositories/mining.repo';
import { consumeEnergy } from './player.service';
import { trackAction } from './tracker.service';
import type { PlayerContext } from '../types';

/** Construit le vivier de minerais à partir de la configuration chargée. */
function orePool(config: ReturnType<typeof getConfig>): OreConfig[] {
  return config.itemList
    .filter((item) => item.category === 'ore' && item.enabled)
    .map((item) => ({
      key: item.key,
      rarity: item.rarity,
      requiredLevel: item.requiredLevel,
      minDepth: item.minDepth ?? 1,
    }));
}

export interface DigResult {
  depth: number;
  maxDepth: number;
  advanced: boolean;
  ore?: { itemKey: string; name: string; emoji: string; quantity: number; value: number };
}

export async function dig(player: PlayerContext, now: Date = new Date()): Promise<DigResult> {
  const balance = getBalance();
  const config = getConfig(player.locale);
  const mining = balance.mining;

  if (player.level < mining.unlockLevel) {
    throw gameError('level_too_low', `Mining requires level ${mining.unlockLevel}.`, {
      i18nKey: 'errors.mining.level_too_low',
      params: { level: mining.unlockLevel },
      suggestedCommand: 'profile',
    });
  }

  const maxDepth = maxDepthForLevel(player.level, balance);

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    await consumeEnergy(player.id, 'mine', tx, { now });

    const progress = await miningRepo.getOrCreateMineProgress(player.id, tx);
    // Plancher défensif : si `balance.mining.maxDepth` a été réduit par une
    // modification d'équilibrage à chaud, un joueur déjà plus profond n'en
    // reste pas moins ramené dans les clous pour CETTE extraction, sans que sa
    // progression stockée soit jamais réécrite à la baisse.
    const currentDepth = Math.min(progress.currentDepth, maxDepth);

    const rng = liveRng(`mine:${player.id}`);
    const eligible = eligibleOre(orePool(config), { level: player.level, depth: currentDepth });
    const picked = rollOre(eligible, balance, rng);

    let ore: DigResult['ore'];
    if (picked) {
      const item = config.items.get(picked.key)!;
      await inventoryService.addItems(player.id, [{ itemKey: picked.key, quantity: 1 }], tx);
      await miningRepo.incrementOresMined(player.id, 1, tx);
      await trackAction(
        { userId: player.id, coopId: player.coopId, level: player.level },
        'mine_ore',
        1,
        { itemKey: picked.key, rarity: picked.rarity },
        tx,
      );
      ore = { itemKey: picked.key, name: item.name, emoji: item.emoji, quantity: 1, value: item.sellPrice };
    }

    const advanced = rollAdvance(currentDepth, maxDepth, balance, rng);
    const nextDepth = advanced ? currentDepth + 1 : currentDepth;
    if (nextDepth !== progress.currentDepth) {
      await miningRepo.advanceDepth(player.id, nextDepth, tx);
    }

    return { depth: nextDepth, maxDepth, advanced, ore };
  });
}

export interface MiningStatus {
  depth: number;
  maxDepth: number;
  deepestReached: number;
  totalOresMined: number;
}

export async function getStatus(player: PlayerContext): Promise<MiningStatus> {
  const balance = getBalance();
  const maxDepth = maxDepthForLevel(player.level, balance);
  const progress = await miningRepo.getOrCreateMineProgress(player.id);
  return {
    depth: Math.min(progress.currentDepth, maxDepth),
    maxDepth,
    deepestReached: progress.deepestReached,
    totalOresMined: progress.totalOresMined,
  };
}
