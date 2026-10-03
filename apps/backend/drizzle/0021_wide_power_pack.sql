ALTER TABLE "picking_packages" ADD COLUMN "rescanned_qty" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill: already-verified packages count as fully rescanned.
UPDATE "picking_packages" SET "rescanned_qty" = "qty" WHERE "verified" OR "verify_verified";
