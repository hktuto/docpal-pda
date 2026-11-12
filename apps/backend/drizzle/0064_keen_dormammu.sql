CREATE TABLE "seq_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"reset_schedule" text DEFAULT 'never' NOT NULL,
	"reset_interval" integer,
	"last_reset_on" date,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "seq_counters_key_unique" UNIQUE("key")
);
