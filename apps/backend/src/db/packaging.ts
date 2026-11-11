import { HTTPException } from "hono/http-exception";
import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { now } from "./now.js";
import { isStepEnabled } from "../config.js";
import { emitEvent } from "./events.js";
import { logTransition, pickingOrderOrgFilter } from "./picking.js";
import { assigneeFilter, type UserScopeEntry } from "./user-scope.js";

// ---------------------------------------------------------------------------
// Packaging stage (打包, spec 2026-11-10-packaging-shipping-steps-design.md)
// — an opt-in step after verify, ORDER-keyed (one confirm per picking order).
// The queue is fully DERIVED (no *_pending flag, no creation hook): an order
// is ready when it is picking-complete, no labeling stages are pending, every
// package is boxed, every box holding its packages is closed (+ its verify
// task completed when the verify step is on, mirroring shipping's
// readyToShipWhere) and it was never packaged. Confirming records total
// weight + the server-recomputed box count (auto count) + optional pallet
// count and stamps packaged_at/packaged_by — the order status stays
// 'measuring_finished' until the per-box ship derives 'shipped'. Assignee
// rides the picking_tasks side table (step='packaging', CR-048 pattern).
// ---------------------------------------------------------------------------

export interface PackagingOrderRow {
  id: string;
  orderNo: string;
  customerCode: string | null;
  shipTo: string | null;
  poNo: string | null;
  boxCount: number;
  packageCount: number;
  /** Σ gross_weight of the order's boxes — display hint only, never written. */
  grossWeightHint: number | null;
  assignee: string | null;
  packagedAt: Date | null;
  packagedBy: string | null;
  packedWeight: number | null;
  packedBoxCount: number | null;
  packedPalletCount: number | null;
  lastUpdateDate: Date;
}

/** Pending-queue predicate for `picking_orders po` (bare conditions, AND-joined). */
export function packagingPendingWhere(): SQL {
  return sql`
    po.status IN ('picking_finished', 'measuring_finished')
    AND po.labeling_pending = false AND po.label_printing_pending = false
    AND po.packaged_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM picking_packages x
      WHERE x.picking_order_id = po.id AND x.shipping_box_id IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM picking_packages x
      JOIN shipping_boxes y ON y.id = x.shipping_box_id
      WHERE x.picking_order_id = po.id AND y.status <> 'closed')
    AND (${!isStepEnabled("verify")} OR NOT EXISTS (
      SELECT 1 FROM picking_packages x
      WHERE x.picking_order_id = po.id AND x.shipping_box_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM verify_tasks vt
          WHERE vt.shipping_box_id = x.shipping_box_id AND vt.status = 'completed')))`;
}

const PACKAGING_COUNTS = sql`
  (SELECT COUNT(DISTINCT p.shipping_box_id)::int
     FROM picking_packages p
     WHERE p.picking_order_id = po.id AND p.shipping_box_id IS NOT NULL) AS "boxCount",
  (SELECT COUNT(*)::int FROM picking_packages p WHERE p.picking_order_id = po.id) AS "packageCount",
  (SELECT SUM(s.gross_weight)::real FROM shipping_boxes s
     WHERE s.id IN (SELECT DISTINCT p.shipping_box_id FROM picking_packages p
                    WHERE p.picking_order_id = po.id AND p.shipping_box_id IS NOT NULL)) AS "grossWeightHint"`;

/** Packaging queue. status='completed' lists packaged orders (history,
 *  shipped included); anything else lists the pending queue. */
export async function listPackagingOrders(
  db: AppDb,
  opts?: { status?: string; search?: string; scope?: UserScopeEntry[] | null; username?: string }
): Promise<PackagingOrderRow[]> {
  const search = opts?.search?.trim();
  const statusWhere =
    opts?.status === "completed"
      ? sql`po.packaged_at IS NOT NULL`
      : packagingPendingWhere();
  return queryAll<PackagingOrderRow>(
    db,
    sql`
      SELECT
        po.id, po.order_no AS "orderNo", po.customer_code AS "customerCode",
        po.ship_to AS "shipTo", po.po_no AS "poNo",
        ${PACKAGING_COUNTS},
        pt.assignee,
        po.packaged_at AS "packagedAt", po.packaged_by AS "packagedBy",
        po.packed_weight AS "packedWeight", po.packed_box_count AS "packedBoxCount",
        po.packed_pallet_count AS "packedPalletCount",
        po.last_update_date AS "lastUpdateDate"
      FROM picking_orders po
      LEFT JOIN picking_tasks pt ON pt.picking_order_id = po.id AND pt.step = 'packaging'
      WHERE TRUE AND (${statusWhere})
      ${search ? sql`AND (po.order_no ILIKE ${"%" + search + "%"} OR po.customer_code ILIKE ${"%" + search + "%"} OR po.ship_to ILIKE ${"%" + search + "%"})` : sql``}
      ${pickingOrderOrgFilter(sql`po.org_id`, sql`po.sub_inventory_code`, sql`po.picking_order_type`, opts?.scope)}
      ${assigneeFilter(sql`pt.assignee`, opts?.username)}
      ORDER BY CASE WHEN po.packaged_at IS NULL THEN 0 ELSE 1 END, po.last_update_date DESC, po.order_no
    `
  );
}

