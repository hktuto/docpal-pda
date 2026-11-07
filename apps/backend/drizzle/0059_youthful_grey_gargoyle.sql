CREATE TABLE "cancel_records" (
	"id" text PRIMARY KEY NOT NULL,
	"source" varchar(24) NOT NULL,
	"source_id" text NOT NULL,
	"pi_invoice_num" text,
	"tn_number" text,
	"tn_line_id" bigint,
	"org_id" integer,
	"picking_order_id" text,
	"picking_item_id" text,
	"outcome" text NOT NULL,
	"message" text,
	"source_ts" timestamp NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "put_back_task_items" (
	"id" text PRIMARY KEY NOT NULL,
	"put_back_task_id" text NOT NULL,
	"picking_package_id" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"qty" integer NOT NULL,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"shelf_code" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"done_shelf_code" text,
	"done_at" timestamp,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_put_back_task_items_qty" CHECK (qty > 0)
);
--> statement-breakpoint
CREATE TABLE "put_back_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"cancel_source" varchar(24) NOT NULL,
	"cancel_source_id" text NOT NULL,
	"picking_order_id" text NOT NULL,
	"picking_item_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assignee" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cancel_records" ADD CONSTRAINT "cancel_records_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancel_records" ADD CONSTRAINT "cancel_records_picking_item_id_picking_items_id_fk" FOREIGN KEY ("picking_item_id") REFERENCES "public"."picking_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "put_back_task_items" ADD CONSTRAINT "put_back_task_items_put_back_task_id_put_back_tasks_id_fk" FOREIGN KEY ("put_back_task_id") REFERENCES "public"."put_back_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "put_back_task_items" ADD CONSTRAINT "put_back_task_items_picking_package_id_picking_packages_id_fk" FOREIGN KEY ("picking_package_id") REFERENCES "public"."picking_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "put_back_tasks" ADD CONSTRAINT "put_back_tasks_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cancel_records_source" ON "cancel_records" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "idx_cancel_records_outcome" ON "cancel_records" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "idx_put_back_task_items_task" ON "put_back_task_items" USING btree ("put_back_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_put_back_task_items_package" ON "put_back_task_items" USING btree ("picking_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_put_back_tasks_cancel" ON "put_back_tasks" USING btree ("cancel_source","cancel_source_id","picking_order_id","picking_item_id");--> statement-breakpoint
CREATE INDEX "idx_put_back_tasks_status" ON "put_back_tasks" USING btree ("status");