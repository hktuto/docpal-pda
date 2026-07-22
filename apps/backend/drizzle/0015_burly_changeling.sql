CREATE TABLE "user_group_members" (
	"user_id" text NOT NULL,
	"group_code" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "user_group_members_user_id_group_code_pk" PRIMARY KEY("user_id","group_code")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_members" ADD CONSTRAINT "user_group_members_group_code_user_groups_code_fk" FOREIGN KEY ("group_code") REFERENCES "public"."user_groups"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Data migration: each distinct users.role becomes a group, and each user's
-- role becomes a membership row, before the column is dropped.
INSERT INTO "user_groups" ("code", "label", "created_at", "updated_at")
  SELECT DISTINCT "role", initcap("role"), now(), now() FROM "users"
  ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "user_group_members" ("user_id", "group_code", "created_at")
  SELECT "id", "role", now() FROM "users"
  ON CONFLICT ("user_id", "group_code") DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";