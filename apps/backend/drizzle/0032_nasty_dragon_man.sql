CREATE TABLE "date_code_counter_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"encoding" text NOT NULL,
	"direction" text NOT NULL,
	"counter_from" integer NOT NULL,
	"counter_to" integer NOT NULL,
	"period_start" date NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
