ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scan_status" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scan_qty" integer;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scan_reason" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scan_note" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scanned_by" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN "scanned_at" timestamp;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ADD CONSTRAINT "receiving_invoice_items_cn_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;