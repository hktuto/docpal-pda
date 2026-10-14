import { sql, type SQL } from "drizzle-orm";

// The allocation engine's location rule (loadLotSources / loadReceivingSources
// in allocate.ts), shared as a SQL fragment: same org, and either the same
// sub-inventory or a sibling in the same sub_inventory_share_members group.
// A NULL context field means "no constraint" (org-agnostic / any
// sub-inventory). Extracted from routes/admin/partAvailability.ts so the
// admin allocation mutations can apply the identical rule.

export interface LocationMatchContext {
  orgId: number | null;
  subInventoryCode: string | null;
}

export function locationMatches(ctx: LocationMatchContext, orgCol: SQL, subCol: SQL): SQL {
  return sql`(
    (${ctx.orgId}::int IS NULL OR ${orgCol} = ${ctx.orgId})
    AND (
      ${ctx.subInventoryCode}::text IS NULL
      OR upper(${subCol}) = upper(${ctx.subInventoryCode})
      OR EXISTS (
        SELECT 1
        FROM sub_inventory_share_members sm_d
        JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
        WHERE sm_d.org_id = ${ctx.orgId} AND upper(sm_d.code) = upper(${ctx.subInventoryCode})
          AND sm_s.org_id = ${orgCol} AND upper(sm_s.code) = upper(${subCol})
      )
    )
  )`;
}
