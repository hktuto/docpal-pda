CREATE TABLE "inventory_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"sub_inventory_code" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"remark" text,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_labels_org_subinv_unique" UNIQUE("org_id","sub_inventory_code")
);
--> statement-breakpoint
ALTER TABLE "inventory_labels" ADD CONSTRAINT "inventory_labels_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."org_info"("org_id","secondary_inventory_name") ON DELETE no action ON UPDATE no action;