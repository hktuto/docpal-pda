CREATE TABLE "outdated_scan_warnings" (
	"id" text PRIMARY KEY NOT NULL,
	"order_kind" text NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text,
	"package_id" text,
	"supplier_code" text NOT NULL,
	"wcl_item_no" text,
	"part_no" text,
	"date_code" text NOT NULL,
	"limit_months" integer NOT NULL,
	"qty" integer,
	"scanned_by" text NOT NULL,
	"scanned_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" text,
	"resolution_note" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_profiles" ADD COLUMN "outdated_limit_months" integer;--> statement-breakpoint
-- Backfill: existing profiles opt into the outdated check at the default 12
-- months (admins clear the field to NULL to opt a supplier out).
UPDATE "supplier_profiles" SET "outdated_limit_months" = 12 WHERE "outdated_limit_months" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_outdated_scan_warnings_order" ON "outdated_scan_warnings" USING btree ("order_kind","order_id");