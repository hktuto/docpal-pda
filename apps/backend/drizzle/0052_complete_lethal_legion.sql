-- gin_trgm_ops needs pg_trgm; hand-added (drizzle cannot emit CREATE EXTENSION).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_parts_part_no_trgm" ON "parts" USING gin (part_no gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_parts_wcl_item_no_trgm" ON "parts" USING gin (wcl_item_no gin_trgm_ops);