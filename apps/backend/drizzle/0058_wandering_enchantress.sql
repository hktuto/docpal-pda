CREATE TABLE "picking_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text NOT NULL,
	"step" text NOT NULL,
	"assignee" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_picking_tasks_step" CHECK (step IN ('labeling', 'label-printing'))
);
--> statement-breakpoint
ALTER TABLE "picking_tasks" ADD CONSTRAINT "picking_tasks_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_picking_tasks_order_step" ON "picking_tasks" USING btree ("picking_order_id","step");