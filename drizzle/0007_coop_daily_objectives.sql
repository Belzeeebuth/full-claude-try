CREATE TYPE "public"."coop_objective_period" AS ENUM('weekly', 'daily');--> statement-breakpoint
DROP INDEX "guild_objectives_uq";--> statement-breakpoint
ALTER TABLE "guild_objectives" ADD COLUMN "period" "coop_objective_period" DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_objectives_uq" ON "guild_objectives" USING btree ("guild_id","objective_key","week_start","period");