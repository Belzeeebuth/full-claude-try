CREATE TYPE "public"."auction_status" AS ENUM('active', 'sold', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."building_category" AS ENUM('livestock', 'production', 'storage', 'utility');--> statement-breakpoint
CREATE TYPE "public"."coop_objective_status" AS ENUM('active', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."coop_role" AS ENUM('owner', 'officer', 'member');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('coins', 'gems');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('seasonal', 'weekend', 'community', 'disaster', 'anniversary');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('seed', 'harvest', 'animal_product', 'product', 'tool', 'consumable', 'material', 'cosmetic', 'event');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_period" AS ENUM('alltime', 'weekly', 'season');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_scope" AS ENUM('global', 'discord', 'coop');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_type" AS ENUM('wealth', 'level', 'harvests', 'animals', 'crafts', 'coop_score', 'weekly_xp', 'streak');--> statement-breakpoint
CREATE TYPE "public"."mutation" AS ENUM('none', 'giant', 'rainbow', 'ancient');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('dm', 'none');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('crop_ready', 'crop_withering', 'animal_hungry', 'animal_sick', 'animal_product', 'energy_full', 'craft_done', 'auction_sold', 'auction_outbid', 'auction_expired', 'trade_request', 'coop_objective', 'daily_reminder', 'event_start', 'admin_message');--> statement-breakpoint
CREATE TYPE "public"."pest_type" AS ENUM('crows', 'insects', 'fungus', 'mole');--> statement-breakpoint
CREATE TYPE "public"."plot_state" AS ENUM('locked', 'empty', 'planted', 'growing', 'ready', 'withered');--> statement-breakpoint
CREATE TYPE "public"."privacy_level" AS ENUM('public', 'coop_only', 'private');--> statement-breakpoint
CREATE TYPE "public"."quality" AS ENUM('normal', 'silver', 'gold', 'iridium');--> statement-breakpoint
CREATE TYPE "public"."quest_objective" AS ENUM('harvest_crop', 'harvest_any', 'harvest_category', 'plant_seed', 'water_plot', 'fertilize_plot', 'treat_pest', 'collect_animal', 'feed_animal', 'pet_animal', 'craft_item', 'sell_item', 'sell_value', 'earn_coins', 'spend_coins', 'buy_plot', 'reach_level', 'deliver_items', 'visit_farm', 'help_farmer', 'auction_sale', 'login_streak');--> statement-breakpoint
CREATE TYPE "public"."quest_status" AS ENUM('active', 'completed', 'claimed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."quest_type" AS ENUM('daily', 'weekly', 'story', 'contract');--> statement-breakpoint
CREATE TYPE "public"."rarity" AS ENUM('common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('pending', 'qualified', 'rewarded');--> statement-breakpoint
CREATE TYPE "public"."season" AS ENUM('spring', 'summer', 'autumn', 'winter');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('pending', 'confirmed', 'completed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('starting_bonus', 'harvest_sale', 'market_sale', 'shop_purchase', 'seed_purchase', 'animal_purchase', 'animal_sale', 'plot_purchase', 'building_purchase', 'building_upgrade', 'craft_cost', 'quest_reward', 'achievement_reward', 'daily_reward', 'vote_reward', 'referral_reward', 'season_pass_reward', 'event_reward', 'level_reward', 'prestige_reset', 'auction_listing_fee', 'auction_sale', 'auction_purchase', 'auction_refund', 'trade_in', 'trade_out', 'gift_in', 'gift_out', 'bank_deposit', 'bank_withdraw', 'bank_interest', 'coop_contribution', 'coop_payout', 'coop_upgrade', 'tax', 'repair_cost', 'vet_cost', 'feed_cost', 'reroll_cost', 'admin_grant', 'admin_remove');--> statement-breakpoint
CREATE TYPE "public"."treasury_operation" AS ENUM('deposit', 'withdraw', 'reward', 'upgrade', 'admin');--> statement-breakpoint
CREATE TYPE "public"."vote_site" AS ENUM('topgg', 'dbl', 'discords', 'other');--> statement-breakpoint
CREATE TYPE "public"."weather_type" AS ENUM('sunny', 'cloudy', 'rainy', 'storm', 'heatwave', 'frost', 'snow');--> statement-breakpoint
CREATE TABLE "achievements_config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(32) DEFAULT 'general' NOT NULL,
	"icon" varchar(32) DEFAULT '🏆' NOT NULL,
	"tier" smallint DEFAULT 1 NOT NULL,
	"condition_type" "quest_objective" NOT NULL,
	"condition_target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"condition_amount" bigint DEFAULT 1 NOT NULL,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_gems" bigint DEFAULT 0 NOT NULL,
	"reward_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_title" varchar(64),
	"reward_badge" varchar(64),
	"hidden" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievements_config_amount_positive" CHECK ("achievements_config"."condition_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "animals_config" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"rarity" "rarity" DEFAULT 'common' NOT NULL,
	"price" bigint NOT NULL,
	"price_gems" bigint DEFAULT 0 NOT NULL,
	"building_key" varchar(48) NOT NULL,
	"product_item_key" varchar(48) NOT NULL,
	"product_quantity" smallint DEFAULT 1 NOT NULL,
	"production_seconds" integer NOT NULL,
	"feed_item_key" varchar(48) NOT NULL,
	"feed_per_cycle" smallint DEFAULT 1 NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"lifespan_days" integer DEFAULT 0 NOT NULL,
	"breedable" boolean DEFAULT true NOT NULL,
	"breeding_cooldown_seconds" integer DEFAULT 86400 NOT NULL,
	"hunger_rate" numeric(5, 2) DEFAULT '4.00' NOT NULL,
	"happiness_rate" numeric(5, 2) DEFAULT '2.00' NOT NULL,
	"passive_bonus" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_only" boolean DEFAULT false NOT NULL,
	"sprite" varchar(64),
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "animals_config_price_non_negative" CHECK ("animals_config"."price" >= 0 AND "animals_config"."price_gems" >= 0),
	CONSTRAINT "animals_config_production_positive" CHECK ("animals_config"."production_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "buildings_config" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"category" "building_category" NOT NULL,
	"max_tier" smallint DEFAULT 1 NOT NULL,
	"tiers" jsonb NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"unlocks_recipes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"sprite" varchar(64),
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buildings_config_max_tier" CHECK ("buildings_config"."max_tier" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "crops_config" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"rarity" "rarity" DEFAULT 'common' NOT NULL,
	"seed_price" bigint NOT NULL,
	"growth_seconds" integer NOT NULL,
	"base_yield" integer NOT NULL,
	"sell_price" bigint NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"seasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"quality_multiplier" numeric(5, 2) DEFAULT '1.00' NOT NULL,
	"water_required" smallint DEFAULT 1 NOT NULL,
	"fertility_cost" smallint DEFAULT 3 NOT NULL,
	"xp_reward" integer DEFAULT 1 NOT NULL,
	"regrow_cycles" smallint DEFAULT 0 NOT NULL,
	"regrow_seconds" integer DEFAULT 0 NOT NULL,
	"mutation_chance" numeric(6, 5) DEFAULT '0.01000' NOT NULL,
	"sprite" varchar(64),
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crops_config_growth_positive" CHECK ("crops_config"."growth_seconds" > 0),
	CONSTRAINT "crops_config_yield_positive" CHECK ("crops_config"."base_yield" > 0),
	CONSTRAINT "crops_config_seed_price_non_negative" CHECK ("crops_config"."seed_price" >= 0),
	CONSTRAINT "crops_config_sell_price_non_negative" CHECK ("crops_config"."sell_price" >= 0),
	CONSTRAINT "crops_config_level_range" CHECK ("crops_config"."required_level" BETWEEN 1 AND 120),
	CONSTRAINT "crops_config_roi_sane" CHECK ("crops_config"."sell_price" * "crops_config"."base_yield" > "crops_config"."seed_price" AND "crops_config"."sell_price" * "crops_config"."base_yield" <= "crops_config"."seed_price" * 40 + 100)
);
--> statement-breakpoint
CREATE TABLE "events_config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text NOT NULL,
	"type" "event_type" DEFAULT 'seasonal' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"recurring_cron" varchar(64),
	"banner" varchar(96),
	"modifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reward_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shop_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency_item_key" varchar(48),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items_config" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"category" "item_category" NOT NULL,
	"rarity" "rarity" DEFAULT 'common' NOT NULL,
	"base_price" bigint DEFAULT 0 NOT NULL,
	"sell_price" bigint DEFAULT 0 NOT NULL,
	"price_gems" bigint DEFAULT 0 NOT NULL,
	"stackable" boolean DEFAULT true NOT NULL,
	"max_stack" integer DEFAULT 9999 NOT NULL,
	"tradable" boolean DEFAULT true NOT NULL,
	"sellable" boolean DEFAULT true NOT NULL,
	"market_tracked" boolean DEFAULT false NOT NULL,
	"effect" jsonb,
	"required_level" integer DEFAULT 1 NOT NULL,
	"source_key" varchar(48),
	"collection_key" varchar(48),
	"sprite" varchar(64),
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_config_prices_non_negative" CHECK ("items_config"."base_price" >= 0 AND "items_config"."sell_price" >= 0),
	CONSTRAINT "items_config_max_stack_positive" CHECK ("items_config"."max_stack" > 0)
);
--> statement-breakpoint
CREATE TABLE "quests_config" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"type" "quest_type" NOT NULL,
	"title" varchar(128) NOT NULL,
	"description" text NOT NULL,
	"objective_type" "quest_objective" NOT NULL,
	"objective_target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required_amount" integer DEFAULT 1 NOT NULL,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_gems" bigint DEFAULT 0 NOT NULL,
	"reward_xp" integer DEFAULT 0 NOT NULL,
	"reward_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_pass_xp" integer DEFAULT 0 NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"chain_key" varchar(48),
	"chain_step" integer,
	"weight" integer DEFAULT 10 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quests_config_amount_positive" CHECK ("quests_config"."required_amount" > 0),
	CONSTRAINT "quests_config_weight_positive" CHECK ("quests_config"."weight" > 0),
	CONSTRAINT "quests_config_rewards_non_negative" CHECK ("quests_config"."reward_coins" >= 0 AND "quests_config"."reward_gems" >= 0 AND "quests_config"."reward_xp" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipes_config" (
	"key" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"emoji" varchar(32) NOT NULL,
	"building_key" varchar(48) NOT NULL,
	"output_item_key" varchar(48) NOT NULL,
	"output_quantity" smallint DEFAULT 1 NOT NULL,
	"ingredients" jsonb NOT NULL,
	"duration_seconds" integer NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"xp_reward" integer DEFAULT 1 NOT NULL,
	"category" varchar(32) DEFAULT 'general' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_config_duration_positive" CHECK ("recipes_config"."duration_seconds" > 0),
	CONSTRAINT "recipes_config_output_positive" CHECK ("recipes_config"."output_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "season_pass" (
	"id" varchar(48) PRIMARY KEY NOT NULL,
	"season_key" varchar(48) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"max_tier" integer DEFAULT 30 NOT NULL,
	"xp_per_tier" integer DEFAULT 500 NOT NULL,
	"tiers" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "season_pass_window_valid" CHECK ("season_pass"."ends_at" > "season_pass"."starts_at"),
	CONSTRAINT "season_pass_tier_positive" CHECK ("season_pass"."max_tier" > 0 AND "season_pass"."xp_per_tier" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"interest_rate" numeric(6, 4) DEFAULT '0.0050' NOT NULL,
	"interest_cap" bigint DEFAULT 5000 NOT NULL,
	"last_interest_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier" smallint DEFAULT 1 NOT NULL,
	"capacity" bigint DEFAULT 50000 NOT NULL,
	"total_deposited" bigint DEFAULT 0 NOT NULL,
	"total_withdrawn" bigint DEFAULT 0 NOT NULL,
	"total_interest" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_balance_non_negative" CHECK ("bank_accounts"."balance" >= 0),
	CONSTRAINT "bank_accounts_within_capacity" CHECK ("bank_accounts"."balance" <= "bank_accounts"."capacity"),
	CONSTRAINT "bank_accounts_tier_range" CHECK ("bank_accounts"."tier" BETWEEN 1 AND 6)
);
--> statement-breakpoint
CREATE TABLE "cooldowns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"uses" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_streaks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"last_claim_date" date,
	"total_claims" integer DEFAULT 0 NOT NULL,
	"freeze_tokens" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_streaks_non_negative" CHECK ("daily_streaks"."current_streak" >= 0 AND "daily_streaks"."longest_streak" >= "daily_streaks"."current_streak")
);
--> statement-breakpoint
CREATE TABLE "farms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(48) DEFAULT 'Ma ferme' NOT NULL,
	"grid_width" smallint DEFAULT 3 NOT NULL,
	"grid_height" smallint DEFAULT 3 NOT NULL,
	"fertility_bonus" smallint DEFAULT 0 NOT NULL,
	"auto_water" boolean DEFAULT false NOT NULL,
	"auto_water_until" timestamp with time zone,
	"warehouse_capacity" integer DEFAULT 300 NOT NULL,
	"crafting_slots" smallint DEFAULT 1 NOT NULL,
	"greenhouse" boolean DEFAULT false NOT NULL,
	"theme" varchar(32) DEFAULT 'classic' NOT NULL,
	"banner_color" varchar(7) DEFAULT '#7ec850' NOT NULL,
	"visits_count" integer DEFAULT 0 NOT NULL,
	"helps_received" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "farms_grid_range" CHECK ("farms"."grid_width" BETWEEN 1 AND 8 AND "farms"."grid_height" BETWEEN 1 AND 8),
	CONSTRAINT "farms_capacity_positive" CHECK ("farms"."warehouse_capacity" > 0),
	CONSTRAINT "farms_slots_range" CHECK ("farms"."crafting_slots" BETWEEN 1 AND 12),
	CONSTRAINT "farms_fertility_bonus_range" CHECK ("farms"."fertility_bonus" BETWEEN 0 AND 50)
);
--> statement-breakpoint
CREATE TABLE "plots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"farm_id" uuid NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"slot" smallint NOT NULL,
	"state" "plot_state" DEFAULT 'locked' NOT NULL,
	"fertility" smallint DEFAULT 70 NOT NULL,
	"weed_level" smallint DEFAULT 0 NOT NULL,
	"pest_type" "pest_type",
	"pest_appeared_at" timestamp with time zone,
	"pest_deadline_at" timestamp with time zone,
	"last_watered_at" timestamp with time zone,
	"last_harvest_at" timestamp with time zone,
	"fallow_until" timestamp with time zone,
	"unlocked_at" timestamp with time zone,
	"unlock_cost" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plots_fertility_range" CHECK ("plots"."fertility" BETWEEN 0 AND 100),
	CONSTRAINT "plots_weed_range" CHECK ("plots"."weed_level" BETWEEN 0 AND 100),
	CONSTRAINT "plots_coords_range" CHECK ("plots"."x" BETWEEN 0 AND 7 AND "plots"."y" BETWEEN 0 AND 7),
	CONSTRAINT "plots_slot_range" CHECK ("plots"."slot" BETWEEN 1 AND 64),
	CONSTRAINT "plots_pest_consistency" CHECK (("plots"."pest_type" IS NULL AND "plots"."pest_deadline_at" IS NULL) OR ("plots"."pest_type" IS NOT NULL AND "plots"."pest_deadline_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referred_id" uuid NOT NULL,
	"code" varchar(12) NOT NULL,
	"status" "referral_status" DEFAULT 'pending' NOT NULL,
	"qualify_level" integer DEFAULT 10 NOT NULL,
	"qualified_at" timestamp with time zone,
	"rewarded_at" timestamp with time zone,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_gems" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_no_self" CHECK ("referrals"."referrer_id" <> "referrals"."referred_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"dm_notifications" boolean DEFAULT false NOT NULL,
	"notify_crops" boolean DEFAULT true NOT NULL,
	"notify_animals" boolean DEFAULT true NOT NULL,
	"notify_energy" boolean DEFAULT false NOT NULL,
	"notify_market" boolean DEFAULT false NOT NULL,
	"notify_coop" boolean DEFAULT true NOT NULL,
	"daily_reminder" boolean DEFAULT false NOT NULL,
	"locale" varchar(5) DEFAULT 'fr' NOT NULL,
	"timezone" varchar(48) DEFAULT 'Europe/Paris' NOT NULL,
	"theme" varchar(32) DEFAULT 'classic' NOT NULL,
	"privacy" "privacy_level" DEFAULT 'public' NOT NULL,
	"compact_mode" boolean DEFAULT false NOT NULL,
	"confirm_destructive" boolean DEFAULT true NOT NULL,
	"allow_visits" boolean DEFAULT true NOT NULL,
	"allow_trades" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"discord_id" varchar(20) NOT NULL,
	"username" varchar(32) NOT NULL,
	"display_name" varchar(64),
	"avatar_hash" varchar(64),
	"coins" bigint DEFAULT 500 NOT NULL,
	"gems" bigint DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"total_xp" bigint DEFAULT 0 NOT NULL,
	"weekly_xp" bigint DEFAULT 0 NOT NULL,
	"prestige" integer DEFAULT 0 NOT NULL,
	"prestige_points" bigint DEFAULT 0 NOT NULL,
	"energy" integer DEFAULT 100 NOT NULL,
	"energy_max" integer DEFAULT 100 NOT NULL,
	"energy_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" varchar(64),
	"badges" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"profile_theme" varchar(32) DEFAULT 'classic' NOT NULL,
	"profile_color" varchar(7) DEFAULT '#4ca64c' NOT NULL,
	"total_harvests" bigint DEFAULT 0 NOT NULL,
	"total_planted" bigint DEFAULT 0 NOT NULL,
	"total_coins_earned" bigint DEFAULT 0 NOT NULL,
	"total_coins_spent" bigint DEFAULT 0 NOT NULL,
	"total_animals_raised" bigint DEFAULT 0 NOT NULL,
	"total_crafts" bigint DEFAULT 0 NOT NULL,
	"total_watered" bigint DEFAULT 0 NOT NULL,
	"total_help_given" bigint DEFAULT 0 NOT NULL,
	"best_harvest_value" bigint DEFAULT 0 NOT NULL,
	"commands_used" bigint DEFAULT 0 NOT NULL,
	"playtime_seconds" bigint DEFAULT 0 NOT NULL,
	"referral_code" varchar(12) NOT NULL,
	"referred_by" uuid,
	"eco_banned_until" timestamp with time zone,
	"eco_ban_reason" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"suspicion_score" integer DEFAULT 0 NOT NULL,
	"locale" varchar(5) DEFAULT 'fr' NOT NULL,
	"last_guild_id" varchar(20),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_coins_non_negative" CHECK ("users"."coins" >= 0),
	CONSTRAINT "users_gems_non_negative" CHECK ("users"."gems" >= 0),
	CONSTRAINT "users_xp_non_negative" CHECK ("users"."xp" >= 0 AND "users"."total_xp" >= 0),
	CONSTRAINT "users_level_range" CHECK ("users"."level" BETWEEN 1 AND 120),
	CONSTRAINT "users_energy_range" CHECK ("users"."energy" >= 0 AND "users"."energy" <= "users"."energy_max"),
	CONSTRAINT "users_prestige_range" CHECK ("users"."prestige" BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"site" "vote_site" DEFAULT 'topgg' NOT NULL,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_vote_at" timestamp with time zone NOT NULL,
	"streak" integer DEFAULT 1 NOT NULL,
	"is_weekend" boolean DEFAULT false NOT NULL,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_gems" bigint DEFAULT 0 NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	"claimed_at" timestamp with time zone,
	"external_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crafting_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"recipe_key" varchar(48) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"slot_index" smallint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finish_at" timestamp with time zone NOT NULL,
	"collected" boolean DEFAULT false NOT NULL,
	"collected_at" timestamp with time zone,
	"consumed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_quality" "quality" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crafting_queue_quantity_positive" CHECK ("crafting_queue"."quantity" > 0),
	CONSTRAINT "crafting_queue_finish_after_start" CHECK ("crafting_queue"."finish_at" >= "crafting_queue"."started_at")
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"quality" "quality" DEFAULT 'normal' NOT NULL,
	"mutation" "mutation" DEFAULT 'none' NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_quantity_non_negative" CHECK ("inventory"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owned_animals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"farm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"animal_key" varchar(48) NOT NULL,
	"building_id" uuid,
	"nickname" varchar(32),
	"hunger" smallint DEFAULT 100 NOT NULL,
	"happiness" smallint DEFAULT 80 NOT NULL,
	"health" smallint DEFAULT 100 NOT NULL,
	"stats_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"born_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fed_at" timestamp with time zone,
	"last_petted_at" timestamp with time zone,
	"last_collected_at" timestamp with time zone,
	"last_treated_at" timestamp with time zone,
	"last_bred_at" timestamp with time zone,
	"production_ready_at" timestamp with time zone,
	"pending_production" smallint DEFAULT 0 NOT NULL,
	"total_produced" integer DEFAULT 0 NOT NULL,
	"quality_multiplier" numeric(5, 3) DEFAULT '1.000' NOT NULL,
	"generation" smallint DEFAULT 1 NOT NULL,
	"parent_a_id" uuid,
	"parent_b_id" uuid,
	"is_sick" boolean DEFAULT false NOT NULL,
	"is_alive" boolean DEFAULT true NOT NULL,
	"died_at" timestamp with time zone,
	"death_reason" varchar(32),
	"purchase_price" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owned_animals_hunger_range" CHECK ("owned_animals"."hunger" BETWEEN 0 AND 100),
	CONSTRAINT "owned_animals_happiness_range" CHECK ("owned_animals"."happiness" BETWEEN 0 AND 100),
	CONSTRAINT "owned_animals_health_range" CHECK ("owned_animals"."health" BETWEEN 0 AND 100),
	CONSTRAINT "owned_animals_pending_range" CHECK ("owned_animals"."pending_production" BETWEEN 0 AND 200),
	CONSTRAINT "owned_animals_death_consistency" CHECK (("owned_animals"."is_alive" AND "owned_animals"."died_at" IS NULL) OR (NOT "owned_animals"."is_alive" AND "owned_animals"."died_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "owned_buildings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"farm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"building_key" varchar(48) NOT NULL,
	"tier" smallint DEFAULT 1 NOT NULL,
	"capacity" integer DEFAULT 0 NOT NULL,
	"slots" smallint DEFAULT 0 NOT NULL,
	"speed_multiplier" numeric(5, 3) DEFAULT '1.000' NOT NULL,
	"condition" smallint DEFAULT 100 NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upgraded_at" timestamp with time zone,
	"total_invested" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owned_buildings_tier_range" CHECK ("owned_buildings"."tier" BETWEEN 1 AND 10),
	CONSTRAINT "owned_buildings_condition_range" CHECK ("owned_buildings"."condition" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "planted_crops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"crop_key" varchar(48) NOT NULL,
	"planted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"growth_seconds" integer NOT NULL,
	"withers_at" timestamp with time zone,
	"water_needed" smallint DEFAULT 1 NOT NULL,
	"water_given" smallint DEFAULT 0 NOT NULL,
	"last_watered_at" timestamp with time zone,
	"next_water_at" timestamp with time zone,
	"missed_waterings" smallint DEFAULT 0 NOT NULL,
	"fertilizer_key" varchar(48),
	"fertilizer_boost" numeric(5, 3) DEFAULT '0.000' NOT NULL,
	"quality_boost" numeric(5, 3) DEFAULT '0.000' NOT NULL,
	"season_planted" "season",
	"weather_planted" "weather_type",
	"damage_penalty" numeric(5, 3) DEFAULT '0.000' NOT NULL,
	"mutation" "mutation" DEFAULT 'none' NOT NULL,
	"regrow_remaining" smallint DEFAULT 0 NOT NULL,
	"harvest_count" smallint DEFAULT 0 NOT NULL,
	"withered" boolean DEFAULT false NOT NULL,
	"helped_by" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planted_crops_ready_after_planted" CHECK ("planted_crops"."ready_at" >= "planted_crops"."planted_at"),
	CONSTRAINT "planted_crops_growth_positive" CHECK ("planted_crops"."growth_seconds" > 0),
	CONSTRAINT "planted_crops_water_range" CHECK ("planted_crops"."water_given" >= 0 AND "planted_crops"."water_needed" >= 0 AND "planted_crops"."water_given" <= "planted_crops"."water_needed" + 8),
	CONSTRAINT "planted_crops_damage_range" CHECK ("planted_crops"."damage_penalty" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "auction_bids" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"is_winning" boolean DEFAULT true NOT NULL,
	"refunded" boolean DEFAULT false NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_bids_amount_positive" CHECK ("auction_bids"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "auction_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"quality" "quality" DEFAULT 'normal' NOT NULL,
	"mutation" "mutation" DEFAULT 'none' NOT NULL,
	"quantity" integer NOT NULL,
	"start_price" bigint NOT NULL,
	"buyout_price" bigint,
	"current_bid" bigint,
	"current_bidder_id" uuid,
	"commission_rate" numeric(5, 4) DEFAULT '0.0500' NOT NULL,
	"listing_fee" bigint DEFAULT 0 NOT NULL,
	"status" "auction_status" DEFAULT 'active' NOT NULL,
	"buyer_id" uuid,
	"sold_price" bigint,
	"sold_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auction_quantity_positive" CHECK ("auction_listings"."quantity" > 0),
	CONSTRAINT "auction_prices_positive" CHECK ("auction_listings"."start_price" > 0 AND ("auction_listings"."buyout_price" IS NULL OR "auction_listings"."buyout_price" >= "auction_listings"."start_price")),
	CONSTRAINT "auction_bid_above_start" CHECK ("auction_listings"."current_bid" IS NULL OR "auction_listings"."current_bid" >= "auction_listings"."start_price"),
	CONSTRAINT "auction_no_self_purchase" CHECK ("auction_listings"."buyer_id" IS NULL OR "auction_listings"."buyer_id" <> "auction_listings"."seller_id")
);
--> statement-breakpoint
CREATE TABLE "economy_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_coins" bigint NOT NULL,
	"total_bank_coins" bigint NOT NULL,
	"total_gems" bigint NOT NULL,
	"coins_created" bigint DEFAULT 0 NOT NULL,
	"coins_destroyed" bigint DEFAULT 0 NOT NULL,
	"active_users_24h" integer DEFAULT 0 NOT NULL,
	"total_users" integer DEFAULT 0 NOT NULL,
	"top_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "market_price_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"price" bigint NOT NULL,
	"demand_index" numeric(7, 4) DEFAULT '1.0000' NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_history_price_positive" CHECK ("market_price_history"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "market_prices" (
	"item_key" varchar(48) PRIMARY KEY NOT NULL,
	"base_price" bigint NOT NULL,
	"current_price" bigint NOT NULL,
	"previous_price" bigint NOT NULL,
	"trend" numeric(7, 4) DEFAULT '0.0000' NOT NULL,
	"demand_index" numeric(7, 4) DEFAULT '1.0000' NOT NULL,
	"volume_window" bigint DEFAULT 0 NOT NULL,
	"reference_volume" bigint DEFAULT 100 NOT NULL,
	"volatility" numeric(5, 4) DEFAULT '0.0800' NOT NULL,
	"price_floor_pct" numeric(5, 4) DEFAULT '0.5500' NOT NULL,
	"price_ceil_pct" numeric(5, 4) DEFAULT '1.8000' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_update_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_prices_positive" CHECK ("market_prices"."current_price" > 0 AND "market_prices"."base_price" > 0),
	CONSTRAINT "market_prices_bounds" CHECK ("market_prices"."price_floor_pct" < "market_prices"."price_ceil_pct")
);
--> statement-breakpoint
CREATE TABLE "shop_stock" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"rotation_date" date NOT NULL,
	"category" varchar(32) DEFAULT 'daily' NOT NULL,
	"price" bigint NOT NULL,
	"currency" "currency" DEFAULT 'coins' NOT NULL,
	"discount_percent" smallint DEFAULT 0 NOT NULL,
	"stock_total" integer NOT NULL,
	"stock_remaining" integer NOT NULL,
	"per_user_limit" integer DEFAULT 0 NOT NULL,
	"required_level" integer DEFAULT 1 NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_stock_price_positive" CHECK ("shop_stock"."price" > 0),
	CONSTRAINT "shop_stock_remaining_range" CHECK ("shop_stock"."stock_remaining" >= 0 AND "shop_stock"."stock_remaining" <= "shop_stock"."stock_total"),
	CONSTRAINT "shop_stock_discount_range" CHECK ("shop_stock"."discount_percent" BETWEEN 0 AND 90)
);
--> statement-breakpoint
CREATE TABLE "trade_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trade_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"quality" "quality" DEFAULT 'normal' NOT NULL,
	"mutation" "mutation" DEFAULT 'none' NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_items_quantity_positive" CHECK ("trade_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiator_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"initiator_coins" bigint DEFAULT 0 NOT NULL,
	"partner_coins" bigint DEFAULT 0 NOT NULL,
	"initiator_confirmed" boolean DEFAULT false NOT NULL,
	"partner_confirmed" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"status" "trade_status" DEFAULT 'pending' NOT NULL,
	"channel_id" varchar(20),
	"message_id" varchar(20),
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_no_self" CHECK ("trades"."initiator_id" <> "trades"."partner_id"),
	CONSTRAINT "trades_coins_non_negative" CHECK ("trades"."initiator_coins" >= 0 AND "trades"."partner_coins" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"currency" "currency" DEFAULT 'coins' NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"item_key" varchar(48),
	"quantity" integer,
	"unit_price" bigint,
	"counterparty_id" uuid,
	"reference_type" varchar(32),
	"reference_id" varchar(64),
	"discord_guild_id" varchar(20),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_non_zero" CHECK ("transactions"."amount" <> 0),
	CONSTRAINT "transactions_balance_non_negative" CHECK ("transactions"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"board_type" "leaderboard_type" NOT NULL,
	"scope" "leaderboard_scope" DEFAULT 'global' NOT NULL,
	"scope_id" varchar(40) DEFAULT 'global' NOT NULL,
	"period" "leaderboard_period" DEFAULT 'alltime' NOT NULL,
	"period_key" varchar(24) NOT NULL,
	"user_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" bigint NOT NULL,
	"reward_claimed" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_rank_positive" CHECK ("leaderboard_snapshots"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_achievements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_key" varchar(64) NOT NULL,
	"progress" bigint DEFAULT 0 NOT NULL,
	"unlocked" boolean DEFAULT false NOT NULL,
	"unlocked_at" timestamp with time zone,
	"claimed" boolean DEFAULT false NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_achievements_progress_non_negative" CHECK ("user_achievements"."progress" >= 0),
	CONSTRAINT "user_achievements_claim_requires_unlock" CHECK (NOT "user_achievements"."claimed" OR "user_achievements"."unlocked")
);
--> statement-breakpoint
CREATE TABLE "user_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event_key" varchar(64) NOT NULL,
	"points" bigint DEFAULT 0 NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"claimed_tiers" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_events_points_non_negative" CHECK ("user_events"."points" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_quests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"quest_key" varchar(64) NOT NULL,
	"type" "quest_type" NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"required" integer NOT NULL,
	"status" "quest_status" DEFAULT 'active' NOT NULL,
	"cycle_key" varchar(16) NOT NULL,
	"slot_index" smallint DEFAULT 0 NOT NULL,
	"rerolled" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_quests_progress_non_negative" CHECK ("user_quests"."progress" >= 0),
	CONSTRAINT "user_quests_required_positive" CHECK ("user_quests"."required" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_season_pass" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"season_pass_id" varchar(48) NOT NULL,
	"pass_xp" bigint DEFAULT 0 NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"claimed_tiers" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"claimed_premium_tiers" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"premium" boolean DEFAULT false NOT NULL,
	"premium_granted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_season_pass_non_negative" CHECK ("user_season_pass"."pass_xp" >= 0 AND "user_season_pass"."tier" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "coop_role" DEFAULT 'member' NOT NULL,
	"contributed_coins" bigint DEFAULT 0 NOT NULL,
	"contributed_items" integer DEFAULT 0 NOT NULL,
	"weekly_contribution" bigint DEFAULT 0 NOT NULL,
	"weekly_score" bigint DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_contribution_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_members_contributions_non_negative" CHECK ("guild_members"."contributed_coins" >= 0 AND "guild_members"."contributed_items" >= 0 AND "guild_members"."weekly_contribution" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_objectives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"objective_key" varchar(64) NOT NULL,
	"title" varchar(128) NOT NULL,
	"description" text NOT NULL,
	"target" bigint NOT NULL,
	"progress" bigint DEFAULT 0 NOT NULL,
	"week_start" date NOT NULL,
	"status" "coop_objective_status" DEFAULT 'active' NOT NULL,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_gems" bigint DEFAULT 0 NOT NULL,
	"reward_coop_xp" integer DEFAULT 0 NOT NULL,
	"distributed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_objectives_target_positive" CHECK ("guild_objectives"."target" > 0),
	CONSTRAINT "guild_objectives_progress_non_negative" CHECK ("guild_objectives"."progress" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_treasury_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"user_id" uuid,
	"operation" "treasury_operation" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_treasury_log_amount_non_zero" CHECK ("guild_treasury_log"."amount" <> 0),
	CONSTRAINT "guild_treasury_log_balance_non_negative" CHECK ("guild_treasury_log"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(32) NOT NULL,
	"tag" varchar(5) NOT NULL,
	"description" text,
	"emblem" varchar(32) DEFAULT '🌾' NOT NULL,
	"owner_id" uuid NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"treasury" bigint DEFAULT 0 NOT NULL,
	"member_limit" integer DEFAULT 10 NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"join_requirement_level" integer DEFAULT 1 NOT NULL,
	"bonuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weekly_score" bigint DEFAULT 0 NOT NULL,
	"total_score" bigint DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "guilds_treasury_non_negative" CHECK ("guilds"."treasury" >= 0),
	CONSTRAINT "guilds_level_range" CHECK ("guilds"."level" BETWEEN 1 AND 30),
	CONSTRAINT "guilds_member_limit_range" CHECK ("guilds"."member_limit" BETWEEN 1 AND 50),
	CONSTRAINT "guilds_member_count_range" CHECK ("guilds"."member_count" >= 0 AND "guilds"."member_count" <= "guilds"."member_limit")
);
--> statement-breakpoint
CREATE TABLE "farm_visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"visitor_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"helped" boolean DEFAULT false NOT NULL,
	"plots_watered" smallint DEFAULT 0 NOT NULL,
	"reward_coins" bigint DEFAULT 0 NOT NULL,
	"reward_xp" integer DEFAULT 0 NOT NULL,
	"visit_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "farm_visits_no_self" CHECK ("farm_visits"."visitor_id" <> "farm_visits"."host_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_discord_id" varchar(20),
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(64),
	"target_discord_id" varchar(20),
	"discord_guild_id" varchar(20),
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"severity" varchar(16) DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"discord_guild_id" varchar(20) NOT NULL,
	"name" varchar(100),
	"locale" varchar(5) DEFAULT 'fr' NOT NULL,
	"announcement_channel_id" varchar(20),
	"market_channel_id" varchar(20),
	"event_channel_id" varchar(20),
	"allowed_channel_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"disabled_commands" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"admin_role_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"xp_multiplier" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"leaderboard_enabled" boolean DEFAULT true NOT NULL,
	"premium_until" timestamp with time zone,
	"member_count" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_settings_xp_multiplier_range" CHECK ("guild_settings"."xp_multiplier" BETWEEN 0.1 AND 2.0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"channel" "notification_channel" DEFAULT 'dm' NOT NULL,
	"title" varchar(128),
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deliver_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"dedupe_key" varchar(96),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_attempts_range" CHECK ("notifications"."attempts" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_key" varchar(96) NOT NULL,
	"kind" varchar(48) NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"cron" varchar(64),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"last_error" text,
	"locked_by" varchar(64),
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" varchar(32) NOT NULL,
	"season" "season" NOT NULL,
	"season_index" smallint NOT NULL,
	"game_year" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_window_valid" CHECK ("seasons"."ends_at" > "seasons"."starts_at"),
	CONSTRAINT "seasons_index_range" CHECK ("seasons"."season_index" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "weather" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"weather" "weather_type" NOT NULL,
	"season" "season" NOT NULL,
	"temperature" smallint DEFAULT 18 NOT NULL,
	"yield_modifier" numeric(5, 3) DEFAULT '1.000' NOT NULL,
	"growth_modifier" numeric(5, 3) DEFAULT '1.000' NOT NULL,
	"free_watering" boolean DEFAULT false NOT NULL,
	"damage_chance" numeric(5, 4) DEFAULT '0.0000' NOT NULL,
	"pest_chance" numeric(5, 4) DEFAULT '0.0500' NOT NULL,
	"description" text NOT NULL,
	"emoji" varchar(16) DEFAULT '☀️' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_modifiers_positive" CHECK ("weather"."yield_modifier" > 0 AND "weather"."growth_modifier" > 0)
);
--> statement-breakpoint
ALTER TABLE "recipes_config" ADD CONSTRAINT "recipes_config_building_key_buildings_config_key_fk" FOREIGN KEY ("building_key") REFERENCES "public"."buildings_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipes_config" ADD CONSTRAINT "recipes_config_output_item_key_items_config_key_fk" FOREIGN KEY ("output_item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cooldowns" ADD CONSTRAINT "cooldowns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_streaks" ADD CONSTRAINT "daily_streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farms" ADD CONSTRAINT "farms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_users_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crafting_queue" ADD CONSTRAINT "crafting_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crafting_queue" ADD CONSTRAINT "crafting_queue_building_id_owned_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."owned_buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crafting_queue" ADD CONSTRAINT "crafting_queue_recipe_key_recipes_config_key_fk" FOREIGN KEY ("recipe_key") REFERENCES "public"."recipes_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "owned_animals" ADD CONSTRAINT "owned_animals_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_animals" ADD CONSTRAINT "owned_animals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_animals" ADD CONSTRAINT "owned_animals_animal_key_animals_config_key_fk" FOREIGN KEY ("animal_key") REFERENCES "public"."animals_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "owned_animals" ADD CONSTRAINT "owned_animals_building_id_owned_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."owned_buildings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_buildings" ADD CONSTRAINT "owned_buildings_farm_id_farms_id_fk" FOREIGN KEY ("farm_id") REFERENCES "public"."farms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_buildings" ADD CONSTRAINT "owned_buildings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_buildings" ADD CONSTRAINT "owned_buildings_building_key_buildings_config_key_fk" FOREIGN KEY ("building_key") REFERENCES "public"."buildings_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "planted_crops" ADD CONSTRAINT "planted_crops_plot_id_plots_id_fk" FOREIGN KEY ("plot_id") REFERENCES "public"."plots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planted_crops" ADD CONSTRAINT "planted_crops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planted_crops" ADD CONSTRAINT "planted_crops_crop_key_crops_config_key_fk" FOREIGN KEY ("crop_key") REFERENCES "public"."crops_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_listing_id_auction_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."auction_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_bidder_id_users_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_current_bidder_id_users_id_fk" FOREIGN KEY ("current_bidder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_listings" ADD CONSTRAINT "auction_listings_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_price_history" ADD CONSTRAINT "market_price_history_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "shop_stock" ADD CONSTRAINT "shop_stock_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_items" ADD CONSTRAINT "trade_items_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_partner_id_users_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_key_achievements_config_key_fk" FOREIGN KEY ("achievement_key") REFERENCES "public"."achievements_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_event_key_events_config_key_fk" FOREIGN KEY ("event_key") REFERENCES "public"."events_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_quests" ADD CONSTRAINT "user_quests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_quests" ADD CONSTRAINT "user_quests_quest_key_quests_config_key_fk" FOREIGN KEY ("quest_key") REFERENCES "public"."quests_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_season_pass" ADD CONSTRAINT "user_season_pass_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_season_pass" ADD CONSTRAINT "user_season_pass_season_pass_id_season_pass_id_fk" FOREIGN KEY ("season_pass_id") REFERENCES "public"."season_pass"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_objectives" ADD CONSTRAINT "guild_objectives_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_treasury_log" ADD CONSTRAINT "guild_treasury_log_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_treasury_log" ADD CONSTRAINT "guild_treasury_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_visits" ADD CONSTRAINT "farm_visits_visitor_id_users_id_fk" FOREIGN KEY ("visitor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "farm_visits" ADD CONSTRAINT "farm_visits_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievements_config_category_idx" ON "achievements_config" USING btree ("category");--> statement-breakpoint
CREATE INDEX "achievements_config_condition_idx" ON "achievements_config" USING btree ("condition_type");--> statement-breakpoint
CREATE INDEX "animals_config_level_idx" ON "animals_config" USING btree ("required_level");--> statement-breakpoint
CREATE INDEX "animals_config_building_idx" ON "animals_config" USING btree ("building_key");--> statement-breakpoint
CREATE INDEX "buildings_config_category_idx" ON "buildings_config" USING btree ("category");--> statement-breakpoint
CREATE INDEX "crops_config_level_idx" ON "crops_config" USING btree ("required_level");--> statement-breakpoint
CREATE INDEX "crops_config_rarity_idx" ON "crops_config" USING btree ("rarity");--> statement-breakpoint
CREATE INDEX "crops_config_enabled_idx" ON "crops_config" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "events_config_window_idx" ON "events_config" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "events_config_enabled_idx" ON "events_config" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "items_config_category_idx" ON "items_config" USING btree ("category");--> statement-breakpoint
CREATE INDEX "items_config_rarity_idx" ON "items_config" USING btree ("rarity");--> statement-breakpoint
CREATE INDEX "items_config_market_idx" ON "items_config" USING btree ("market_tracked");--> statement-breakpoint
CREATE INDEX "items_config_collection_idx" ON "items_config" USING btree ("collection_key");--> statement-breakpoint
CREATE INDEX "quests_config_type_idx" ON "quests_config" USING btree ("type");--> statement-breakpoint
CREATE INDEX "quests_config_chain_idx" ON "quests_config" USING btree ("chain_key","chain_step");--> statement-breakpoint
CREATE INDEX "quests_config_level_idx" ON "quests_config" USING btree ("required_level");--> statement-breakpoint
CREATE INDEX "recipes_config_building_idx" ON "recipes_config" USING btree ("building_key");--> statement-breakpoint
CREATE INDEX "recipes_config_level_idx" ON "recipes_config" USING btree ("required_level");--> statement-breakpoint
CREATE INDEX "recipes_config_category_idx" ON "recipes_config" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "season_pass_season_key_uq" ON "season_pass" USING btree ("season_key");--> statement-breakpoint
CREATE INDEX "season_pass_active_idx" ON "season_pass" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_user_id_uq" ON "bank_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cooldowns_user_key_uq" ON "cooldowns" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "cooldowns_expires_idx" ON "cooldowns" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_streaks_user_id_uq" ON "daily_streaks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_streaks_current_idx" ON "daily_streaks" USING btree ("current_streak" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "farms_user_id_uq" ON "farms" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plots_farm_coords_uq" ON "plots" USING btree ("farm_id","x","y");--> statement-breakpoint
CREATE UNIQUE INDEX "plots_farm_slot_uq" ON "plots" USING btree ("farm_id","slot");--> statement-breakpoint
CREATE INDEX "plots_farm_state_idx" ON "plots" USING btree ("farm_id","state");--> statement-breakpoint
CREATE INDEX "plots_pest_deadline_idx" ON "plots" USING btree ("pest_deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_referred_uq" ON "referrals" USING btree ("referred_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_id");--> statement-breakpoint
CREATE INDEX "referrals_status_idx" ON "referrals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_user_id_uq" ON "settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_discord_id_uq" ON "users" USING btree ("discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_referral_code_uq" ON "users" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "users_coins_idx" ON "users" USING btree ("coins" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_level_idx" ON "users" USING btree ("level" DESC NULLS LAST,"total_xp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_weekly_xp_idx" ON "users" USING btree ("weekly_xp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_harvests_idx" ON "users" USING btree ("total_harvests" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_last_seen_idx" ON "users" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_last_guild_idx" ON "users" USING btree ("last_guild_id");--> statement-breakpoint
CREATE INDEX "users_referred_by_idx" ON "users" USING btree ("referred_by");--> statement-breakpoint
CREATE INDEX "votes_user_idx" ON "votes" USING btree ("user_id","voted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "votes_unclaimed_idx" ON "votes" USING btree ("user_id","claimed");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_external_id_uq" ON "votes" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crafting_queue_slot_uq" ON "crafting_queue" USING btree ("building_id","slot_index") WHERE collected = false;--> statement-breakpoint
CREATE INDEX "crafting_queue_user_idx" ON "crafting_queue" USING btree ("user_id","collected");--> statement-breakpoint
CREATE INDEX "crafting_queue_finish_idx" ON "crafting_queue" USING btree ("finish_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_stack_uq" ON "inventory" USING btree ("user_id","item_key","quality","mutation");--> statement-breakpoint
CREATE INDEX "inventory_user_idx" ON "inventory" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inventory_item_idx" ON "inventory" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "owned_animals_farm_alive_idx" ON "owned_animals" USING btree ("farm_id","is_alive");--> statement-breakpoint
CREATE INDEX "owned_animals_user_idx" ON "owned_animals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "owned_animals_production_idx" ON "owned_animals" USING btree ("production_ready_at");--> statement-breakpoint
CREATE INDEX "owned_animals_building_idx" ON "owned_animals" USING btree ("building_id");--> statement-breakpoint
CREATE INDEX "owned_animals_stats_updated_idx" ON "owned_animals" USING btree ("stats_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "owned_buildings_farm_key_uq" ON "owned_buildings" USING btree ("farm_id","building_key");--> statement-breakpoint
CREATE INDEX "owned_buildings_user_idx" ON "owned_buildings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planted_crops_plot_uq" ON "planted_crops" USING btree ("plot_id");--> statement-breakpoint
CREATE INDEX "planted_crops_user_ready_idx" ON "planted_crops" USING btree ("user_id","ready_at");--> statement-breakpoint
CREATE INDEX "planted_crops_ready_at_idx" ON "planted_crops" USING btree ("ready_at");--> statement-breakpoint
CREATE INDEX "planted_crops_withers_idx" ON "planted_crops" USING btree ("withers_at");--> statement-breakpoint
CREATE INDEX "planted_crops_next_water_idx" ON "planted_crops" USING btree ("next_water_at");--> statement-breakpoint
CREATE INDEX "planted_crops_crop_idx" ON "planted_crops" USING btree ("crop_key");--> statement-breakpoint
CREATE INDEX "auction_bids_listing_idx" ON "auction_bids" USING btree ("listing_id","amount" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auction_bids_bidder_idx" ON "auction_bids" USING btree ("bidder_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auction_bids_refund_idx" ON "auction_bids" USING btree ("refunded","is_winning");--> statement-breakpoint
CREATE INDEX "auction_active_item_idx" ON "auction_listings" USING btree ("status","item_key","expires_at");--> statement-breakpoint
CREATE INDEX "auction_seller_idx" ON "auction_listings" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "auction_expires_idx" ON "auction_listings" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "auction_bidder_idx" ON "auction_listings" USING btree ("current_bidder_id");--> statement-breakpoint
CREATE INDEX "economy_snapshots_time_idx" ON "economy_snapshots" USING btree ("captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_history_item_time_idx" ON "market_price_history" USING btree ("item_key","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_history_time_idx" ON "market_price_history" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "market_prices_trend_idx" ON "market_prices" USING btree ("trend" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_prices_next_update_idx" ON "market_prices" USING btree ("next_update_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_stock_item_rotation_uq" ON "shop_stock" USING btree ("item_key","rotation_date","category");--> statement-breakpoint
CREATE INDEX "shop_stock_rotation_idx" ON "shop_stock" USING btree ("rotation_date","category");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_items_uq" ON "trade_items" USING btree ("trade_id","user_id","item_key","quality","mutation");--> statement-breakpoint
CREATE INDEX "trade_items_trade_idx" ON "trade_items" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "trades_initiator_idx" ON "trades" USING btree ("initiator_id","status");--> statement-breakpoint
CREATE INDEX "trades_partner_idx" ON "trades" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "trades_status_expires_idx" ON "trades" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "transactions_user_created_idx" ON "transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_type_created_idx" ON "transactions" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_created_idx" ON "transactions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_item_idx" ON "transactions" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "transactions_reference_idx" ON "transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_snapshot_uq" ON "leaderboard_snapshots" USING btree ("board_type","scope","scope_id","period","period_key","user_id");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshot_lookup_idx" ON "leaderboard_snapshots" USING btree ("board_type","scope","scope_id","period_key","rank");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshot_user_idx" ON "leaderboard_snapshots" USING btree ("user_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "user_achievements_uq" ON "user_achievements" USING btree ("user_id","achievement_key");--> statement-breakpoint
CREATE INDEX "user_achievements_user_idx" ON "user_achievements" USING btree ("user_id","unlocked");--> statement-breakpoint
CREATE UNIQUE INDEX "user_events_uq" ON "user_events" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE INDEX "user_events_points_idx" ON "user_events" USING btree ("event_key","points" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "user_quests_cycle_uq" ON "user_quests" USING btree ("user_id","quest_key","cycle_key");--> statement-breakpoint
CREATE INDEX "user_quests_user_status_idx" ON "user_quests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "user_quests_type_cycle_idx" ON "user_quests" USING btree ("user_id","type","cycle_key");--> statement-breakpoint
CREATE INDEX "user_quests_expires_idx" ON "user_quests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_season_pass_uq" ON "user_season_pass" USING btree ("user_id","season_pass_id");--> statement-breakpoint
CREATE INDEX "user_season_pass_tier_idx" ON "user_season_pass" USING btree ("season_pass_id","tier" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "guild_members_user_uq" ON "guild_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "guild_members_guild_idx" ON "guild_members" USING btree ("guild_id","role");--> statement-breakpoint
CREATE INDEX "guild_members_weekly_idx" ON "guild_members" USING btree ("guild_id","weekly_contribution" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "guild_objectives_uq" ON "guild_objectives" USING btree ("guild_id","objective_key","week_start");--> statement-breakpoint
CREATE INDEX "guild_objectives_guild_status_idx" ON "guild_objectives" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "guild_objectives_week_idx" ON "guild_objectives" USING btree ("week_start","status");--> statement-breakpoint
CREATE INDEX "guild_treasury_log_guild_idx" ON "guild_treasury_log" USING btree ("guild_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guild_treasury_log_user_idx" ON "guild_treasury_log" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guilds_name_uq" ON "guilds" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "guilds_tag_uq" ON "guilds" USING btree (upper("tag"));--> statement-breakpoint
CREATE INDEX "guilds_weekly_score_idx" ON "guilds" USING btree ("weekly_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guilds_level_idx" ON "guilds" USING btree ("level" DESC NULLS LAST,"xp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guilds_public_idx" ON "guilds" USING btree ("is_public","member_count");--> statement-breakpoint
CREATE UNIQUE INDEX "farm_visits_daily_uq" ON "farm_visits" USING btree ("visitor_id","host_id","visit_date");--> statement-breakpoint
CREATE INDEX "farm_visits_host_idx" ON "farm_visits" USING btree ("host_id","visit_date");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_target_discord_idx" ON "audit_logs" USING btree ("target_discord_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_severity_idx" ON "audit_logs" USING btree ("severity","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "guild_settings_discord_id_uq" ON "guild_settings" USING btree ("discord_guild_id");--> statement-breakpoint
CREATE INDEX "guild_settings_left_idx" ON "guild_settings" USING btree ("left_at");--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("delivered","deliver_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_key_uq" ON "scheduled_tasks" USING btree ("task_key");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "scheduled_tasks_kind_idx" ON "scheduled_tasks" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_key_uq" ON "seasons" USING btree ("key");--> statement-breakpoint
CREATE INDEX "seasons_window_idx" ON "seasons" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "seasons_active_idx" ON "seasons" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "weather_day_uq" ON "weather" USING btree ("day");--> statement-breakpoint
CREATE INDEX "weather_season_idx" ON "weather" USING btree ("season");