ALTER TABLE "shelves" DROP CONSTRAINT "shelves_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD COLUMN "org_id" integer;--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD CONSTRAINT "shelf_boxes_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: boxes inherit their shelf's pair (the pair moved from shelves to shelf_boxes).
UPDATE "shelf_boxes" sb SET org_id = s.org_id, sub_inventory_code = s.sub_inventory_code FROM "shelves" s WHERE sb.shelf_code = s.code;--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "sub_inventory_code";