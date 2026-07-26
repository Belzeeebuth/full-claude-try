import { balance as getBalance, getConfig } from '../config';
import { getRedis, key as redisKey } from '../db/redis';
import { lockUserRow, withTransaction } from '../db/client';
import { projectEnergy, restoreEnergy } from '../game/energy';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as farmRepo from '../repositories/farm.repo';
import * as playerRepo from '../repositories/player.repo';
import * as inventoryService from './inventory.service';
import type { PlayerContext } from '../types';

const log = moduleLogger('consumables');

/**
 * Utilisation des objets consommables.
 *
 * Les boosts temporaires (XP, croissance, chance) sont stockés dans REDIS avec
 * un TTL, pas en base : ce sont des données volatiles, sans valeur d'audit, et
 * les lire à chaque calcul de rendement doit coûter une seule commande Redis.
 * Si Redis tombe, le joueur perd son boost en cours — c'est un désagrément
 * acceptable, contrairement à la perte d'un objet ou de pièces.
 */

export interface ActiveBoost {
  type: string;
  multiplier?: number;
  bonus?: number;
  expiresAt: number;
}

function boostKey(userId: string, type: string): string {
  return redisKey('boost', type, userId);
}

export async function activeBoosts(userId: string): Promise<ActiveBoost[]> {
  const types = ['xp_boost', 'growth_boost', 'luck', 'pest_repel'];
  const boosts: ActiveBoost[] = [];
  try {
    const redis = getRedis();
    for (const type of types) {
      const raw = await redis.get(boostKey(userId, type));
      if (raw) boosts.push(JSON.parse(raw) as ActiveBoost);
    }
  } catch (error) {
    log.debug({ err: error }, 'lecture des boosts impossible');
  }
  return boosts;
}

async function setBoost(userId: string, boost: ActiveBoost, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(boostKey(userId, boost.type), JSON.stringify(boost), 'EX', ttlSeconds);
  } catch (error) {
    log.warn({ err: error }, 'impossible de poser le boost');
  }
}

export interface UseResult {
  message: string;
  consumed: number;
}

export async function useConsumable(
  player: PlayerContext,
  itemKey: string,
  quantity = 1,
): Promise<UseResult> {
  const balance = getBalance();
  const item = inventoryService.requireItem(itemKey);
  const effect = item.effect;
  if (!effect?.type) {
    throw gameError('item_unknown', `${item.name} ne s'utilise pas directement.`);
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    await inventoryService.consume(player.id, itemKey, quantity, tx);

    switch (effect.type) {
      case 'energy': {
        const user = await playerRepo.findUserById(player.id, tx);
        if (!user) throw gameError('not_registered', 'Joueur introuvable.');
        const projection = projectEnergy(
          { energy: user.energy, energyMax: user.energyMax, energyUpdatedAt: user.energyUpdatedAt },
          new Date(),
          balance,
        );
        const restored = restoreEnergy(projection, (effect.amount ?? 0) * quantity, new Date());
        await playerRepo.setEnergy(player.id, restored, tx);
        return {
          consumed: quantity,
          message: `⚡ Énergie restaurée : **${restored.energy}/${projection.max}**.`,
        };
      }

      case 'water_all': {
        // L'arrosoir magique arrose tout, sans coût d'énergie.
        const rows = await farmRepo.listPlots(player.farmId, tx);
        const cropIds = rows
          .filter((entry) => entry.crop && !entry.crop.withered)
          .map((entry) => entry.crop!.id);
        const watered = await farmRepo.waterCrops(cropIds, new Date(), tx);
        return {
          consumed: quantity,
          message: `💧 **${watered}** parcelle(s) arrosée(s) instantanément, sans dépenser d'énergie.`,
        };
      }

      case 'xp_boost':
      case 'growth_boost':
      case 'luck': {
        const duration = (effect.durationSeconds ?? 3_600) * quantity;
        await setBoost(
          player.id,
          {
            type: effect.type,
            multiplier: effect.multiplier,
            bonus: effect.bonus,
            expiresAt: Date.now() + duration * 1_000,
          },
          duration,
        );
        const label =
          effect.type === 'xp_boost'
            ? `+${Math.round(((effect.multiplier ?? 1) - 1) * 100)} % d'XP`
            : effect.type === 'growth_boost'
              ? `×${effect.multiplier ?? 1} de vitesse de pousse`
              : `+${Math.round((effect.bonus ?? 0) * 100)} % de chance`;
        return {
          consumed: quantity,
          message: `✨ Bonus actif : **${label}** pendant ${Math.round(duration / 60)} minutes.`,
        };
      }

      case 'pest_repel': {
        const duration = (effect.durationSeconds ?? 43_200) * quantity;
        await setBoost(
          player.id,
          { type: 'pest_repel', expiresAt: Date.now() + duration * 1_000 },
          duration,
        );
        return {
          consumed: quantity,
          message: `🪤 Aucun nuisible sur votre ferme pendant ${Math.round(duration / 3_600)} h.`,
        };
      }

      case 'pest_cure': {
        const rows = await farmRepo.listPlots(player.farmId, tx);
        const infested = rows.filter((entry) => entry.plot.pestType).slice(0, quantity);
        if (infested.length === 0) {
          throw gameError('no_pest', 'Aucune parcelle infestée. Gardez votre traitement.');
        }
        await farmRepo.updatePlots(
          infested.map((entry) => entry.plot.id),
          { pestType: null, pestAppearedAt: null, pestDeadlineAt: null },
          tx,
        );
        return {
          consumed: quantity,
          message: `🧯 **${infested.length}** parcelle(s) assainie(s).`,
        };
      }

      case 'streak_freeze': {
        const streak = await playerRepo.getDailyStreak(player.id, tx);
        if (!streak) throw gameError('not_registered', 'Série introuvable.');
        await tx
          .update((await import('../db/schema')).dailyStreaks)
          .set({ freezeTokens: Math.min(5, streak.freezeTokens + quantity) })
          .where(
            (await import('drizzle-orm')).eq(
              (await import('../db/schema')).dailyStreaks.userId,
              player.id,
            ),
          );
        return {
          consumed: quantity,
          message: `🧊 **${quantity}** jeton(s) de gel ajouté(s) : votre série survivra à ${quantity} journée(s) manquée(s).`,
        };
      }

      case 'theme':
      case 'banner': {
        const field = effect.type === 'theme' ? 'profileTheme' : 'profileTheme';
        await tx
          .update((await import('../db/schema')).users)
          .set({ [field]: effect.value ?? 'classic' })
          .where(
            (await import('drizzle-orm')).eq((await import('../db/schema')).users.id, player.id),
          );
        return {
          consumed: quantity,
          message: `🎨 Apparence appliquée : **${effect.value}**. Consultez \`/profile\` !`,
        };
      }

      case 'fertilizer':
        throw gameError(
          'invalid_state',
          `${item.emoji} ${item.name} s'applique avec \`/fertilize\`, pas avec \`/use\`.`,
          { suggestedCommand: 'farm' },
        );

      case 'quest_reroll':
        throw gameError(
          'invalid_state',
          'Ce jeton est consommé automatiquement par `/reroll-quest`.',
          { suggestedCommand: 'quests' },
        );

      default:
        throw gameError('item_unknown', `Effet inconnu pour ${item.name}.`);
    }
  });
}

/** Les nuisibles sont-ils repoussés chez ce joueur ? (lu par le job) */
export async function isPestRepelActive(userId: string): Promise<boolean> {
  const boosts = await activeBoosts(userId);
  return boosts.some((boost) => boost.type === 'pest_repel' && boost.expiresAt > Date.now());
}

export { getConfig };
