ALTER TABLE "picking_tasks" DROP CONSTRAINT "chk_picking_tasks_step";--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packaged_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packaged_by" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packed_weight" real;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packed_box_count" integer;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "packed_pallet_count" integer;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_packaged_by_users_id_fk" FOREIGN KEY ("packaged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_tasks" ADD CONSTRAINT "chk_picking_tasks_step" CHECK (step IN ('labeling', 'label-printing', 'packaging'));