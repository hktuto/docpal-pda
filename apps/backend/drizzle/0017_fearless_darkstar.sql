ALTER TABLE "picking_orders" ADD COLUMN "priority_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: existing orders keep creation order as their priority.
UPDATE "picking_orders" SET "priority_seq" = r.seq FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS seq FROM "picking_orders") r WHERE "picking_orders".id = r.id;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "working_by" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "working_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_working_by_users_id_fk" FOREIGN KEY ("working_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;