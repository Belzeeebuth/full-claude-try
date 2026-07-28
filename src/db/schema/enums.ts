import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Tous les types énumérés PostgreSQL du jeu.
 *
 * On préfère `CREATE TYPE ... AS ENUM` à des colonnes texte + CHECK :
 *  - 4 octets stockés au lieu d'une chaîne variable,
 *  - validation par le moteur, donc impossible d'insérer une valeur inconnue
 *    même via un accès SQL direct (import, script de maintenance, admin),
 *  - les valeurs sont directement typées côté TypeScript par Drizzle.
 * Ajouter une valeur = `ALTER TYPE ... ADD VALUE` (non bloquant depuis PG 12).
 */

/** État persistant d'une parcelle. `growing`/`ready` sont dérivés à la lecture. */
export const plotStateEnum = pgEnum('plot_state', [
  'locked',
  'empty',
  'planted',
  'growing',
  'ready',
  'withered',
]);

export const pestTypeEnum = pgEnum('pest_type', ['crows', 'insects', 'fungus', 'mole']);

export const rarityEnum = pgEnum('rarity', [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
]);

export const seasonEnum = pgEnum('season', ['spring', 'summer', 'autumn', 'winter']);

export const weatherEnum = pgEnum('weather_type', [
  'sunny',
  'cloudy',
  'rainy',
  'storm',
  'heatwave',
  'frost',
  'snow',
]);

export const qualityEnum = pgEnum('quality', ['normal', 'silver', 'gold', 'iridium']);

export const mutationEnum = pgEnum('mutation', ['none', 'giant', 'rainbow', 'ancient']);

export const itemCategoryEnum = pgEnum('item_category', [
  'seed',
  'harvest',
  'animal_product',
  'product',
  'tool',
  'consumable',
  'material',
  'cosmetic',
  'event',
  'fish',
  'ore',
]);

export const buildingCategoryEnum = pgEnum('building_category', [
  'livestock',
  'production',
  'storage',
  'utility',
]);

export const currencyEnum = pgEnum('currency', ['coins', 'gems']);

/**
 * Type de mouvement économique. Sert de base au monitoring anti-inflation :
 * les `*_sink` retirent de la masse monétaire, les `*_source` en créent.
 */
export const transactionTypeEnum = pgEnum('transaction_type', [
  'starting_bonus',
  'harvest_sale',
  'market_sale',
  'shop_purchase',
  'seed_purchase',
  'animal_purchase',
  'animal_sale',
  'plot_purchase',
  'building_purchase',
  'building_upgrade',
  'craft_cost',
  'quest_reward',
  'achievement_reward',
  'daily_reward',
  'vote_reward',
  'referral_reward',
  'season_pass_reward',
  'event_reward',
  'level_reward',
  'prestige_reset',
  'auction_listing_fee',
  'auction_sale',
  'auction_purchase',
  'auction_refund',
  'trade_in',
  'trade_out',
  'gift_in',
  'gift_out',
  'bank_deposit',
  'bank_withdraw',
  'bank_interest',
  'coop_contribution',
  'coop_payout',
  'coop_upgrade',
  'tax',
  'repair_cost',
  'vet_cost',
  'feed_cost',
  'reroll_cost',
  'admin_grant',
  'admin_remove',
]);

export const auctionStatusEnum = pgEnum('auction_status', [
  'active',
  'sold',
  'expired',
  'cancelled',
]);

export const tradeStatusEnum = pgEnum('trade_status', [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'expired',
]);

export const questTypeEnum = pgEnum('quest_type', ['daily', 'weekly', 'story', 'contract']);

/** Types d'objectifs de quête ; chaque valeur est câblée dans QuestService. */
export const questObjectiveEnum = pgEnum('quest_objective', [
  'harvest_crop',
  'harvest_any',
  'harvest_category',
  'plant_seed',
  'water_plot',
  'fertilize_plot',
  'treat_pest',
  'collect_animal',
  'feed_animal',
  'pet_animal',
  'craft_item',
  'sell_item',
  'sell_value',
  'earn_coins',
  'spend_coins',
  'buy_plot',
  'reach_level',
  'deliver_items',
  'visit_farm',
  'help_farmer',
  'auction_sale',
  'login_streak',
]);

export const questStatusEnum = pgEnum('quest_status', [
  'active',
  'completed',
  'claimed',
  'expired',
  'failed',
]);

export const coopRoleEnum = pgEnum('coop_role', ['owner', 'officer', 'member']);

export const coopObjectiveStatusEnum = pgEnum('coop_objective_status', [
  'active',
  'completed',
  'expired',
]);

export const treasuryOpEnum = pgEnum('treasury_operation', [
  'deposit',
  'withdraw',
  'reward',
  'upgrade',
  'admin',
]);

export const leaderboardTypeEnum = pgEnum('leaderboard_type', [
  'wealth',
  'level',
  'harvests',
  'animals',
  'crafts',
  'coop_score',
  'weekly_xp',
  'streak',
]);

export const leaderboardScopeEnum = pgEnum('leaderboard_scope', ['global', 'discord', 'coop']);

export const leaderboardPeriodEnum = pgEnum('leaderboard_period', ['alltime', 'weekly', 'season']);

export const notificationTypeEnum = pgEnum('notification_type', [
  'crop_ready',
  'crop_withering',
  'animal_hungry',
  'animal_sick',
  'animal_product',
  'energy_full',
  'craft_done',
  'auction_sold',
  'auction_won',
  'auction_outbid',
  'auction_expired',
  'trade_request',
  'coop_objective',
  'daily_reminder',
  'event_start',
  'admin_message',
]);

export const notificationChannelEnum = pgEnum('notification_channel', ['dm', 'none']);

export const webhookEventStatusEnum = pgEnum('webhook_event_status', [
  'pending',
  'delivered',
  'failed',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

export const privacyEnum = pgEnum('privacy_level', ['public', 'coop_only', 'private']);

export const referralStatusEnum = pgEnum('referral_status', ['pending', 'qualified', 'rewarded']);

export const voteSiteEnum = pgEnum('vote_site', ['topgg', 'dbl', 'discords', 'other']);

export const eventTypeEnum = pgEnum('event_type', [
  'seasonal',
  'weekend',
  'community',
  'disaster',
  'anniversary',
]);
