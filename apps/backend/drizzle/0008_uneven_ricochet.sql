ALTER TABLE "allocations" DROP CONSTRAINT "chk_allocations_source";--> statement-breakpoint
ALTER TABLE "receiving_orders" ALTER COLUMN "sub_inventory_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "date_code" text;--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "receiving_order_id" text;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_allocations_receiving_order" ON "allocations" USING btree ("receiving_order_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "chk_allocations_source" CHECK (inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL);