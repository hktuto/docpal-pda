ALTER TABLE "parts" RENAME COLUMN "created_date" TO "creation_date";--> statement-breakpoint
ALTER TABLE "supplier_profiles" RENAME COLUMN "created_date" TO "creation_date";--> statement-breakpoint
ALTER TABLE "suppliers" RENAME COLUMN "created_date" TO "creation_date";--> statement-breakpoint
ALTER TABLE "net_weight_formula" DROP CONSTRAINT "net_weight_formula_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" DROP CONSTRAINT "receiving_invoice_items_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "picking_items" DROP CONSTRAINT "picking_items_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "shipping_box_items" DROP CONSTRAINT "shipping_box_items_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" DROP CONSTRAINT "goods_verify_tasks_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "shelf_box_items" DROP CONSTRAINT "shelf_box_items_part_no_parts_part_no_fk";
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_part_no_parts_part_no_fk";
--> statement-breakpoint
-- The part_no/order_no unique constraints can only be dropped AFTER the
-- dependent FKs above (Postgres rejects dropping a unique constraint that
-- foreign keys still reference).
ALTER TABLE "parts" DROP CONSTRAINT "parts_part_no_unique";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_order_no_unique";--> statement-breakpoint
CREATE INDEX "idx_parts_part_no" ON "parts" USING btree ("part_no");--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_wcl_item_no_unique" UNIQUE("wcl_item_no");
