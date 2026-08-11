-- Existing verify_tasks rows are order-keyed (ephemeral demo data) and cannot
-- be re-mapped to boxes; clear them before the NOT NULL column lands.
DELETE FROM "verify_tasks";--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "shipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "shipped_by" text;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "shipping_box_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD CONSTRAINT "shipping_boxes_shipped_by_users_id_fk" FOREIGN KEY ("shipped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD CONSTRAINT "verify_tasks_shipping_box_id_shipping_boxes_id_fk" FOREIGN KEY ("shipping_box_id") REFERENCES "public"."shipping_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_verify_tasks_shipping_box" ON "verify_tasks" USING btree ("shipping_box_id");