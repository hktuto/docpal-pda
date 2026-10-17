ALTER TABLE "goods_verify_tasks" DROP CONSTRAINT "goods_verify_tasks_inventory_lot_id_inventory_lots_id_fk";
--> statement-breakpoint
DROP INDEX "goods_verify_tasks_lot_day_unique";--> statement-breakpoint
DROP INDEX "idx_goods_verify_tasks_shelf";--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ALTER COLUMN "inventory_lot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ALTER COLUMN "shelf_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ALTER COLUMN "part_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ALTER COLUMN "expected_qty" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD COLUMN "movements" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_verify_tasks_shelf_day_unique" ON "goods_verify_tasks" USING btree ("task_date","shelf_code");