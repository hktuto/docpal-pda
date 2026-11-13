// ---------------------------------------------------------------------------
// Deduplicated parts master for wcl_item_no joins. The upstream-synced parts
// table no longer guarantees wcl_item_no uniqueness (duplicate rows observed
// on the UAT remote, 2026-11-12): a plain `JOIN parts p ON p.wcl_item_no =
// <key>` fans every joined row out once per duplicate. Queries that need ONE
// master row per business key must join through this derived table instead;
// existence checks, DISTINCT/LIMIT-1 lookups and grouped selects don't need
// it. The aggregate picks a deterministic representative per key (observed
// duplicates carry identical part_no/brand/description, so MIN is safe).
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";

export const partsMasterByWcl = sql`(
  SELECT MIN(id) AS id, wcl_item_no, MIN(part_no) AS part_no,
         MIN(brand) AS brand, MIN(description) AS description
  FROM parts
  WHERE wcl_item_no IS NOT NULL
  GROUP BY wcl_item_no
)`;
