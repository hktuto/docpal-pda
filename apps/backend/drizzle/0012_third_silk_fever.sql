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
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_receiving_invoice_item_id_receiving_invoice_items_id_fk" FOREIGN KEY ("receiving_invoice_item_id") REFERENCES "public"."receiving_invoice_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD CONSTRAINT "receiving_scan_labels_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_scan_labels_order_serial" ON "receiving_scan_labels" USING btree ("receiving_order_id","serial_no");