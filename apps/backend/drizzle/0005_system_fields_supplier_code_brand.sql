-- System fields on every table (created_date / last_update_date),
-- receiving supplier references by code, parts.supplier_code → parts.brand,
-- additional_data jsonb on receiving_invoice_items / picking_items.
-- Hand-written (drizzle-kit generate --custom): renames preserve data.

-- 1. Column renames: created_at → created_date --------------------------------
ALTER TABLE "users" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "user_groups" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "user_group_members" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "supplier_profiles" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "shelves" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "customer_profiles" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "sub_inventories" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "sub_inventory_share_members" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "receiving_orders" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "receiving_invoices" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "picking_orders" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "picking_items" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "measuring_tasks" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "verify_tasks" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "shipping_boxes" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "picking_packages" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "shipping_box_items" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "shelf_boxes" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "allocations" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "transaction_logs" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "inventory_transactions" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint
ALTER TABLE "app_events" RENAME COLUMN "created_at" TO "created_date";--> statement-breakpoint

-- 2. Column renames: updated_at → last_update_date -----------------------------
ALTER TABLE "user_groups" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "supplier_profiles" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "shelves" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "customer_profiles" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "sub_inventories" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "sub_inventory_share_members" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "receiving_orders" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "receiving_invoices" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "picking_orders" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "picking_items" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "shipping_boxes" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "picking_packages" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "shipping_box_items" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint
ALTER TABLE "allocations" RENAME COLUMN "updated_at" TO "last_update_date";--> statement-breakpoint

-- 3. New created_date (NOT NULL DEFAULT now() backfills existing rows) ---------
ALTER TABLE "suppliers" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "country_list" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "box_size_list" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "inventory_lot_sources" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD COLUMN "created_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint

-- 4. New last_update_date -------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_group_members" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "country_list" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "box_size_list" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "inventory_lot_sources" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "measuring_tasks" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "transaction_logs" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "app_events" ADD COLUMN "last_update_date" timestamp NOT NULL DEFAULT now();--> statement-breakpoint

-- 5. parts.supplier_code → parts.brand (plain text, FK dropped) ----------------
ALTER TABLE "parts" DROP CONSTRAINT "parts_supplier_code_suppliers_code_fk";--> statement-breakpoint
ALTER TABLE "parts" RENAME COLUMN "supplier_code" TO "brand";--> statement-breakpoint

-- 6. receiving supplier references by code --------------------------------------
ALTER TABLE "receiving_orders" ADD COLUMN "supplier_code" text;--> statement-breakpoint
UPDATE "receiving_orders" ro SET "supplier_code" = (SELECT s."code" FROM "suppliers" s WHERE s."id" = ro."supplier_id");--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP CONSTRAINT "receiving_orders_supplier_id_suppliers_id_fk";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP COLUMN "supplier_id";--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "receiving_invoices" ADD COLUMN "supplier_code" text;--> statement-breakpoint
UPDATE "receiving_invoices" ri SET "supplier_code" = (SELECT s."code" FROM "suppliers" s WHERE s."id" = ri."supplier_id");--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP CONSTRAINT "receiving_invoices_supplier_id_suppliers_id_fk";--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP COLUMN "supplier_id";--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 7. additional_data jsonb on line items ----------------------------------------
ALTER TABLE "receiving_invoice_items" ADD COLUMN "additional_data" jsonb;--> statement-breakpoint
ALTER TABLE "picking_items" ADD COLUMN "additional_data" jsonb;--> statement-breakpoint

-- 8. index rename (column rename kept it valid; align the name with the schema)
ALTER INDEX "idx_transaction_logs_created_at" RENAME TO "idx_transaction_logs_created_date";
