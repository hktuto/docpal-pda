ALTER TABLE "receiving_orders" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receiving_orders_external_id" ON "receiving_orders" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_picking_orders_external_id" ON "picking_orders" USING btree ("external_id");