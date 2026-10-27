ALTER TABLE "picking_orders" ADD COLUMN "labeling_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "labeling_done_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "labeling_done_by" text;