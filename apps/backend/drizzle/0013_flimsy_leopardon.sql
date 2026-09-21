CREATE TABLE "receiving_invoice_items_review" (
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
	"org_id" integer DEFAULT 2 NOT NULL,
	"sub_inventory_code" text,
	"drawing_no" text,
	"reported_mismatch" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "receiving_invoices_review" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_id" text NOT NULL,
	"invoice_no" text NOT NULL,
	"supplier_code" text,
	"wcl_company_name" text,
	"total_qty" integer,
	"total_ctn" integer,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_orders_review" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_no" text NOT NULL,
	"supplier_code" text,
	"delivery_date" timestamp,
	"org_id" integer DEFAULT 2 NOT NULL,
	"date_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"arrived_at" timestamp,
	"arrived_by" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
