CREATE TABLE "owned_pets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"pet_key" varchar(48) NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "equipped_pet_key" varchar(48);--> statement-breakpoint
ALTER TABLE "owned_pets" ADD CONSTRAINT "owned_pets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owned_pets_user_pet_uq" ON "owned_pets" USING btree ("user_id","pet_key");