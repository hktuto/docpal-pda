CREATE TABLE "sub_inventory_share_members" (
	"org_id" integer NOT NULL,
	"code" text NOT NULL,
	"share_group" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "sub_inventory_share_members_org_id_code_pk" PRIMARY KEY("org_id","code")
);
--> statement-breakpoint
ALTER TABLE "sub_inventory_share_members" ADD CONSTRAINT "sub_inventory_share_members_group_fk" FOREIGN KEY ("org_id","code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sub_inv_share_members_group" ON "sub_inventory_share_members" USING btree ("share_group");