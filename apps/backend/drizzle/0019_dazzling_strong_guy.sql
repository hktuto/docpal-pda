-- 3-level sub-inventories (org_id → code → tag, per new_seed/subInventories.xlsx):
-- sub_inventories becomes the (org_id, code) GROUP table that stock/doc tables
-- reference via composite FK; the tag level moves to sub_inventory_tags
-- (lookup-only). Order: drop old FKs → rebuild sub_inventories + create
-- sub_inventory_tags with the xlsx rows → remap referencing tables' tag
-- values to their (org, code) group → add the composite FKs.

ALTER TABLE "receiving_invoice_items" DROP CONSTRAINT "receiving_invoice_items_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint
ALTER TABLE "receiving_invoices" DROP CONSTRAINT "receiving_invoices_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint
ALTER TABLE "receiving_orders" DROP CONSTRAINT "receiving_orders_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint
ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint
ALTER TABLE "inventory_lots" DROP CONSTRAINT "inventory_lots_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint
ALTER TABLE "shelf_boxes" DROP CONSTRAINT "shelf_boxes_sub_inventory_code_sub_inventories_code_fk";--> statement-breakpoint

DROP TABLE "sub_inventories";--> statement-breakpoint
CREATE TABLE "sub_inventories" (
	"org_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"customer_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sub_inventories_org_id_code_pk" PRIMARY KEY("org_id","code")
);--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD CONSTRAINT "sub_inventories_customer_code_customer_profiles_code_fk" FOREIGN KEY ("customer_code") REFERENCES "public"."customer_profiles"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "sub_inventory_tags" (
	"org_id" integer NOT NULL,
	"code" text NOT NULL,
	"tag" text NOT NULL,
	"name" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sub_inventory_tags_org_id_code_tag_pk" PRIMARY KEY("org_id","code","tag"),
	CONSTRAINT "sub_inventory_tags_group_fk" FOREIGN KEY ("org_id","code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint

INSERT INTO "sub_inventories" ("org_id", "code", "name", "customer_code") VALUES
  (2,   'STORE1',        'Store 1', NULL),
  (2,   'WSTORE1',       NULL, NULL),
  (2,   'OSWF (HK)',     NULL, NULL),
  (220, 'THHK2',         NULL, NULL),
  (220, 'OSWF (TH)',     NULL, NULL),
  (140, 'STORE1',        NULL, NULL),
  (140, 'ZTE',           NULL, NULL),
  (140, 'OSWF (MCE)',    NULL, NULL),
  (140, 'HUAWEI',        NULL, NULL),
  (140, 'HWOS (HUAWEI)', NULL, NULL),
  (140, 'DEFAULT',       NULL, NULL),
  (143, 'store1',        NULL, NULL),
  (143, 'OSWF (MCI)',    NULL, NULL),
  (143, 'DEFAULT',       NULL, NULL),
  -- demo customer-segregated store (kept from the old seed)
  (2,   'ACME-S1',       'ACME segregated store', 'ACME');--> statement-breakpoint

INSERT INTO "sub_inventory_tags" ("org_id", "code", "tag", "name") VALUES
  (2,   'STORE1',        'STORE1',        'Store 1'),
  (2,   'WSTORE1',       'WSTORE1',       NULL),
  (2,   'OSWF (HK)',     'OSWF (HK)',     NULL),
  (220, 'THHK2',         'THHK2',         NULL),
  (220, 'OSWF (TH)',     'OSWF (TH)',     NULL),
  (140, 'STORE1',        'BJHK1',         NULL),
  (140, 'STORE1',        'GZHK1',         NULL),
  (140, 'STORE1',        'SHHK1',         NULL),
  (140, 'STORE1',        'SZHK1',         NULL),
  (140, 'ZTE',           'ZTE',           NULL),
  (140, 'OSWF (MCE)',    'OSWF (MCE)',    NULL),
  (140, 'HUAWEI',        'HUAWEI',        NULL),
  (140, 'HUAWEI',        'HUAWEI-CAR',    NULL),
  (140, 'HWOS (HUAWEI)', 'HWOS (HUAWEI)', NULL),
  (140, 'DEFAULT',       'DEFAULT',       NULL),
  (143, 'store1',        'BJHK2',         NULL),
  (143, 'store1',        'GZHK2',         NULL),
  (143, 'store1',        'SHHK2',         NULL),
  (143, 'store1',        'SZHK2',         NULL),
  (143, 'OSWF (MCI)',    'OSWF (MCI)',    NULL),
  (143, 'DEFAULT',       'DEFAULT',       NULL),
  (2,   'ACME-S1',       'ACME-S1',       'ACME segregated store');--> statement-breakpoint

-- Remap referencing tables: values that were tags become their (org, code) group.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receiving_orders','receiving_invoices','receiving_invoice_items','inventory_lots','picking_orders','shelf_boxes']
  LOOP
    EXECUTE format($u$UPDATE %I SET org_id = 140, sub_inventory_code = 'STORE1'  WHERE sub_inventory_code IN ('BJHK1','GZHK1','SHHK1','SZHK1')$u$, t);
    EXECUTE format($u$UPDATE %I SET org_id = 143, sub_inventory_code = 'store1'  WHERE sub_inventory_code IN ('BJHK2','GZHK2','SHHK2','SZHK2')$u$, t);
    EXECUTE format($u$UPDATE %I SET org_id = 140, sub_inventory_code = 'HUAWEI'  WHERE sub_inventory_code = 'HUAWEI-CAR'$u$, t);
    -- sub == tag rows whose org was wrongly seeded as 2
    EXECUTE format($u$UPDATE %I SET org_id = 220 WHERE sub_inventory_code IN ('THHK2','OSWF (TH)') AND org_id = 2$u$, t);
    EXECUTE format($u$UPDATE %I SET org_id = 140 WHERE sub_inventory_code IN ('ZTE','OSWF (MCE)','HUAWEI','HWOS (HUAWEI)') AND org_id = 2$u$, t);
  END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE "receiving_invoice_items" ADD CONSTRAINT "receiving_invoice_items_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_invoices" ADD CONSTRAINT "receiving_invoices_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelf_boxes" ADD CONSTRAINT "shelf_boxes_sub_inv_fk" FOREIGN KEY ("org_id","sub_inventory_code") REFERENCES "public"."sub_inventories"("org_id","code") ON DELETE no action ON UPDATE no action;