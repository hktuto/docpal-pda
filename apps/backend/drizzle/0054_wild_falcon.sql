CREATE TABLE "bug_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"app" text NOT NULL,
	"route" text NOT NULL,
	"category" text,
	"note" text NOT NULL,
	"reporter" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photo" text,
	"photo_mime" text,
	"status" text DEFAULT 'open' NOT NULL,
	"uat_ref" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_bug_reports_app" CHECK (app IN ('pda', 'admin')),
	CONSTRAINT "chk_bug_reports_status" CHECK (status IN ('open', 'triaged', 'closed'))
);
--> statement-breakpoint
CREATE INDEX "idx_bug_reports_status_created" ON "bug_reports" USING btree ("status","created_date");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_reporter" ON "bug_reports" USING btree ("reporter");