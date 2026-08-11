CREATE TABLE "put_away_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"receiving_order_id" text NOT NULL,
	"org_id" integer,
	"sub_inventory_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "put_away_tasks" ADD CONSTRAINT "put_away_tasks_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_put_away_tasks_receiving_order" ON "put_away_tasks" USING btree ("receiving_order_id");--> statement-breakpoint
CREATE INDEX "idx_put_away_tasks_status" ON "put_away_tasks" USING btree ("status");