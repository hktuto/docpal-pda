CREATE TABLE "ad_hoc_put_aways" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_code" text NOT NULL,
	"shelf_code" text NOT NULL,
	"org_id" integer NOT NULL,
	"sub_inventory_code" text NOT NULL,
	"total_qty" integer NOT NULL,
	"item_count" integer NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_hoc_put_aways" ADD CONSTRAINT "ad_hoc_put_aways_shelf_code_shelves_code_fk" FOREIGN KEY ("shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_hoc_put_aways" ADD CONSTRAINT "ad_hoc_put_aways_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ad_hoc_put_aways_shelf" ON "ad_hoc_put_aways" USING btree ("shelf_code");--> statement-breakpoint
CREATE INDEX "idx_ad_hoc_put_aways_actor" ON "ad_hoc_put_aways" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_ad_hoc_put_aways_created" ON "ad_hoc_put_aways" USING btree ("created_date");