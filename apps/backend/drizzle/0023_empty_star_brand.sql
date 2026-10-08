ALTER TABLE "picking_packages" ADD COLUMN IF NOT EXISTS "scanned_part_no" text;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD COLUMN IF NOT EXISTS "scanned_wcl_item_no" text;