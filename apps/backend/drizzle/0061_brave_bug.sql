ALTER TABLE "shelf_box_items" ADD COLUMN "raw" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_shelf_box_items_raw" ON "shelf_box_items" USING btree ("raw");