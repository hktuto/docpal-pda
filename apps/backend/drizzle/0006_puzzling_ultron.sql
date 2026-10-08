ALTER TABLE "picking_orders" ADD COLUMN IF NOT EXISTS "picking_order_type" varchar(64);--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN IF NOT EXISTS "remark" text;