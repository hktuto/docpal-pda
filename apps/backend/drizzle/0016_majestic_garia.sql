CREATE TABLE "sub_inventories" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"org_id" integer NOT NULL,
	"customer_code" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
DROP INDEX "inventory_lots_unique_lot";--> statement-breakpoint
ALTER TABLE "shelves" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
-- Existing rows (pre-0016 dev databases) have no sub-inventory yet: backfill
-- them into a fallback STORE1 before enforcing NOT NULL. Fresh databases have
-- no rows, so this is a no-op there (the seed repopulates either way).
INSERT INTO "sub_inventories" ("code", "name", "org_id", "created_at", "updated_at")
	VALUES ('STORE1', 'Main store', 2, now(), now())
	ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
UPDATE "receiving_orders" SET "sub_inventory_code" = 'STORE1' WHERE "sub_inventory_code" IS NULL;--> statement-breakpoint
ALTER TABLE "receiving_orders" ALTER COLUMN "sub_inventory_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "org_id" integer;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "org_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD CONSTRAINT "sub_inventories_customer_code_customer_profiles_code_fk" FOREIGN KEY ("customer_code") REFERENCES "public"."customer_profiles"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_unique_lot" ON "inventory_lots" USING btree ("part_no","date_code","coo","cow","shelf_code","box_id","org_id","sub_inventory_code") WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;