CREATE TABLE "user_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"sub_inventory_scopes" jsonb,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_username_unique" UNIQUE("username")
);
