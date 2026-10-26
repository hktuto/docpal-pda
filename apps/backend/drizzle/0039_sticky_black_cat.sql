CREATE TABLE "allocation_snapshot_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"captured_at" timestamp NOT NULL,
	"restored_at" timestamp,
	"report" jsonb,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_snapshot_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"picking_item_id" text NOT NULL,
	"picking_order_id" text NOT NULL,
	"picking_order_no" text NOT NULL,
	"picking_part_no" text NOT NULL,
	"picking_line_id" bigint,
	"picking_line_number" integer,
	"source_type" text NOT NULL,
	"qty" integer NOT NULL,
	"manual" boolean NOT NULL,
	"inventory_lot_id" text,
	"source_part_no" text,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"shelf_code" text,
	"box_id" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"receiving_invoice_item_id" text,
	"receiving_order_id" text,
	"receiving_batch_no" text,
	"invoice_no" text,
	"po_no" text,
	"po_line" text,
	"ctn_no" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_snapshot_rows" ADD CONSTRAINT "allocation_snapshot_rows_batch_id_allocation_snapshot_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."allocation_snapshot_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_snapshot_batches_date_unique" ON "allocation_snapshot_batches" USING btree ("snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_snapshot_rows_batch_allocation_unique" ON "allocation_snapshot_rows" USING btree ("batch_id","allocation_id");--> statement-breakpoint
CREATE INDEX "idx_allocation_snapshot_rows_batch" ON "allocation_snapshot_rows" USING btree ("batch_id");