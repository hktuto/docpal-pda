CREATE TABLE "scan_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"raw" text NOT NULL,
	"matched" boolean NOT NULL,
	"template_supplier_code" text,
	"parsed" jsonb,
	"actor_id" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_scan_events_created" ON "scan_events" USING btree ("created_date");--> statement-breakpoint
CREATE INDEX "idx_scan_events_raw" ON "scan_events" USING btree ("raw");