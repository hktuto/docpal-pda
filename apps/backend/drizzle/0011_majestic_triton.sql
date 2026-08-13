-- Rename sub_inventories columns to mirror the upstream DocPal/Oracle
-- subinventory schema, and add the two upstream columns the PDA does not use.
-- RENAME COLUMN (not drop/re-add) so existing rows and the 7 composite FKs
-- targeting (org_id, code) survive untouched; RENAME CONSTRAINT only relabels
-- the unique constraint, which already follows the renamed column.
ALTER TABLE "sub_inventories" RENAME COLUMN "code" TO "secondary_inventory_name";--> statement-breakpoint
ALTER TABLE "sub_inventories" RENAME COLUMN "name" TO "subinv_description";--> statement-breakpoint
ALTER TABLE "sub_inventories" RENAME COLUMN "created_date" TO "creation_date";--> statement-breakpoint
ALTER TABLE "sub_inventories" RENAME CONSTRAINT "sub_inventories_org_code_unique" TO "sub_inventories_org_subinv_unique";--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD COLUMN "office_code" text;--> statement-breakpoint
ALTER TABLE "sub_inventories" ADD COLUMN "organization_id" integer;
