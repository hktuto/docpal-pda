import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

// Port of apps/web/db/picking.ts reportPickingOrderIssues. Differences from the web:
// - input carries a single `remark` (applied to every reported order's issue_remark);
//   the web's shared `note` field has no API counterpart, so issue_note stays NULL.
// - returns the reported/skipped order ids instead of counts.
// The web's I18nError keys become HTTPException 400 messages.

export type PickingIssueReason = "insufficient_stock" | "cannot_divide" | "merge";

export interface ReportPickingOrderIssuesInput {
  pickingOrderIds: string[];
  reason: PickingIssueReason;
  qty?: number | null;
  packSize?: number | null;
  remark?: string | null;
  actorId: string;
}

interface OrderRow {
  id: string;
  refNo: string;
  status: string;
  totalQty: number;
}

export function reportPickingOrderIssues(
  tx: DbOrTx,
  input: ReportPickingOrderIssuesInput
): { reported: string[]; skipped: string[] } {
  const ids = input.pickingOrderIds;
  if (ids.length === 0) throw new HTTPException(400, { message: "no_orders_selected" });
  if (input.reason === "merge" && ids.length < 2) {
    throw new HTTPException(400, { message: "select_at_least_two_orders_to_merge" });
  }
  if (input.reason === "insufficient_stock" && (input.qty == null || input.qty < 0)) {
    throw new HTTPException(400, { message: "actual_quantity_required" });
  }
  if (input.reason === "cannot_divide" && (input.packSize == null || input.packSize <= 0)) {
    throw new HTTPException(400, { message: "pack_size_required" });
  }

  const rows = tx.all<OrderRow>(sql`
    SELECT po.id, po.ref_no AS refNo, po.status,
      (SELECT COALESCE(SUM(pi.qty), 0) FROM picking_items pi WHERE pi.picking_order_id = po.id) AS totalQty
    FROM picking_orders po
    WHERE po.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // keep the caller's order; unknown ids and non-pending/picking orders are skipped
  const reportable = ids.map((id) => byId.get(id)).filter((r): r is OrderRow => !!r && (r.status === "pending" || r.status === "picking"));
  if (reportable.length === 0) throw new HTTPException(400, { message: "no_reportable_orders_selected" });

  const remark = input.remark?.trim() || null;
  const t = now();
  const reported: string[] = [];

  for (const row of reportable) {
    if (input.reason === "insufficient_stock" && input.qty! >= row.totalQty) {
      throw new HTTPException(400, { message: `actual_qty_must_be_less_than_requested: ${row.refNo}` });
    }

    tx.run(sql`
      UPDATE picking_orders
      SET status = 'issue',
          issue_reason = ${input.reason},
          issue_qty = ${input.reason === "insufficient_stock" ? input.qty : null},
          issue_pack_size = ${input.reason === "cannot_divide" ? input.packSize : null},
          issue_note = NULL,
          issue_remark = ${remark},
          issue_reported_at = ${t},
          issue_reported_by = ${input.actorId},
          updated_at = ${t}
      WHERE id = ${row.id}
    `);

    logTransition(tx, {
      entityType: "picking_order",
      entityId: row.id,
      fromStatus: row.status,
      toStatus: "issue",
      actorId: input.actorId,
      note: `reason=${input.reason}` + (input.qty != null ? ` qty=${input.qty}` : "") + (input.packSize != null ? ` packSize=${input.packSize}` : ""),
    });

    reported.push(row.id);
  }

  const reportedSet = new Set(reported);
  return { reported, skipped: ids.filter((id) => !reportedSet.has(id)) };
}
