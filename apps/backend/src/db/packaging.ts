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

export interface PackedCartEntry {
  boxCount: number;
  weight: number;
}

/** Confirm payload (spec 2026-11-16-packaging-box-cart-modes-design.md):
 *  box mode = operator-entered 打包記錄 box count + total weight; pallet
 *  (卡板) mode = one row per cart, each with its box count + weight. */
export type ConfirmPackagingInput =
  | { mode: "box"; weight: number; boxCount: number | null; palletCount?: number | null }
  | { mode: "pallet"; pallets: PackedCartEntry[] };

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
  /** Box mode: operator-entered 打包記錄 box count; cart mode: Σ cart boxCount.
   *  NULL = legacy confirm (pre-2026-11-16). Never overrides the scan records. */
  packedInputBoxCount: number | null;
  /** Cart mode array [{boxCount, weight}] (array order = cart number). */
  packedCarts: PackedCartEntry[] | null;
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
        po.packed_input_box_count AS "packedInputBoxCount",
        po.packed_carts AS "packedCarts",
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
        po.packed_input_box_count AS "packedInputBoxCount",
        po.packed_carts AS "packedCarts",
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
 * Validate a confirm payload (spec 2026-11-16-packaging-box-cart-modes-design.md).
 * Returns the typed input or throws the snake_code error. kg weights are
 * rounded to ≤3 dp (same rule as box gross_weight).
 */
export function parseConfirmPackagingInput(raw: {
  weight?: unknown;
  boxCount?: unknown;
  pallets?: unknown;
}): ConfirmPackagingInput {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const finitePos = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? round3(v) : null;
  const intMin1 = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
  if (Array.isArray(raw.pallets)) {
    // Cart (卡板) mode: one row per cart, each with box count + weight.
    if (raw.pallets.length < 1) throw new HTTPException(400, { message: "invalid_pallets" });
    const pallets = raw.pallets.map((p) => {
      const boxCount = intMin1((p as { boxCount?: unknown } | null)?.boxCount);
      if (boxCount === null) throw new HTTPException(400, { message: "invalid_pallets" });
      const weight = finitePos((p as { weight?: unknown } | null)?.weight);
      if (weight === null) throw new HTTPException(400, { message: "invalid_pallets" });
      return { boxCount, weight };
    });
    return { mode: "pallet", pallets };
  }
  // Box mode (also the legacy single-weight payload shape).
  const weight = finitePos(raw.weight);
  if (weight === null) throw new HTTPException(400, { message: "invalid_weight" });
  if (raw.boxCount !== undefined && raw.boxCount !== null) {
    const boxCount = intMin1(raw.boxCount);
    if (boxCount === null) throw new HTTPException(400, { message: "invalid_box_count" });
    return { mode: "box", weight, boxCount };
  }
  return { mode: "box", weight, boxCount: null };
}

/**
 * Confirm packaging (one confirm per order): re-checks the pending predicate
 * in-tx (409 packaging_not_ready — also covers double-confirm), validates the
 * payload, recomputes the box count server-side (auto count is guaranteed —
 * the operator's 打包記錄 box count rides alongside in packed_input_box_count,
 * never overriding the scan records), stamps the packaged columns + audit row.
 * Cart mode derives the scalar columns (pallet count = rows, weight = Σ,
 * input box count = Σ boxCount) so read-back pages stay scalar-first.
 * No stock movement.
 */
export async function confirmPackaging(
  db: AppDb,
  params: { orderId: string; input: ConfirmPackagingInput; actorId: string }
): Promise<{ id: string; boxCount: number }> {
  const input = params.input;
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT po.id, po.status FROM picking_orders po
          WHERE po.id = ${params.orderId} AND (${packagingPendingWhere()})`
    );
    if (!order) {
      const exists = await queryGet<{ id: string }>(tx, sql`SELECT id FROM picking_orders WHERE id = ${params.orderId}`);
      if (!exists) throw new HTTPException(404, { message: "packaging_order_not_found" });
      throw new HTTPException(409, { message: "packaging_not_ready" });
    }
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${params.actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    const boxRow = await queryGet<{ boxCount: number }>(
      tx,
      sql`SELECT COUNT(DISTINCT shipping_box_id)::int AS "boxCount"
          FROM picking_packages
          WHERE picking_order_id = ${order.id} AND shipping_box_id IS NOT NULL`
    );
    const boxCount = boxRow?.boxCount ?? 0;

    // Cart (卡板) mode: store the array + derived scalars. Box mode: total
    // weight + the operator's 打包記錄 box count (legacy confirms have no
    // input count — packed_input_box_count stays NULL; their optional pallet
    // count rides through in palletCount). Auto box count is always
    // recomputed server-side — the input never overrides the scan records.
    const isCart = input.mode === "pallet";
    const palletCount = isCart ? input.pallets.length : (input.palletCount ?? null);
    const weight = isCart
      ? Math.round(input.pallets.reduce((s, p) => s + p.weight, 0) * 1000) / 1000
      : input.weight;
    const inputBoxCount = isCart
      ? input.pallets.reduce((s, p) => s + p.boxCount, 0)
      : input.boxCount;
    const carts = isCart ? input.pallets : null;

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE picking_orders
          SET packaged_at = ${at}, packaged_by = ${params.actorId},
              packed_weight = ${weight}, packed_box_count = ${boxCount},
              packed_pallet_count = ${palletCount},
              packed_input_box_count = ${inputBoxCount},
              packed_carts = ${carts ? JSON.stringify(carts) : null},
              last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: order.id,
      fromState: "packaging_pending",
      toState: "packaged",
      actorId: params.actorId,
      metadata: { mode: input.mode, weight, boxCount, palletCount, input: input },
    });
    await emitEvent(tx, {
      type: "picking.packaged",
      topics: ["/packaging-orders", "/picking-orders", "/shipping-orders"],
      data: { orderId: order.id, mode: input.mode, weight, boxCount, palletCount, input, actorId: params.actorId },
    });
    return { id: order.id, boxCount };
  });
}
