-- Internal transfer allocation supply (spec
-- 2026-11-17-internal-transfer-allocation-supply-design.md): the order-level
-- delegated link is deprecated — per-item promises live in
-- allocations.internal_transfer_item_id.
UPDATE "internal_transfer_orders" SET "picking_order_id" = NULL WHERE "picking_order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "allocations" DROP CONSTRAINT "chk_allocations_source";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "internal_transfer_item_id" text;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_internal_transfer_item_id_internal_transfer_items_id_fk" FOREIGN KEY ("internal_transfer_item_id") REFERENCES "public"."internal_transfer_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_allocations_internal_transfer_item" ON "allocations" USING btree ("internal_transfer_item_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "chk_allocations_source" CHECK (inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL OR internal_transfer_item_id IS NOT NULL);