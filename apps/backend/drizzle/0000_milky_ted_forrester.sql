CREATE TABLE "box_size_list" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "country_list" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"rule" text,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "net_weight_formula" (
	"id" text PRIMARY KEY NOT NULL,
	"part_no" text NOT NULL,
	"qty" integer NOT NULL,
	"weight" real NOT NULL,
	CONSTRAINT "net_weight_formula_part_no_unique" UNIQUE("part_no")
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_code" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"description" text,
	"default_coo" text,
	CONSTRAINT "parts_part_no_unique" UNIQUE("part_no")
);
--> statement-breakpoint
CREATE TABLE "shelves" (
	"code" text PRIMARY KEY NOT NULL,
	"zone" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sub_inventories" (
	"org_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"customer_code" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "sub_inventories_org_id_code_pk" PRIMARY KEY("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "sub_inventory_tags" (
	"org_id" integer NOT NULL,
	"code" text NOT NULL,
	"tag" text NOT NULL,
	"name" text,
	"description" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "sub_inventory_tags_org_id_code_tag_pk" PRIMARY KEY("org_id","code","tag")
);
--> statement-breakpoint
CREATE TABLE "supplier_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_code" text NOT NULL,
	"name" text,
	"qr_template" text,
	"qr_template_config" jsonb,
	"qr_type" text,
	"qty_encoding" text,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "supplier_profiles_supplier_code_unique" UNIQUE("supplier_code")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_group_members" (
	"user_id" text NOT NULL,
	"group_code" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "user_group_members_user_id_group_code_pk" PRIMARY KEY("user_id","group_code")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "receiving_invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_invoice_id" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"po_no" text,
	"po_line" text,
	"line_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"picked_qty" integer DEFAULT 0 NOT NULL,
	"put_away_qty" integer DEFAULT 0 NOT NULL,
	"ctn_no" text,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"org_id" integer DEFAULT 2 NOT NULL,
	"sub_inventory_code" text,
	"reported_mismatch" boolean DEFAULT false NOT NULL,
	"mismatch_reason" text,
	"mismatch_qty" integer,
	"wrong_part_no" text,
	"mismatch_note" text
);
--> statement-breakpoint
CREATE TABLE "receiving_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"supplier_id" text,
	"wcl_company_name" text,
	"total_qty" integer,
	"total_ctn" integer,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"sub_inventory_code" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"supplier_id" text,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"sub_inventory_code" text NOT NULL,
	"date_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"arrived_at" timestamp,
	"arrived_by" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_scan_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_id" text NOT NULL,
	"receiving_invoice_item_id" text NOT NULL,
	"serial_no" text NOT NULL,
	"qty" integer NOT NULL,
	"scanned_by" text,
	"scanned_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measuring_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "picking_items" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text NOT NULL,
	"part_no" text NOT NULL,
	"qty" integer NOT NULL,
	"picked_qty" integer DEFAULT 0 NOT NULL,
	"allocated_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "picking_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"delivery_date" timestamp,
	"po_no" text,
	"ship_to" text,
	"customer_code" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"priority_seq" integer DEFAULT 0 NOT NULL,
	"working_by" text,
	"working_at" timestamp,
	"issue_reason" text,
	"issue_qty" integer,
	"issue_pack_size" integer,
	"issue_note" text,
	"issue_remark" text,
	"issue_reported_at" timestamp,
	"issue_reported_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "picking_orders_order_no_unique" UNIQUE("order_no")
);
--> statement-breakpoint
CREATE TABLE "picking_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_item_id" text NOT NULL,
	"picking_order_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"qty" integer NOT NULL,
	"shipping_box_id" text,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_box_items" (
	"id" text PRIMARY KEY NOT NULL,
	"shipping_box_id" text NOT NULL,
	"picking_item_id" text,
	"part_no" text NOT NULL,
	"qty" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_boxes" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text,
	"measuring_task_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"gross_weight" real,
	"net_weight" real,
	"destination_country" text,
	"box_size" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_verify_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_date" date NOT NULL,
	"inventory_lot_id" text NOT NULL,
	"shelf_code" text,
	"box_id" text,
	"part_no" text NOT NULL,
	"expected_qty" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_lot_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"inventory_lot_id" text NOT NULL,
	"receiving_invoice_item_id" text NOT NULL,
	"qty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"shelf_code" text,
	"box_id" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"total_qty" integer DEFAULT 0 NOT NULL,
	"allocated_qty" integer DEFAULT 0 NOT NULL,
	"available_qty" integer GENERATED ALWAYS AS (total_qty - allocated_qty) STORED
);
--> statement-breakpoint
CREATE TABLE "shelf_box_items" (
	"id" text PRIMARY KEY NOT NULL,
	"shelf_box_id" text NOT NULL,
	"receiving_invoice_item_id" text,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"qty" integer NOT NULL,
	"verified" boolean DEFAULT false,
	"verified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "shelf_boxes" (
	"id" text PRIMARY KEY NOT NULL,
	"shelf_code" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_item_id" text NOT NULL,
	"inventory_lot_id" text,
	"receiving_invoice_item_id" text,
	"receiving_order_id" text,
	"qty" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "chk_allocations_source" CHECK (inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"inventory_lot_id" text,
	"part_no" text NOT NULL,
	"shelf_code" text,
	"box_id" text,
	"txn_type" text NOT NULL,
	"qty_type" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"reference_type" text,
	"reference_id" text,
	"receiving_invoice_item_id" text,
	"actor_id" text,
	"txn_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"txn_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "chk_inventory_transactions_qty_type" CHECK (qty_type IN ('expected', 'dock', 'on_hand', 'reserved'))
);
--> statement-breakpoint
CREATE TABLE "transaction_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"topics" text[] NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD CONSTRAINT "net_weight_formula_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD CONSTRAINT "sub_inventories_customer_code_customer_profiles_code_fk" FOREIGN KEY ("customer_code") REFERENCES "public"."customer_profiles"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_inventory_tags" ADD CONSTRAINT "sub_inventory_tags_group_fk" FOREIGN KEY ("org_id","code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_code_user_groups_code_fk" FOREIGN KEY ("group_code") REFERENCES "public"."user_groups"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_receiving_invoice_id_receiving_invoices_id_fk" FOREIGN KEY ("receiving_invoice_id") REFERENCES "public"."receiving_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_arrived_by_users_id_fk" FOREIGN KEY ("arrived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measuring_tasks" ADD CONSTRAINT "measuring_tasks_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_items" ADD CONSTRAINT "picking_items_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_items" ADD CONSTRAINT "picking_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_customer_code_customer_profiles_code_fk" FOREIGN KEY ("customer_code") REFERENCES "public"."customer_profiles"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_working_by_users_id_fk" FOREIGN KEY ("working_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_issue_reported_by_users_id_fk" FOREIGN KEY ("issue_reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD CONSTRAINT "picking_packages_picking_item_id_picking_items_id_fk" FOREIGN KEY ("picking_item_id") REFERENCES "public"."picking_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD CONSTRAINT "picking_packages_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD CONSTRAINT "picking_packages_shipping_box_id_shipping_boxes_id_fk" FOREIGN KEY ("shipping_box_id") REFERENCES "public"."shipping_boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_box_items" ADD CONSTRAINT "shipping_box_items_shipping_box_id_shipping_boxes_id_fk" FOREIGN KEY ("shipping_box_id") REFERENCES "public"."shipping_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_box_items" ADD CONSTRAINT "shipping_box_items_picking_item_id_picking_items_id_fk" FOREIGN KEY ("picking_item_id") REFERENCES "public"."picking_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_box_items" ADD CONSTRAINT "shipping_box_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD CONSTRAINT "shipping_boxes_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD CONSTRAINT "shipping_boxes_measuring_task_id_measuring_tasks_id_fk" FOREIGN KEY ("measuring_task_id") REFERENCES "public"."measuring_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lot_sources" ADD CONSTRAINT "inventory_lot_sources_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lot_sources" ADD CONSTRAINT "inventory_lot_sources_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD CONSTRAINT "shelf_box_items_shelf_box_id_shelf_boxes_id_fk" FOREIGN KEY ("shelf_box_id") REFERENCES "public"."shelf_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD CONSTRAINT "shelf_box_items_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_box_items" ADD CONSTRAINT "shelf_box_items_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD CONSTRAINT "shelf_boxes_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD CONSTRAINT "shelf_boxes_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_picking_item_id_picking_items_id_fk" FOREIGN KEY ("picking_item_id") REFERENCES "public"."picking_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_part_no_parts_part_no_fk" FOREIGN KEY ("part_no") REFERENCES "public"."parts"("part_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_logs" ADD CONSTRAINT "transaction_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_receiving_invoice_items_invoice" ON "receiving_invoice_items" USING btree ("receiving_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_receiving_invoice_items_part" ON "receiving_invoice_items" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_receiving_orders_status" ON "receiving_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_scan_labels_order_serial" ON "receiving_scan_labels" USING btree ("receiving_order_id","serial_no");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_measuring_tasks_picking_order" ON "measuring_tasks" USING btree ("picking_order_id");--> statement-breakpoint
CREATE INDEX "idx_picking_items_order" ON "picking_items" USING btree ("picking_order_id");--> statement-breakpoint
CREATE INDEX "idx_picking_items_part" ON "picking_items" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_picking_orders_status" ON "picking_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_picking_packages_item" ON "picking_packages" USING btree ("picking_item_id");--> statement-breakpoint
CREATE INDEX "idx_picking_packages_order" ON "picking_packages" USING btree ("picking_order_id");--> statement-breakpoint
CREATE INDEX "idx_picking_packages_box" ON "picking_packages" USING btree ("shipping_box_id");--> statement-breakpoint
CREATE INDEX "idx_shipping_box_items_box" ON "shipping_box_items" USING btree ("shipping_box_id");--> statement-breakpoint
CREATE INDEX "idx_shipping_boxes_task" ON "shipping_boxes" USING btree ("measuring_task_id");--> statement-breakpoint
CREATE INDEX "idx_shipping_boxes_order" ON "shipping_boxes" USING btree ("picking_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_verify_tasks_lot_day_unique" ON "goods_verify_tasks" USING btree ("task_date","inventory_lot_id");--> statement-breakpoint
CREATE INDEX "idx_goods_verify_tasks_shelf" ON "goods_verify_tasks" USING btree ("shelf_code","task_date");--> statement-breakpoint
CREATE INDEX "idx_goods_verify_tasks_status" ON "goods_verify_tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lot_sources_unique" ON "inventory_lot_sources" USING btree ("inventory_lot_id","receiving_invoice_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_lot_sources_receiving_item" ON "inventory_lot_sources" USING btree ("receiving_invoice_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_lot_sources_lot" ON "inventory_lot_sources" USING btree ("inventory_lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_unique_lot" ON "inventory_lots" USING btree ("part_no","date_code","coo","cow","shelf_code","box_id","org_id","sub_inventory_code") WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_part" ON "inventory_lots" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_available" ON "inventory_lots" USING btree ("part_no","available_qty");--> statement-breakpoint
CREATE INDEX "idx_inventory_lots_location" ON "inventory_lots" USING btree ("shelf_code","box_id");--> statement-breakpoint
CREATE INDEX "idx_shelf_box_items_box" ON "shelf_box_items" USING btree ("shelf_box_id");--> statement-breakpoint
CREATE INDEX "idx_shelf_boxes_shelf" ON "shelf_boxes" USING btree ("shelf_code");--> statement-breakpoint
CREATE INDEX "idx_allocations_picking_item" ON "allocations" USING btree ("picking_item_id");--> statement-breakpoint
CREATE INDEX "idx_allocations_lot" ON "allocations" USING btree ("inventory_lot_id");--> statement-breakpoint
CREATE INDEX "idx_allocations_receiving_item" ON "allocations" USING btree ("receiving_invoice_item_id");--> statement-breakpoint
CREATE INDEX "idx_allocations_receiving_order" ON "allocations" USING btree ("receiving_order_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_shelf_time" ON "inventory_transactions" USING btree ("shelf_code","txn_at");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_lot_time" ON "inventory_transactions" USING btree ("inventory_lot_id","txn_at");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_part_time" ON "inventory_transactions" USING btree ("part_no","txn_at");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_txn_type" ON "inventory_transactions" USING btree ("txn_type");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_reference" ON "inventory_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_transactions_receiving_item" ON "inventory_transactions" USING btree ("receiving_invoice_item_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_logs_entity" ON "transaction_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_logs_created_at" ON "transaction_logs" USING btree ("created_at");