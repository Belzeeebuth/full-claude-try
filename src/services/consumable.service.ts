import { balance as getBalance, getConfig } from '../config';
import { getRedis, key as redisKey } from '../db/redis';
import { lockUserRow, withTransaction } from '../db/client';
import { projectEnergy, restoreEnergy } from '../game/energy';
import { translate } from '../i18n';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import * as farmRepo from '../repositories/farm.repo';
import * as playerRepo from '../repositories/player.repo';
import * as inventoryService from './inventory.service';
import { invalidateFarmModifiers } from './modifier-cache';
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
  // Les modificateurs de ferme sont mis en cache : sans cette invalidation, le
  // joueur verrait « boost actif » et attendrait jusqu'à une minute son effet.
  await invalidateFarmModifiers(userId);
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
  const item = inventoryService.requireItem(itemKey, player.locale);
  const effect = item.effect;
  if (!effect?.type) {
    throw gameError('item_unknown', `${item.name} cannot be used directly.`, {
      i18nKey: 'errors.consumable.not_directly_usable',
      params: { item: item.name },
    });
  }

  return withTransaction(async (tx) => {
    await lockUserRow(tx, player.id);
    await inventoryService.consume(player.id, itemKey, quantity, tx, player.locale);

    switch (effect.type) {
      case 'energy': {
        const user = await playerRepo.findUserById(player.id, tx);
        if (!user) {
          throw gameError('not_registered', 'Player not found.', {
            i18nKey: 'errors.consumable.player_not_found',
          });
        }
        const projection = projectEnergy(
          { energy: user.energy, energyMax: user.energyMax, energyUpdatedAt: user.energyUpdatedAt },
          new Date(),
          balance,
        );
        const restored = restoreEnergy(projection, (effect.amount ?? 0) * quantity, new Date());
        await playerRepo.setEnergy(player.id, restored, tx);
        return {
          consumed: quantity,
          message: translate(player.locale, 'consumable.energy', {
            energy: restored.energy,
            max: projection.max,
          }),
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
          message: translate(player.locale, 'consumable.water_all', { count: watered }),
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
            ? translate(player.locale, 'consumable.label_xp', {
                pct: Math.round(((effect.multiplier ?? 1) - 1) * 100),
              })
            : effect.type === 'growth_boost'
              ? translate(player.locale, 'consumable.label_growth', {
                  multiplier: effect.multiplier ?? 1,
                })
              : translate(player.locale, 'consumable.label_luck', {
                  pct: Math.round((effect.bonus ?? 0) * 100),
                });
        return {
          consumed: quantity,
          message: translate(player.locale, 'consumable.boost_active', {
            label,
            minutes: Math.round(duration / 60),
          }),
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
          message: translate(player.locale, 'consumable.pest_repel', {
            hours: Math.round(duration / 3_600),
          }),
        };
      }

      case 'pest_cure': {
        const rows = await farmRepo.listPlots(player.farmId, tx);
        const infested = rows.filter((entry) => entry.plot.pestType).slice(0, quantity);
        if (infested.length === 0) {
          throw gameError('no_pest', 'No infested plot. Keep your treatment.', {
            i18nKey: 'errors.consumable.no_infested_plot',
          });
        }
        await farmRepo.updatePlots(
          infested.map((entry) => entry.plot.id),
          { pestType: null, pestAppearedAt: null, pestDeadlineAt: null },
          tx,
        );
        return {
          consumed: quantity,
          message: translate(player.locale, 'consumable.pest_cure', { count: infested.length }),
        };
      }

      case 'streak_freeze': {
        const streak = await playerRepo.getDailyStreak(player.id, tx);
        if (!streak) {
          throw gameError('not_registered', 'Streak not found.', {
            i18nKey: 'errors.consumable.streak_not_found',
          });
        }
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
          message: translate(player.locale, 'consumable.streak_freeze', { count: quantity }),
        };
      }

      case 'theme':
      case 'banner': {
        // Thèmes et bannières alimentent le MÊME rendu : `profileTheme` sert de
        // clé dans la table `BANNERS` du renderer de profil, qui couvre les deux
        // familles de valeurs. Les deux types d'objet écrivent donc la même
        // colonne — un ternaire dont les deux branches étaient identiques le
        // laissait croire à une distinction qui n'existe pas.
        await tx
          .update((await import('../db/schema')).users)
          .set({ profileTheme: effect.value ?? 'classic' })
          .where(
            (await import('drizzle-orm')).eq((await import('../db/schema')).users.id, player.id),
          );
        return {
          consumed: quantity,
          message: translate(player.locale, 'consumable.appearance', { value: effect.value ?? '' }),
        };
      }

      case 'fertilizer':
        throw gameError(
          'invalid_state',
          `${item.emoji} ${item.name} is applied with \`/fertilize\`, not with \`/use\`.`,
          {
            i18nKey: 'errors.consumable.use_fertilize_instead',
            params: { emoji: item.emoji, name: item.name },
            suggestedCommand: 'farm',
          },
        );

      case 'quest_reroll':
        throw gameError(
          'invalid_state',
          'This token is consumed automatically by `/reroll-quest`.',
          { i18nKey: 'errors.consumable.auto_consumed_token', suggestedCommand: 'quests' },
        );

      default:
        throw gameError('item_unknown', `Unknown effect for ${item.name}.`, {
          i18nKey: 'errors.consumable.unknown_effect',
          params: { item: item.name },
        });
    }
  });
}

/** Les nuisibles sont-ils repoussés chez ce joueur ? (lu par le job) */
export async function isPestRepelActive(userId: string): Promise<boolean> {
  const boosts = await activeBoosts(userId);
  return boosts.some((boost) => boost.type === 'pest_repel' && boost.expiresAt > Date.now());
}

export { getConfig };
