CREATE TABLE "warehouse_sections" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"warehouse_code" text DEFAULT 'HK1' NOT NULL
);
--> statement-breakpoint
DROP INDEX "inventory_lots_unique_lot";--> statement-breakpoint
ALTER TABLE "shelves" ADD COLUMN "warehouse_section_code" text;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD COLUMN "warehouse_section_code" text;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD COLUMN "warehouse_section_code" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "warehouse_section_code" text;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD COLUMN "warehouse_section_code" text;--> statement-breakpoint
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_warehouse_section_code_warehouse_sections_code_fk" FOREIGN KEY ("warehouse_section_code") REFERENCES "public"."warehouse_sections"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_warehouse_section_code_warehouse_sections_code_fk" FOREIGN KEY ("warehouse_section_code") REFERENCES "public"."warehouse_sections"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_warehouse_section_code_warehouse_sections_code_fk" FOREIGN KEY ("warehouse_section_code") REFERENCES "public"."warehouse_sections"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_warehouse_section_code_warehouse_sections_code_fk" FOREIGN KEY ("warehouse_section_code") REFERENCES "public"."warehouse_sections"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_warehouse_section_code_warehouse_sections_code_fk" FOREIGN KEY ("warehouse_section_code") REFERENCES "public"."warehouse_sections"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_lots_unique_lot" ON "inventory_lots" USING btree ("part_id","date_code","coo","cow","shelf_code","box_id","warehouse_section_code","sub_inventory_code","warehouse_code") WHERE shelf_code IS NOT NULL OR box_id IS NOT NULL;