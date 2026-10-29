CREATE TABLE "label_prints" (
	"id" text PRIMARY KEY NOT NULL,
	"picking_order_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"label_type" text NOT NULL,
	"print_template_id" text NOT NULL,
	"printer_name" text,
	"service_id" text,
	"device_key" text,
	"expected_label_count" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"printed_by" text NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "picking_packages" ADD COLUMN "label_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD COLUMN "label_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_packages" ADD COLUMN "label_verified_by" text;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "carton_label_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "carton_label_verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "shipping_boxes" ADD COLUMN "carton_label_verified_by" text;--> statement-breakpoint
ALTER TABLE "label_print_rules" ADD COLUMN "label_source" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_picking_order_id_picking_orders_id_fk" FOREIGN KEY ("picking_order_id") REFERENCES "public"."picking_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_rule_id_label_print_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."label_print_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_label_prints_order" ON "label_prints" USING btree ("picking_order_id");--> statement-breakpoint
ALTER TABLE "label_print_rules" ADD CONSTRAINT "chk_label_print_rules_label_source" CHECK (label_source IN ('internal', 'external'));