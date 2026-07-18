CREATE TABLE "box_size_list" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "country_list" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "net_weight_formula" (
	"id" text PRIMARY KEY NOT NULL,
	"part_id" text NOT NULL,
	"qty" integer NOT NULL,
	"weight" real NOT NULL,
	CONSTRAINT "net_weight_formula_part_id_unique" UNIQUE("part_id")
);
--> statement-breakpoint
CREATE TABLE "sub_inventories" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"customer_code" text
);
--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "sub_inventory_code" text;--> statement-breakpoint
ALTER TABLE "net_weight_formula" ADD CONSTRAINT "net_weight_formula_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD CONSTRAINT "sub_inventories_customer_code_customer_profiles_code_fk" FOREIGN KEY ("customer_code") REFERENCES "public"."customer_profiles"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_sub_inventory_code_sub_inventories_code_fk" FOREIGN KEY ("sub_inventory_code") REFERENCES "public"."sub_inventories"("code") ON DELETE no action ON UPDATE no action;