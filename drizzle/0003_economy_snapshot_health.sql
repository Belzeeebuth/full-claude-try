ALTER TABLE "economy_snapshots" ADD COLUMN "ledger_mismatches" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "economy_snapshots" ADD COLUMN "suspicious_users" integer DEFAULT 0 NOT NULL;
