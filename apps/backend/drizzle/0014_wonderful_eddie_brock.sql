ALTER TABLE "country_list" ADD COLUMN "short_code" text;
--> statement-breakpoint
-- Backfill: default short code = first letter of the ISO code (CN→C, JP→J).
UPDATE "country_list" SET "short_code" = upper(substr("code", 1, 1)) WHERE "short_code" IS NULL;
