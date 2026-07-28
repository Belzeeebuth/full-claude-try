CREATE TYPE "public"."standing_order_status" AS ENUM('active', 'fulfilled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "standing_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"buyer_id" uuid NOT NULL,
	"item_key" varchar(48) NOT NULL,
	"quality" "quality",
	"mutation" "mutation",
	"max_unit_price" bigint NOT NULL,
	"total_quantity" integer NOT NULL,
	"remaining_quantity" integer NOT NULL,
	"status" "standing_order_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_orders_price_positive" CHECK ("standing_orders"."max_unit_price" > 0),
	CONSTRAINT "standing_orders_quantity_range" CHECK ("standing_orders"."total_quantity" > 0 AND "standing_orders"."remaining_quantity" >= 0 AND "standing_orders"."remaining_quantity" <= "standing_orders"."total_quantity")
);
--> statement-breakpoint
ALTER TABLE "standing_orders" ADD CONSTRAINT "standing_orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_orders" ADD CONSTRAINT "standing_orders_item_key_items_config_key_fk" FOREIGN KEY ("item_key") REFERENCES "public"."items_config"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "standing_orders_matching_idx" ON "standing_orders" USING btree ("status","item_key","max_unit_price");--> statement-breakpoint
CREATE INDEX "standing_orders_buyer_idx" ON "standing_orders" USING btree ("buyer_id","status");