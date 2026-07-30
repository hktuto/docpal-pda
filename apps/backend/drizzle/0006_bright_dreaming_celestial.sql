ALTER TABLE "picking_orders" ADD COLUMN "allocation_status" text DEFAULT 'unallocated' NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "shipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD COLUMN "shipped_by" text;--> statement-breakpoint
ALTER TABLE "picking_orders" ADD CONSTRAINT "picking_orders_shipped_by_users_id_fk" FOREIGN KEY ("shipped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Backfill allocation_status for current open orders (hand-appended): same
-- aggregate allocateAll's refreshAllocationStatus maintains — Σ allocated_qty
-- vs Σ open qty (qty − Σ packages); 'allocated' when equal (incl. the
-- Σ open = 0 fully-picked edge), 'partial' in between, else 'unallocated'.
UPDATE "picking_orders" po
SET "allocation_status" = agg."new_status"
FROM (
  SELECT po2."id",
         CASE
           WHEN COALESCE(SUM(pi."allocated_qty"), 0) = COALESCE(SUM(pi."qty"), 0) - COALESCE(SUM(pkg."qty"), 0) THEN 'allocated'
           WHEN COALESCE(SUM(pi."allocated_qty"), 0) > 0 THEN 'partial'
           ELSE 'unallocated'
         END AS "new_status"
  FROM "picking_orders" po2
  LEFT JOIN "picking_items" pi ON pi."picking_order_id" = po2."id"
  LEFT JOIN (
    SELECT "picking_item_id", SUM("qty")::int AS "qty"
    FROM "picking_packages" GROUP BY "picking_item_id"
  ) pkg ON pkg."picking_item_id" = pi."id"
  WHERE po2."status" IN ('pending', 'picking')
  GROUP BY po2."id"
) agg
WHERE po."id" = agg."id" AND po."allocation_status" IS DISTINCT FROM agg."new_status";