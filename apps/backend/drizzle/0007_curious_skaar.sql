ALTER TABLE "shelves" ADD COLUMN "sub_inventory_scopes" jsonb;
--> statement-breakpoint
-- Backfill: expand each legacy code to every org that has it, preserving the
-- old org-agnostic matching semantics (codes repeat across orgs in org_info).
UPDATE "shelves" s SET "sub_inventory_scopes" = (
  SELECT jsonb_agg(jsonb_build_object('orgId', o.org_id, 'code', o.secondary_inventory_name))
  FROM "org_info" o
  WHERE o.secondary_inventory_name = ANY(s."sub_inventory_codes")
) WHERE s."sub_inventory_codes" IS NOT NULL;
