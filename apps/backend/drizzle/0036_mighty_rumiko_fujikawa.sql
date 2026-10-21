DROP INDEX "idx_receiving_scan_labels_order_serial";--> statement-breakpoint
ALTER TABLE "receiving_scan_labels" ADD COLUMN "part_no" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_scan_labels_order_part_serial" ON "receiving_scan_labels" USING btree ("receiving_order_id","part_no","serial_no");
