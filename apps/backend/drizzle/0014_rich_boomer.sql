-- 0014 schema redesign (org_id / natural keys / part_no references): existing
-- demo data cannot be carried across (part_id UUIDs vs part_no business keys),
-- so all data is wiped first; the app re-seeds on startup / pnpm db:seed.
TRUNCATE TABLE "app_events", "inventory_transactions", "transaction_logs", "goods_verify_tasks", "measuring_tasks", "picking_packages", "shipping_box_items", "shipping_boxes", "picking_items", "picking_orders", "allocations", "inventory_lot_sources", "inventory_lots", "shelf_box_items", "shelf_boxes", "receiving_scan_labels", "receiving_invoice_items", "receiving_invoices", "receiving_orders", "net_weight_formula", "shelves", "customer_profiles", "box_size_list", "country_list", "parts", "supplier_profiles", "suppliers", "users" CASCADE;--> statement-breakpoint
ALTER TABLE "net_weight_formula" DROP CONSTRAINT "net_weight_formula_part_id_unique";--> statement-breakpoint
ALTER TABLE "net_weight_formula" DROP CONSTRAINT "net_weight_formula_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "shelves" DROP CONSTRAINT "shelves_warehouse_section_code_warehouse_sections_code_fk";
--> statement-breakpoint
ALTER TABLE "shelves" DROP CONSTRAINT "shelves_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" DROP CONSTRAINT "receiving_invoice_items_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP CONSTRAINT "receiving_invoices_warehouse_section_code_warehouse_sections_code_fk";
--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP CONSTRAINT "receiving_invoices_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP CONSTRAINT "receiving_orders_warehouse_section_code_warehouse_sections_code_fk";
--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP CONSTRAINT "receiving_orders_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "picking_items" DROP CONSTRAINT "picking_items_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_warehouse_section_code_warehouse_sections_code_fk";
--> statement-breakpoint
ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "shipping_box_items" DROP CONSTRAINT "shipping_box_items_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" DROP CONSTRAINT "goods_verify_tasks_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_warehouse_section_code_warehouse_sections_code_fk";
--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_sub_inventory_code_sub_inventories_code_fk";
--> statement-breakpoint
ALTER TABLE "shelf_box_items" DROP CONSTRAINT "shelf_box_items_part_id_parts_id_fk";
--> statement-breakpoint
ALTER TABLE "shelf_boxes" DROP CONSTRAINT "shelf_boxes_receiving_order_id_receiving_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_part_id_parts_id_fk";
--> statement-breakpoint
DROP INDEX "idx_receiving_orders_external_id";--> statement-breakpoint
DROP INDEX "idx_picking_orders_external_id";--> statement-breakpoint
DROP INDEX "idx_shelf_boxes_order";--> statement-breakpoint
DROP INDEX "idx_receiving_invoice_items_part";--> statement-breakpoint
DROP INDEX "idx_picking_items_part";--> statement-breakpoint
DROP INDEX "inventory_lots_unique_lot";--> statement-breakpoint
DROP INDEX "idx_inventory_lots_part";--> statement-breakpoint
DROP INDEX "idx_inventory_lots_available";--> statement-breakpoint
DROP INDEX "idx_inventory_transactions_part_time";--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "rule" text;--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "supplier_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_profiles" ADD COLUMN "qr_type" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "line_qty" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "ctn_no" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "org_id" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "batch_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "org_id" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_items" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "order_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_box_items" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "wcl_item_no" text;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD COLUMN "wcl_item_no" text;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD CONSTRAINT "net_weight_formula_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_items" ADD CONSTRAINT "picking_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_box_items" ADD CONSTRAINT "shipping_box_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD CONSTRAINT "shelf_box_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_receiving_invoice_items_part" ON "receiving_invoice_items" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_picking_items_part" ON "picking_items" USING btree ("part_no");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_unique_lot" ON "inventory_lots" USING btree ("part_no","date_code","coo","cow","shelf_code","box_id") WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_part" ON "inventory_lots" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_available" ON "inventory_lots" USING btree ("part_no","available_qty");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_part_time" ON "inventory_transactions" USING btree ("part_no","txn_at");--> statement-breakpoint
ALTER TABLE "net_weight_formula" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "internal_code";--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "warehouse_code";--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "warehouse_section_code";--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "sub_inventory_code";--> statement-breakpoint
ALTER TABLE "shelves" DROP COLUMN "location_type";--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" DROP COLUMN "qty";--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" DROP COLUMN "box_id";--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP COLUMN "warehouse_code";--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP COLUMN "warehouse_section_code";--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP COLUMN "sub_inventory_code";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "ref_no";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "warehouse_code";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "warehouse_section_code";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "sub_inventory_code";--> statement-breakpoint
ALTER TABLE "picking_items" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "picking_items" DROP COLUMN "required_date_code";--> statement-breakpoint
ALTER TABLE "picking_items" DROP COLUMN "source_shelf_code";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "ref_no";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "supplier_id";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "required_date_code_notice";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "destination_country";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "warehouse_code";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "warehouse_section_code";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP COLUMN "sub_inventory_code";--> statement-breakpoint
ALTER TABLE "shipping_box_items" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "warehouse_code";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "warehouse_section_code";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "sub_inventory_code";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "supplier_invoice_no";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP COLUMN "expected_qty";--> statement-breakpoint
ALTER TABLE "shelf_box_items" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "shelf_boxes" DROP COLUMN "receiving_order_id";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "part_id";--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD CONSTRAINT "net_weight_formula_part_no_unique" UNIQUE("part_no");--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_order_no_unique" UNIQUE("order_no");--> statement-breakpoint
ALTER TABLE "sub_inventories" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "warehouse_sections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sub_inventories" CASCADE;--> statement-breakpoint
DROP TABLE "warehouse_sections" CASCADE;--> statement-breakpoint
