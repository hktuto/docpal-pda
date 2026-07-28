import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet } from "./query.js";
import { isStepEnabled } from "../config.js";

// ---------------------------------------------------------------------------
// Config-aware shipping feed for the admin console (spec: docs/superpowers/
// specs/2026-07-28-verify-step-and-flow-step-config-design.md). Shipping is
// fed by whatever the enabled chain ends with:
//   verify enabled    → completed verify tasks
//   measuring enabled → completed measuring tasks
//   neither           → finished picking orders with no task rows
// The detail read is task-agnostic: order + boxes[packages] by picking order
// id (same shape as the measuring/verify detail).
// ---------------------------------------------------------------------------

export type ShippingSource = "verify" | "measuring" | "picking";

export interface ShippingOrderRow {
  source: ShippingSource;
  taskId: string | null;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  completedAt: Date;
}

/** The step the shipping feed is sourced from under the current flow config. */
export function shippingSource(): ShippingSource {
  if (isStepEnabled("verify")) return "verify";
  if (isStepEnabled("measuring")) return "measuring";
  return "picking";
}

/** Unified shipping list; the source depends on FLOW_STEPS_DISABLED (see header). */
export async function listShippingOrders(db: AppDb): Promise<ShippingOrderRow[]> {
  const source = shippingSource();
  if (source === "verify") {
    return queryAll<ShippingOrderRow>(
      db,
      sql`
        SELECT
          'verify' AS "source", vt.id AS "taskId", vt.picking_order_id AS "pickingOrderId",
          po.order_no AS "orderNo", po.ship_to AS "shipTo",
          COUNT(sb.id)::int AS "boxCount",
          COUNT(sb.id) FILTER (WHERE sb.status <> 'open')::int AS "closedBoxCount",
          vt.created_at AS "completedAt"
        FROM verify_tasks vt
        JOIN picking_orders po ON po.id = vt.picking_order_id
        LEFT JOIN shipping_boxes sb ON sb.picking_order_id = vt.picking_order_id
        WHERE vt.status = 'completed'
        GROUP BY vt.id, po.order_no, po.ship_to
        ORDER BY vt.created_at DESC, vt.id DESC
      `
    );
  }
  if (source === "measuring") {
    return queryAll<ShippingOrderRow>(
      db,
      sql`
        SELECT
          'measuring' AS "source", mt.id AS "taskId", mt.picking_order_id AS "pickingOrderId",
          po.order_no AS "orderNo", po.ship_to AS "shipTo",
          COUNT(sb.id)::int AS "boxCount",
          COUNT(sb.id) FILTER (WHERE sb.status <> 'open')::int AS "closedBoxCount",
          mt.created_at AS "completedAt"
        FROM measuring_tasks mt
        JOIN picking_orders po ON po.id = mt.picking_order_id
        LEFT JOIN shipping_boxes sb ON sb.picking_order_id = mt.picking_order_id
        WHERE mt.status = 'completed'
        GROUP BY mt.id, po.order_no, po.ship_to
        ORDER BY mt.created_at DESC, mt.id DESC
      `
    );
  }
  // Neither measuring nor verify: a finished order with no task row is ready
  // to ship. updated_at approximates the finish time (no finished_at column).
  return queryAll<ShippingOrderRow>(
    db,
    sql`
      SELECT
        'picking' AS "source", NULL AS "taskId", po.id AS "pickingOrderId",
        po.order_no AS "orderNo", po.ship_to AS "shipTo",
        COUNT(sb.id)::int AS "boxCount",
        COUNT(sb.id) FILTER (WHERE sb.status <> 'open')::int AS "closedBoxCount",
        po.updated_at AS "completedAt"
      FROM picking_orders po
      LEFT JOIN shipping_boxes sb ON sb.picking_order_id = po.id
      WHERE po.status = 'finished'
        AND NOT EXISTS (SELECT 1 FROM measuring_tasks mt WHERE mt.picking_order_id = po.id)
        AND NOT EXISTS (SELECT 1 FROM verify_tasks vt WHERE vt.picking_order_id = po.id)
      GROUP BY po.id
      ORDER BY po.updated_at DESC, po.id DESC
    `
  );
}

export interface ShippingOrderDetailOrderRow {
  id: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  poNo: string | null;
}

export interface ShippingPackageRow {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  partNo: string;
  wclItemNo: string | null;
}

export interface ShippingBoxDetailRow {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  packages: ShippingPackageRow[];
}

export interface ShippingOrderDetail {
  order: ShippingOrderDetailOrderRow;
  boxes: ShippingBoxDetailRow[];
}

/** Task-agnostic detail: order + boxes with their packages (part identity embedded). */
export async function getShippingOrderDetail(db: AppDb, pickingOrderId: string): Promise<ShippingOrderDetail> {
  const order = await queryGet<ShippingOrderDetailOrderRow>(
    db,
    sql`SELECT id, order_no AS "orderNo", status, ship_to AS "shipTo",
               customer_code AS "customerCode",
               po_no AS "poNo"
        FROM picking_orders WHERE id = ${pickingOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "picking_order_not_found" });

  const boxes = await queryAll<Omit<ShippingBoxDetailRow, "packages">>(
    db,
    sql`SELECT id, status, box_size AS "boxSize",
               gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry"
        FROM shipping_boxes WHERE picking_order_id = ${order.id}
        ORDER BY created_at, id`
  );
  const boxIds = boxes.map((b) => b.id);

  const packages = boxIds.length
    ? await queryAll<ShippingPackageRow & { shippingBoxId: string }>(
        db,
        sql`
          SELECT
            pp.id, pp.shipping_box_id AS "shippingBoxId", pp.qty,
            pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
            pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo"
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN parts p ON p.part_no = pi.part_no
          WHERE ${inArray(sql`pp.shipping_box_id`, boxIds)}
          ORDER BY pp.created_at, pp.id
        `
      )
    : [];

  return {
    order,
    boxes: boxes.map((b) => ({
      ...b,
      packages: packages.filter((p) => p.shippingBoxId === b.id).map(({ shippingBoxId: _shippingBoxId, ...rest }) => rest),
    })),
  };
}
