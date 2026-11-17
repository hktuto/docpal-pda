-- Goods verify count mode (spec
-- 2026-11-18-goods-verify-count-mode-design.md): per-line blind-count
-- submissions — the PDA operator saves the qty found on the shelf per moved
-- part; the admin compares against live shelf totals. UNIQUE (task_id,
-- part_no) so re-counts overwrite.
CREATE TABLE "goods_verify_task_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"part_no" text NOT NULL,
	"counted_qty" integer NOT NULL,
	"counted_by" text,
	"counted_at" timestamp DEFAULT now() NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_goods_verify_task_counts_qty" CHECK (counted_qty >= 0)
);
--> statement-breakpoint
ALTER TABLE "goods_verify_task_counts" ADD CONSTRAINT "goods_verify_task_counts_task_id_goods_verify_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."goods_verify_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_verify_task_counts" ADD CONSTRAINT "goods_verify_task_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_verify_task_counts_task_part_unique" ON "goods_verify_task_counts" USING btree ("task_id","part_no");--> statement-breakpoint
CREATE INDEX "idx_goods_verify_task_counts_task" ON "goods_verify_task_counts" USING btree ("task_id");