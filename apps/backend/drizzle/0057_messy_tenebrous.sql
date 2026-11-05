CREATE TABLE "receiving_cn_scan_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"qty" integer NOT NULL,
	"raw" text,
	"takes" jsonb NOT NULL,
	"scanned_by" text,
	"scanned_at" timestamp,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "flag_qty" integer;--> statement-breakpoint
ALTER TABLE "receiving_cn_scan_events" ADD CONSTRAINT "receiving_cn_scan_events_order_id_receiving_orders_cn_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."receiving_orders_cn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cn_scan_events" ADD CONSTRAINT "receiving_cn_scan_events_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_receiving_cn_scan_events_order" ON "receiving_cn_scan_events" USING btree ("order_id");