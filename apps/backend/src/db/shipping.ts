import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { isStepEnabled } from "../config.js";

// ---------------------------------------------------------------------------
// Per-box shipping feed for the admin console (2026-08-11 box-scoped design).
// Shipping follows the BOX, not the order: the feed lists closed, unshipped
// boxes — gated on the box's completed verify task when the verify step is
// enabled ("measured" ≡ closed). Shipping stamps the box (shipped_at /
// shipped_by); a picking order derives 'shipped' once all its items are
// boxed, no package is unboxed, and every box holding its packages is
// shipped. A box may hold packages from several orders (cross-order packing).
// ---------------------------------------------------------------------------

export interface ShippingOrderRow {
  boxId: string;
  orderNos: string[];
  shipTos: string[];
  destinationCountry: string | null;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  packageCount: number;
  closedAt: Date;
}

/** SQL predicate shared by the feed and shipShippingBox's readiness re-check. */
function readyToShipWhere() {
  return sql`sb.status = 'closed' AND sb.shipped_at IS NULL
    AND (${!isStepEnabled("verify")} OR EXISTS (
      SELECT 1 FROM verify_tasks vt WHERE vt.shipping_box_id = sb.id AND vt.status = 'completed'))`;
}

/** Shipping feed: closed, unshipped boxes (verify-gated when the step is on). */
export async function listShippingOrders(db: AppDb): Promise<ShippingOrderRow[]> {
  return queryAll<ShippingOrderRow>(
    db,
    sql`
      SELECT
        sb.id AS "boxId",
        COALESCE(array_agg(DISTINCT po.order_no) FILTER (WHERE po.order_no IS NOT NULL), '{}') AS "orderNos",
        COALESCE(array_agg(DISTINCT po.ship_to) FILTER (WHERE po.ship_to IS NOT NULL), '{}') AS "shipTos",
        sb.destination_country AS "destinationCountry",
        sb.box_size AS "boxSize", sb.gross_weight AS "grossWeight", sb.net_weight AS "netWeight",
        COUNT(pp.id)::int AS "packageCount",
        sb.last_update_date AS "closedAt"
      FROM shipping_boxes sb
      LEFT JOIN picking_packages pp ON pp.shipping_box_id = sb.id
      LEFT JOIN picking_items pi ON pi.id = pp.picking_item_id
      LEFT JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE ${readyToShipWhere()}
      GROUP BY sb.id
      ORDER BY sb.last_update_date DESC, sb.id DESC
    `
  );
}

