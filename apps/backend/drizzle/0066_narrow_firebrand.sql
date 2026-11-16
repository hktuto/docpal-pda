ALTER TABLE "picking_orders" ADD COLUMN "packed_input_box_count" integer;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packed_carts" jsonb;