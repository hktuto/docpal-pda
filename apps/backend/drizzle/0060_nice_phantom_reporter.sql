DROP INDEX "idx_receiving_scan_labels_order_part_serial";--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ALTER COLUMN "serial_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD COLUMN "raw" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_scan_labels_order_raw" ON "receiving_scan_labels" USING btree ("receiving_order_id","raw");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_scan_labels_order_part_serial" ON "receiving_scan_labels" USING btree ("receiving_order_id","part_no","serial_no") WHERE raw IS NULL;