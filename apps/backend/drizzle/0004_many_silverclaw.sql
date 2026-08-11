ALTER TABLE "measuring_tasks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "measuring_tasks" CASCADE;--> statement-breakpoint
-- DROP TABLE "measuring_tasks" CASCADE above already dropped this FK (it
-- depends on measuring_tasks), so tolerate its absence.
ALTER TABLE "shipping_boxes" DROP CONSTRAINT IF EXISTS "shipping_boxes_measuring_task_id_measuring_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "verify_tasks" DROP CONSTRAINT "verify_tasks_picking_order_id_picking_orders_id_fk";
--> statement-breakpoint
DROP INDEX "idx_shipping_boxes_task";--> statement-breakpoint
DROP INDEX "idx_verify_tasks_picking_order";--> statement-breakpoint
ALTER TABLE "shipping_boxes" DROP COLUMN "measuring_task_id";--> statement-breakpoint
ALTER TABLE "verify_tasks" DROP COLUMN "picking_order_id";