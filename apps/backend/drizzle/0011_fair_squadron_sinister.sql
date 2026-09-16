CREATE TABLE "label_print_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"label_type" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"print_template_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"remark" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
