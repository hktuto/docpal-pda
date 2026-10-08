CREATE TABLE "internal_transfer_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"transfer_item_id" text NOT NULL,
	"inventory_lot_id" text,
	"receiving_invoice_item_id" text,
	"receiving_order_id" text,
	"qty" integer NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_internal_transfer_allocations_source" CHECK (inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "internal_transfer_items" (
	"id" text PRIMARY KEY NOT NULL,
	"transfer_order_id" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"qty" integer NOT NULL,
	"picked_qty" integer DEFAULT 0 NOT NULL,
	"allocated_qty" integer DEFAULT 0 NOT NULL,
	"line_id" bigint,
	"line_number" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"additional_data" jsonb,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_transfer_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"from_org_id" integer,
	"from_sub_inventory_code" text,
	"to_org_id" integer,
	"to_sub_inventory_code" text,
	"picking_order_id" text,
	"priority_seq" integer DEFAULT 0 NOT NULL,
	"working_by" text,
	"working_at" timestamp,
	"issue_reason" text,
	"issue_qty" integer,
	"issue_note" text,
	"issue_remark" text,
	"issue_reported_at" timestamp,
	"issue_reported_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"allocation_status" text DEFAULT 'unallocated' NOT NULL,
	"remark" text,
	"additional_data" jsonb,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_transfer_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"transfer_item_id" text NOT NULL,
	"transfer_order_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"qty" integer NOT NULL,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"shelf_code" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "put_away_tasks" ALTER COLUMN "receiving_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "put_away_tasks" ADD COLUMN IF NOT EXISTS "internal_transfer_order_id" text;--> statement-breakpoint
ALTER TABLE "internal_transfer_allocations" ADD CONSTRAINT "internal_transfer_allocations_transfer_item_id_internal_transfer_items_id_fk" FOREIGN KEY ("transfer_item_id") REFERENCES "public"."internal_transfer_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_allocations" ADD CONSTRAINT "internal_transfer_allocations_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_allocations" ADD CONSTRAINT "internal_transfer_allocations_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_allocations" ADD CONSTRAINT "internal_transfer_allocations_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_items" ADD CONSTRAINT "internal_transfer_items_transfer_order_id_internal_transfer_orders_id_fk" FOREIGN KEY ("transfer_order_id") REFERENCES "public"."internal_transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD CONSTRAINT "internal_transfer_orders_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD CONSTRAINT "internal_transfer_orders_working_by_users_id_fk" FOREIGN KEY ("working_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD CONSTRAINT "internal_transfer_orders_issue_reported_by_users_id_fk" FOREIGN KEY ("issue_reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD CONSTRAINT "internal_transfer_orders_from_sub_inv_fk" FOREIGN KEY ("from_org_id","from_sub_inventory_code") REFERENCES "public"."org_info"("org_id","secondary_inventory_name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD CONSTRAINT "internal_transfer_orders_to_sub_inv_fk" FOREIGN KEY ("to_org_id","to_sub_inventory_code") REFERENCES "public"."org_info"("org_id","secondary_inventory_name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_packages" ADD CONSTRAINT "internal_transfer_packages_transfer_item_id_internal_transfer_items_id_fk" FOREIGN KEY ("transfer_item_id") REFERENCES "public"."internal_transfer_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_packages" ADD CONSTRAINT "internal_transfer_packages_transfer_order_id_internal_transfer_orders_id_fk" FOREIGN KEY ("transfer_order_id") REFERENCES "public"."internal_transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_packages" ADD CONSTRAINT "internal_transfer_packages_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_allocations_item" ON "internal_transfer_allocations" USING btree ("transfer_item_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_allocations_lot" ON "internal_transfer_allocations" USING btree ("inventory_lot_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_allocations_receiving_item" ON "internal_transfer_allocations" USING btree ("receiving_invoice_item_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_allocations_receiving_order" ON "internal_transfer_allocations" USING btree ("receiving_order_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_items_order" ON "internal_transfer_items" USING btree ("transfer_order_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_items_part" ON "internal_transfer_items" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_orders_status" ON "internal_transfer_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_orders_picking_order" ON "internal_transfer_orders" USING btree ("picking_order_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_packages_item" ON "internal_transfer_packages" USING btree ("transfer_item_id");--> statement-breakpoint
CREATE INDEX "idx_internal_transfer_packages_order" ON "internal_transfer_packages" USING btree ("transfer_order_id");--> statement-breakpoint
ALTER TABLE "put_away_tasks" ADD CONSTRAINT "put_away_tasks_internal_transfer_order_id_internal_transfer_orders_id_fk" FOREIGN KEY ("internal_transfer_order_id") REFERENCES "public"."internal_transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_put_away_tasks_transfer_order" ON "put_away_tasks" USING btree ("internal_transfer_order_id");--> statement-breakpoint
ALTER TABLE "put_away_tasks" ADD CONSTRAINT "chk_put_away_tasks_source" CHECK (num_nonnulls(receiving_order_id, internal_transfer_order_id) = 1);