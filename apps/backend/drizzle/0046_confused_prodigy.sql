ALTER TABLE "put_away_tasks_cn" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "receiving_orders_cn" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "verify_tasks" ADD COLUMN "assignee" text;--> statement-breakpoint
ALTER TABLE "put_away_tasks" ADD COLUMN "assignee" text;