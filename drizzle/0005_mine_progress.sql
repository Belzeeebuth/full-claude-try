CREATE TABLE "mine_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"current_depth" integer DEFAULT 1 NOT NULL,
	"deepest_reached" integer DEFAULT 1 NOT NULL,
	"total_ores_mined" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mine_progress_depth_valid" CHECK ("mine_progress"."current_depth" >= 1 AND "mine_progress"."deepest_reached" >= "mine_progress"."current_depth"),
	CONSTRAINT "mine_progress_ores_non_negative" CHECK ("mine_progress"."total_ores_mined" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mine_progress" ADD CONSTRAINT "mine_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mine_progress_user_id_uq" ON "mine_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mine_progress_depth_idx" ON "mine_progress" USING btree ("deepest_reached" DESC NULLS LAST);