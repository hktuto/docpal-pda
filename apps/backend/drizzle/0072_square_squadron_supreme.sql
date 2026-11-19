ALTER TABLE "picking_packages" ALTER COLUMN "picking_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD COLUMN "picking_part_no" text;--> statement-breakpoint
UPDATE "picking_packages" SET "picking_part_no" = (SELECT pi.part_no FROM "picking_items" pi WHERE pi.id = "picking_packages"."picking_item_id") WHERE "picking_item_id" IS NOT NULL;--> statement-breakpoint
UPDATE "picking_packages" SET "picking_part_no" = '' WHERE "picking_part_no" IS NULL;--> statement-breakpoint
ALTER TABLE "picking_packages" ALTER COLUMN "picking_part_no" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_picking_packages_order_part" ON "picking_packages" USING btree ("picking_order_id","picking_part_no");
