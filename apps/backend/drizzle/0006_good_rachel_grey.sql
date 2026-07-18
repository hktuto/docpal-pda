DROP INDEX "inventory_lots_unique_lot";--> statement-breakpoint
ALTER TABLE "shelves" ADD COLUMN "warehouse_code" text DEFAULT 'HK1' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD COLUMN "warehouse_code" text DEFAULT 'HK1' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "warehouse_code" text DEFAULT 'HK1' NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "warehouse_code" text DEFAULT 'HK1' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "warehouse_code" text DEFAULT 'HK1' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_unique_lot" ON "inventory_lots" USING btree ("part_id","date_code","coo","cow","shelf_code","box_id","sub_inventory_code","warehouse_code") WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;