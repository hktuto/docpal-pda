CREATE TABLE "shelf_exchanges" (
	"id" text PRIMARY KEY NOT NULL,
	"source_shelf_code" text NOT NULL,
	"target_shelf_code" text NOT NULL,
	"source_lot_id" text NOT NULL,
	"target_lot_id" text NOT NULL,
	"part_no" text NOT NULL,
	"wcl_item_no" text,
	"qty" integer NOT NULL,
	"date_code" text,
	"lot_code" text,
	"coo" text,
	"cow" text,
	"org_id" integer,
	"sub_inventory_code" text,
	"actor_id" text NOT NULL,
	"created_date" timestamp DEFAULT now() NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shelf_exchanges" ADD CONSTRAINT "shelf_exchanges_source_shelf_code_shelves_code_fk" FOREIGN KEY ("source_shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_exchanges" ADD CONSTRAINT "shelf_exchanges_target_shelf_code_shelves_code_fk" FOREIGN KEY ("target_shelf_code") REFERENCES "public"."shelves"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_exchanges" ADD CONSTRAINT "shelf_exchanges_source_lot_id_inventory_lots_id_fk" FOREIGN KEY ("source_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_exchanges" ADD CONSTRAINT "shelf_exchanges_target_lot_id_inventory_lots_id_fk" FOREIGN KEY ("target_lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_exchanges" ADD CONSTRAINT "shelf_exchanges_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_shelf_exchanges_source_shelf" ON "shelf_exchanges" USING btree ("source_shelf_code");--> statement-breakpoint
CREATE INDEX "idx_shelf_exchanges_target_shelf" ON "shelf_exchanges" USING btree ("target_shelf_code");--> statement-breakpoint
CREATE INDEX "idx_shelf_exchanges_part" ON "shelf_exchanges" USING btree ("part_no");--> statement-breakpoint
CREATE INDEX "idx_shelf_exchanges_actor" ON "shelf_exchanges" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_shelf_exchanges_created" ON "shelf_exchanges" USING btree ("created_date");