CREATE TABLE "goods_verify_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_date" date NOT NULL,
	"inventory_lot_id" text NOT NULL,
	"shelf_code" text,
	"box_id" text,
	"part_id" text NOT NULL,
	"expected_qty" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_tasks" ADD CONSTRAINT "goods_verify_tasks_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_verify_tasks_lot_day_unique" ON "goods_verify_tasks" USING btree ("task_date","inventory_lot_id");--> statement-breakpoint
CREATE INDEX "idx_goods_verify_tasks_shelf" ON "goods_verify_tasks" USING btree ("shelf_code","task_date");--> statement-breakpoint
CREATE INDEX "idx_goods_verify_tasks_status" ON "goods_verify_tasks" USING btree ("status");