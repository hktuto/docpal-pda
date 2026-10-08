ALTER TABLE "internal_transfer_items" ADD COLUMN IF NOT EXISTS "po_no" text;--> statement-breakpoint
ALTER TABLE "internal_transfer_orders" ADD COLUMN IF NOT EXISTS "customer_name" text;