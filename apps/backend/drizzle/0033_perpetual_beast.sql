CREATE TABLE IF NOT EXISTS "put_away_tasks_cn" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_cn_id" text NOT NULL,
	"org_id" integer,
	"sub_inventory_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receiving_cn_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"invoice_no" text,
	"supplier" text,
	"filename" text,
	"docpal_document_id" text,
	"docpal_process_id" text,
	"docpal_business_key" text,
	"status" text DEFAULT 'workflow_running' NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text,
	"created_by" text NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receiving_invoice_items_cn" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_invoice_id" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"po_no" text,
	"po_line" text,
	"line_qty" integer,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"picked_qty" integer DEFAULT 0 NOT NULL,
	"put_away_qty" integer DEFAULT 0 NOT NULL,
	"ctn_no" text,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"drawing_no" text,
	"org_id" integer DEFAULT 2 NOT NULL,
	"sub_inventory_code" text,
	"reported_mismatch" integer DEFAULT 0 NOT NULL,
	"mismatch_reason" text,
	"mismatch_qty" integer,
	"wrong_part_no" text,
	"mismatch_note" text,
	"additional_data" jsonb,
	"order_data" jsonb,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receiving_invoices_cn" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"total_qty" integer,
	"total_ctn" integer,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receiving_orders_cn" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"date_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"arrived_at" timestamp,
	"arrived_by" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Idempotency: the shared dev DB pre-created the _cn tables from raw DDL, so every
-- statement below tolerates existing objects (IF NOT EXISTS / DO-block guard).
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'put_away_tasks_cn_receiving_order_cn_id_receiving_orders_cn_id_fk') THEN
		ALTER TABLE "put_away_tasks_cn" ADD CONSTRAINT "put_away_tasks_cn_receiving_order_cn_id_receiving_orders_cn_id_fk" FOREIGN KEY ("receiving_order_cn_id") REFERENCES "public"."receiving_orders_cn"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'put_away_tasks_cn_sub_inv_fk') THEN
		ALTER TABLE "put_away_tasks_cn" ADD CONSTRAINT "put_away_tasks_cn_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."org_info"("org_id","secondary_inventory_name") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_invoice_items_cn_receiving_invoice_id_receiving_invoices_cn_id_fk') THEN
		ALTER TABLE "receiving_invoice_items_cn" ADD CONSTRAINT "receiving_invoice_items_cn_receiving_invoice_id_receiving_invoices_cn_id_fk" FOREIGN KEY ("receiving_invoice_id") REFERENCES "public"."receiving_invoices_cn"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_invoice_items_cn_sub_inv_fk') THEN
		ALTER TABLE "receiving_invoice_items_cn" ADD CONSTRAINT "receiving_invoice_items_cn_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."org_info"("org_id","secondary_inventory_name") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_invoices_cn_receiving_order_id_receiving_orders_cn_id_fk') THEN
		ALTER TABLE "receiving_invoices_cn" ADD CONSTRAINT "receiving_invoices_cn_receiving_order_id_receiving_orders_cn_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders_cn"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receiving_orders_cn_arrived_by_users_id_fk') THEN
		ALTER TABLE "receiving_orders_cn" ADD CONSTRAINT "receiving_orders_cn_arrived_by_users_id_fk" FOREIGN KEY ("arrived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_put_away_tasks_cn_order" ON "put_away_tasks_cn" USING btree ("receiving_order_cn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_put_away_tasks_cn_status" ON "put_away_tasks_cn" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_cn_workflows_status" ON "receiving_cn_workflows" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_cn_workflows_process" ON "receiving_cn_workflows" USING btree ("docpal_process_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_invoice_items_cn_invoice" ON "receiving_invoice_items_cn" USING btree ("receiving_invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_invoice_items_cn_part" ON "receiving_invoice_items_cn" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_orders_cn_batch_no" ON "receiving_orders_cn" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_receiving_orders_cn_status" ON "receiving_orders_cn" USING btree ("status");