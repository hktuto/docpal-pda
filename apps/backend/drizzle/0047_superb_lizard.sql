ALTER TABLE "picking_orders" ADD COLUMN "label_printing_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "label_printing_done_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "label_printing_done_by" text;