CREATE TABLE "auto_labeling_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text NOT NULL,
	"machine_id" text,
	"payload" jsonb NOT NULL,
	"order_snapshot" jsonb NOT NULL,
	"scan_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_note" text,
	"created_by" text NOT NULL,
	"fetched_date" timestamp,
	"completed_date" timestamp,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_auto_labeling_jobs_status" CHECK (status IN ('pending', 'printing', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "label_print_rules" DROP CONSTRAINT "chk_label_print_rules_label_source";--> statement-breakpoint
ALTER TABLE "auto_labeling_jobs" ADD CONSTRAINT "auto_labeling_jobs_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auto_labeling_jobs_order" ON "auto_labeling_jobs" USING btree ("picking_order_id");--> statement-breakpoint
CREATE INDEX "idx_auto_labeling_jobs_fetch" ON "auto_labeling_jobs" USING btree ("status","machine_id","created_date");--> statement-breakpoint
ALTER TABLE "label_print_rules" ADD CONSTRAINT "chk_label_print_rules_label_source" CHECK (label_source IN ('internal', 'external', 'auto_machine'));