export interface PackagingBoxRow {
  id: string;
  status: string;
  grossWeight: number | null;
  netWeight: number | null;
  boxSize: string | null;
  destinationCountry: string | null;
  packageCount: number;
  closedAt: Date;
}

export interface PackagingOrderDetail extends PackagingOrderRow {
  boxes: PackagingBoxRow[];
}

/** Consolidated detail: queue row + the order's boxes (auto-count source). */
export async function getPackagingOrderDetail(
  db: AppDb,
  orderId: string,
  opts?: { scope?: UserScopeEntry[] | null; username?: string }
): Promise<PackagingOrderDetail> {
  const row = await queryGet<PackagingOrderRow>(
    db,
    sql`
      SELECT
        po.id, po.order_no AS "orderNo", po.customer_code AS "customerCode",
        po.ship_to AS "shipTo", po.po_no AS "poNo",
        ${PACKAGING_COUNTS},
        pt.assignee,
        po.packaged_at AS "packagedAt", po.packaged_by AS "packagedBy",
        po.packed_weight AS "packedWeight", po.packed_box_count AS "packedBoxCount",
        po.packed_pallet_count AS "packedPalletCount",
        po.last_update_date AS "lastUpdateDate"
      FROM picking_orders po
      LEFT JOIN picking_tasks pt ON pt.picking_order_id = po.id AND pt.step = 'packaging'
      WHERE po.id = ${orderId}
      ${pickingOrderOrgFilter(sql`po.org_id`, sql`po.sub_inventory_code`, sql`po.picking_order_type`, opts?.scope)}
      ${assigneeFilter(sql`pt.assignee`, opts?.username)}`
  );
  if (!row) throw new HTTPException(404, { message: "packaging_order_not_found" });

  const boxes = await queryAll<PackagingBoxRow>(
    db,
    sql`
      SELECT sb.id, sb.status, sb.gross_weight AS "grossWeight", sb.net_weight AS "netWeight",
             sb.box_size AS "boxSize", sb.destination_country AS "destinationCountry",
             COUNT(pp.id)::int AS "packageCount", sb.last_update_date AS "closedAt"
      FROM shipping_boxes sb
      JOIN picking_packages pp ON pp.shipping_box_id = sb.id
      WHERE pp.picking_order_id = ${orderId}
      GROUP BY sb.id
      ORDER BY sb.id`
  );
  return { ...row, boxes };
}

/**
 * Confirm packaging (one confirm per order): re-checks the pending predicate
 * in-tx (409 packaging_not_ready — also covers double-confirm), validates the
 * payload, recomputes the box count server-side (auto count is guaranteed),
 * stamps the packaged columns + audit row. No stock movement.
 */
export async function confirmPackaging(
  db: AppDb,
  input: { orderId: string; weight: number; palletCount: number | null; actorId: string }
): Promise<{ id: string; boxCount: number }> {
  const weight = Math.round(input.weight * 1000) / 1000; // kg, ≤3 dp (same rule as box gross_weight)
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new HTTPException(400, { message: "invalid_weight" });
  }
  if (input.palletCount !== null && !(Number.isInteger(input.palletCount) && input.palletCount >= 1)) {
    throw new HTTPException(400, { message: "invalid_pallet_count" });
  }
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT po.id, po.status FROM picking_orders po
          WHERE po.id = ${input.orderId} AND (${packagingPendingWhere()})`
    );
    if (!order) {
      const exists = await queryGet<{ id: string }>(tx, sql`SELECT id FROM picking_orders WHERE id = ${input.orderId}`);
      if (!exists) throw new HTTPException(404, { message: "packaging_order_not_found" });
      throw new HTTPException(409, { message: "packaging_not_ready" });
    }
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${input.actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    const boxRow = await queryGet<{ boxCount: number }>(
      tx,
      sql`SELECT COUNT(DISTINCT shipping_box_id)::int AS "boxCount"
          FROM picking_packages
          WHERE picking_order_id = ${order.id} AND shipping_box_id IS NOT NULL`
    );
    const boxCount = boxRow?.boxCount ?? 0;

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE picking_orders
          SET packaged_at = ${at}, packaged_by = ${input.actorId},
              packed_weight = ${weight}, packed_box_count = ${boxCount},
              packed_pallet_count = ${input.palletCount}, last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: order.id,
      fromState: "packaging_pending",
      toState: "packaged",
      actorId: input.actorId,
      metadata: { weight, boxCount, palletCount: input.palletCount },
    });
    await emitEvent(tx, {
      type: "picking.packaged",
      topics: ["/packaging-orders", "/picking-orders", "/shipping-orders"],
      data: { orderId: order.id, weight, boxCount, palletCount: input.palletCount, actorId: input.actorId },
    });
    return { id: order.id, boxCount };
  });
}