export interface ShippingOrderDetailBoxRow {
  boxId: string;
  pickingOrderId: string | null;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  shippedAt: Date | null;
  shippedBy: string | null;
  createdDate: Date;
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

export interface ShippingOrderDetailOrderRow {
  id: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  poNo: string | null;
}

export interface ShippingOrderDetail {
  box: ShippingOrderDetailBoxRow;
  packages: ShippingPackageRow[];
  orders: ShippingOrderDetailOrderRow[];
}

/** Box detail: the box + its packages (part identity) + the orders involved. */
export async function getShippingOrderDetail(db: AppDb, boxId: string): Promise<ShippingOrderDetail> {
  const box = await queryGet<ShippingOrderDetailBoxRow>(
    db,
    sql`SELECT id AS "boxId", picking_order_id AS "pickingOrderId", status,
               box_size AS "boxSize", gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry",
               shipped_at AS "shippedAt", shipped_by AS "shippedBy", created_date AS "createdDate"
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping_box_not_found" });

  const packages = await queryAll<ShippingPackageRow>(
    db,
    sql`
      SELECT
        pp.id, pp.qty,
        pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
        pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN parts p ON p.wcl_item_no = pi.part_no
      WHERE pp.shipping_box_id = ${boxId}
      ORDER BY pp.created_date, pp.id
    `
  );

  const orders = await queryAll<ShippingOrderDetailOrderRow>(
    db,
    sql`
      SELECT DISTINCT
        po.id, po.order_no AS "orderNo", po.status, po.ship_to AS "shipTo",
        po.customer_code AS "customerCode", po.po_no AS "poNo"
      FROM picking_orders po
      JOIN picking_packages pp ON pp.picking_order_id = po.id
      WHERE pp.shipping_box_id = ${boxId}
      ORDER BY po.order_no
    `
  );

  return { box, packages, orders };
}

/**
 * Ship a box that is currently in the feed: re-checks the readiness predicate
 * (409 `box_not_ready_to_ship`), stamps shipped_at/shipped_by + transition
 * log, then derives order 'shipped' for every order whose items are all fully
 * boxed, has no unboxed packages, and has no packages left in unshipped
 * boxes. Emits `shipping_box.shipped` on /shipping-orders + /picking-orders.
 */
export async function shipShippingBox(
  db: AppDb,
  boxId: string,
  actorId: string
): Promise<{ id: string; status: string; shippedOrderIds: string[] }> {
  return db.transaction(async (tx) => {
    const box = await queryGet<{ id: string }>(
      tx,
      sql`SELECT sb.id FROM shipping_boxes sb WHERE sb.id = ${boxId} AND ${readyToShipWhere()}`
    );
    if (!box) {
      const exists = await queryGet<{ id: string }>(tx, sql`SELECT id FROM shipping_boxes WHERE id = ${boxId}`);
      if (!exists) throw new HTTPException(404, { message: "shipping_box_not_found" });
      throw new HTTPException(409, { message: "box_not_ready_to_ship" });
    }
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE shipping_boxes SET shipped_at = ${at}, shipped_by = ${actorId}, last_update_date = ${at} WHERE id = ${box.id}`
    );
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "shipping_box",
      entityId: box.id,
      fromState: "closed",
      toState: "shipped",
      actorId,
      metadata: {},
      createdDate: at,
    });

    // Derive order 'shipped': every item fully boxed, nothing unboxed, and no
    // package left in an unshipped box.
    const orderIds = await queryAll<{ id: string }>(
      tx,
      sql`SELECT DISTINCT picking_order_id AS id FROM picking_packages WHERE shipping_box_id = ${box.id}`
    );
    const shippedOrderIds: string[] = [];
    for (const { id: orderId } of orderIds) {
      const order = await queryGet<{ id: string; status: string }>(
        tx,
        sql`SELECT id, status FROM picking_orders WHERE id = ${orderId}`
      );
      if (!order || order.status === "shipped") continue;
      const notFullyBoxed = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM picking_items WHERE picking_order_id = ${order.id} AND picked_qty < qty LIMIT 1`
      );
      if (notFullyBoxed) continue;
      const unboxed = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM picking_packages WHERE picking_order_id = ${order.id} AND shipping_box_id IS NULL LIMIT 1`
      );
      if (unboxed) continue;
      const unshippedBox = await queryGet<{ id: string }>(
        tx,
        sql`SELECT sb.id FROM picking_packages pp
            JOIN shipping_boxes sb ON sb.id = pp.shipping_box_id
            WHERE pp.picking_order_id = ${order.id} AND sb.shipped_at IS NULL LIMIT 1`
      );
      if (unshippedBox) continue;

      await queryRun(
        tx,
        sql`UPDATE picking_orders
            SET status = 'shipped', shipped_at = ${at}, shipped_by = ${actorId}, last_update_date = ${at}
            WHERE id = ${order.id}`
      );
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "picking_order",
        entityId: order.id,
        fromState: order.status,
        toState: "shipped",
        actorId,
        metadata: { shipping_box: box.id },
        createdDate: at,
      });
      shippedOrderIds.push(order.id);
    }

    await emitEvent(tx, {
      type: "shipping_box.shipped",
      topics: ["/shipping-orders", "/picking-orders"],
      data: { shippingBoxId: box.id, shippedOrderIds, actorId },
    });
    return { id: box.id, status: "shipped", shippedOrderIds };
  });
}
