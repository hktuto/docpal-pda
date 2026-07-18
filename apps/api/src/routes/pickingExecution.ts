import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ScanResponse } from "@warehouse/shared";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet, queryRun } from "../db/query.js";
import {
  scanAllocation,
  removeScannedPackage,
  createShippingBox,
  cancelShippingBox,
  addPackageToBox,
  addAllUnboxedToBox,
  removePackageFromBox,
  finishPickingOrder,
} from "../db/pickScan.js";
import { verifyPackage } from "../db/measure.js";

export const pickingExecutionRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

pickingExecutionRoute.post("/picking-orders/:id/scan", async (c) => {
  const orderId = c.req.param("id");
  const body = await readJson<{ allocation_id?: string; qty?: number; actor_id?: string | null }>(c);
  if (!body.allocation_id) throw new HTTPException(400, { message: "allocation_id is required" });
  const result = await db.transaction(async (tx) => {
    const order = await queryGet<{ id: string }>(tx, sql`SELECT id FROM picking_orders WHERE id = ${orderId}`);
    if (!order) throw new HTTPException(404, { message: "picking order not found" });
    const owner = await queryGet<{ ok: number }>(tx, sql`
      SELECT 1 AS ok FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE a.id = ${body.allocation_id} AND pi.picking_order_id = ${orderId}`);
    if (!owner) throw new HTTPException(404, { message: "allocation not found in this order" });
    return await scanAllocation(tx, { allocationId: body.allocation_id!, qty: body.qty as number, actorId: body.actor_id ?? null });
  });
  const res: ScanResponse = { package_ids: result.packageIds };
  return c.json(res, 201);
});

pickingExecutionRoute.delete("/picking-orders/:id/packages/:package_id", async (c) => {
  const orderId = c.req.param("id");
  const packageId = c.req.param("package_id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => {
    const pkg = await queryGet<{ pickingOrderId: string }>(tx, sql`
      SELECT pi.picking_order_id AS "pickingOrderId" FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${packageId}`);
    if (!pkg || pkg.pickingOrderId !== orderId) throw new HTTPException(404, { message: "package not found in this order" });
    await removeScannedPackage(tx, { packageId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes", async (c) => {
  const orderId = c.req.param("id");
  const raw = await c.req.text();
  let actorId: string | null = null;
  if (raw.trim() !== "") {
    let body: { actor_id?: string | null };
    try { body = JSON.parse(raw); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
    actorId = body.actor_id ?? null;
  }
  const boxId = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: orderId, actorId }));
  return c.json({ id: boxId }, 201);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/cancel", async (c) => {
  const orderId = c.req.param("id");
  const boxId = c.req.param("box_id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => {
    const box = await queryGet<{ pickingOrderId: string }>(tx, sql`SELECT picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${boxId}`);
    if (!box || box.pickingOrderId !== orderId) throw new HTTPException(404, { message: "box not found in this order" });
    await cancelShippingBox(tx, { shippingBoxId: boxId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/packages", async (c) => {
  const orderId = c.req.param("id");
  const boxId = c.req.param("box_id");
  const body = await readJson<{ package_id?: string; actor_id?: string | null }>(c);
  if (!body.package_id) throw new HTTPException(400, { message: "package_id is required" });
  await db.transaction(async (tx) => {
    const box = await queryGet<{ pickingOrderId: string }>(tx, sql`SELECT picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${boxId}`);
    if (!box || box.pickingOrderId !== orderId) throw new HTTPException(404, { message: "box not found in this order" });
    await addPackageToBox(tx, { packageId: body.package_id!, shippingBoxId: boxId, actorId: body.actor_id ?? null });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/add-all-unboxed", async (c) => {
  const orderId = c.req.param("id");
  const boxId = c.req.param("box_id");
  const actorId = c.req.query("actor_id") ?? null;
  const n = await db.transaction(async (tx) => {
    const box = await queryGet<{ pickingOrderId: string }>(tx, sql`SELECT picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${boxId}`);
    if (!box || box.pickingOrderId !== orderId) throw new HTTPException(404, { message: "box not found in this order" });
    return await addAllUnboxedToBox(tx, { shippingBoxId: boxId, actorId });
  });
  return c.json({ packed: n }, 200);
});

pickingExecutionRoute.delete("/picking-orders/:id/boxes/:box_id/packages/:package_id", async (c) => {
  const orderId = c.req.param("id");
  const boxId = c.req.param("box_id");
  const packageId = c.req.param("package_id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => {
    const pkg = await queryGet<{ pickingOrderId: string; shippingBoxId: string | null }>(tx, sql`
      SELECT pi.picking_order_id AS "pickingOrderId", pp.shipping_box_id AS "shippingBoxId" FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${packageId}`);
    if (!pkg || pkg.pickingOrderId !== orderId || pkg.shippingBoxId !== boxId)
      throw new HTTPException(404, { message: "package not found in this box" });
    await removePackageFromBox(tx, { packageId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/finish", async (c) => {
  const orderId = c.req.param("id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => await finishPickingOrder(tx, { pickingOrderId: orderId, actorId }));
  return c.json({ ok: true }, 200);
});

// --- flat mutation routes: same db functions as the nested routes above, but
// the adapter doesn't know parent ids, so parents are resolved inside the db
// functions (scanAllocation loads allocation -> item -> order and validates
// order status itself; verifyPackage derives the box from the package). ---

pickingExecutionRoute.post("/allocations/:id/scan", async (c) => {
  const allocationId = c.req.param("id");
  const body = await readJson<{ qty?: number; actor_id?: string | null }>(c);
  const result = await db.transaction(async (tx) =>
    await scanAllocation(tx, { allocationId, qty: body.qty as number, actorId: body.actor_id ?? null })
  );
  const res: ScanResponse = { package_ids: result.packageIds };
  return c.json(res, 201);
});

pickingExecutionRoute.post("/packages/:id/add-to-box", async (c) => {
  const packageId = c.req.param("id");
  const body = await readJson<{ box_id?: string; actor_id?: string | null }>(c);
  if (!body.box_id) throw new HTTPException(400, { message: "box_id is required" });
  await db.transaction(async (tx) => await addPackageToBox(tx, { packageId, shippingBoxId: body.box_id!, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

// Both nested delete shapes are { ok: true }, so the flat route is too.
pickingExecutionRoute.delete("/packages/:id", async (c) => {
  const packageId = c.req.param("id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => {
    const pkg = await queryGet<{ shippingBoxId: string | null }>(tx,
      sql`SELECT shipping_box_id AS "shippingBoxId" FROM picking_packages WHERE id = ${packageId}`
    );
    if (!pkg) throw new HTTPException(404, { message: "package not found" });
    if (pkg.shippingBoxId !== null) await removePackageFromBox(tx, { packageId, actorId });
    else await removeScannedPackage(tx, { packageId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/packages/:id/verify", async (c) => {
  const packageId = c.req.param("id");
  const body = await readJson<{ actor_id?: string | null }>(c);
  await db.transaction(async (tx) => await verifyPackage(tx, { packageId, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/shipping-boxes/:id/cancel", async (c) => {
  const boxId = c.req.param("id");
  const actorId = c.req.query("actor_id") ?? null;
  await db.transaction(async (tx) => await cancelShippingBox(tx, { shippingBoxId: boxId, actorId }));
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.get("/picking-orders", async (c) => {
  const status = c.req.query("status");
  const updatedSince = c.req.query("updated_since");
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT po.id, po.ref_no, po.status, po.ship_to, po.destination_country,
           po.delivery_date, po.created_at, po.updated_at,
           s.name AS supplier_name,
           (SELECT COALESCE(SUM(pi.qty), 0)::int FROM picking_items pi WHERE pi.picking_order_id = po.id) AS total_qty
    FROM picking_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE (${status ?? null}::text IS NULL OR po.status = ${status ?? null}::text)
      AND (${updatedSince ?? null}::text IS NULL OR po.updated_at > ${updatedSince ?? null}::timestamp)
    ORDER BY CASE WHEN po.status = 'finished' THEN 1 ELSE 0 END, po.delivery_date ASC, po.id ASC`);
  return c.json(rows, 200);
});

pickingExecutionRoute.get("/picking-orders/:id", async (c) => {
  const orderId = c.req.param("id");
  const order = await queryGet<Record<string, unknown>>(db, sql`
    SELECT po.id, po.ref_no, po.status, po.ship_to, po.destination_country, po.delivery_date, po.created_at, po.updated_at,
           po.po_no, po.required_date_code_notice,
           po.issue_reason, po.issue_note, po.issue_qty, po.issue_pack_size, po.issue_remark,
           po.issue_reported_at, po.issue_reported_by, u.display_name AS issue_reported_by_name,
           s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name
    FROM picking_orders po LEFT JOIN users u ON u.id = po.issue_reported_by
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });

  const measuringTask = (await queryGet<Record<string, unknown>>(db, sql`
    SELECT id, status FROM measuring_tasks
    WHERE picking_order_id = ${orderId} ORDER BY created_at DESC LIMIT 1`)) ?? null;

  // remaining_qty and scanned_not_boxed_qty are computed on the fly (no stored
  // columns anymore): remaining = qty − Σ all packages; unboxed = Σ packages
  // with shipping_box_id IS NULL.
  const items = await queryAll<Record<string, unknown>>(db, sql`
    SELECT pi.id, pi.part_id, p.part_no, pi.qty, pi.picked_qty, pi.allocated_qty,
           pi.required_date_code, pi.source_shelf_code,
           pi.qty - COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS remaining_qty,
           COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL), 0) AS scanned_not_boxed_qty
    FROM picking_items pi JOIN parts p ON p.id = pi.part_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pi.created_at ASC, pi.id ASC`);

  // Single-level allocations: each row points at an inventory lot XOR a
  // receiving invoice item (the receiving order is derived through the item).
  const allocations = await queryAll<Record<string, unknown>>(db, sql`
    SELECT a.id, a.picking_item_id, a.qty, a.inventory_lot_id, a.receiving_invoice_item_id,
           ro.id AS receiving_order_id, ro.ref_no AS receiving_order_ref_no
    FROM allocations a JOIN picking_items pi ON pi.id = a.picking_item_id
    LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
    LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    LEFT JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
    WHERE pi.picking_order_id = ${orderId} AND a.qty > 0 ORDER BY a.created_at ASC, a.id ASC`);
  for (const a of allocations) {
    a.lot = a.inventory_lot_id
      ? (await queryGet<Record<string, unknown>>(db, sql`
          SELECT id, part_id, shelf_code, box_id, date_code, lot_code, coo, cow
          FROM inventory_lots WHERE id = ${a.inventory_lot_id}`)) ?? null
      : null;
    a.receiving_items = a.receiving_invoice_item_id
      ? await queryAll<Record<string, unknown>>(db, sql`
          SELECT a2.receiving_invoice_item_id, a2.qty, ri.invoice_no, rii.box_id,
                 rii.date_code, rii.lot_code, rii.coo, rii.cow
          FROM allocations a2
          JOIN receiving_invoice_items rii ON rii.id = a2.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE a2.id = ${a.id}`)
      : [];
  }

  const packages = await queryAll<Record<string, unknown>>(db, sql`
    SELECT pp.id, pp.picking_item_id, pp.source_type, pp.source_id, pp.qty, pp.shipping_box_id,
           pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified, pp.created_at
    FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pp.created_at ASC, pp.id ASC`);

  const boxes = await queryAll<Record<string, unknown>>(db, sql`
    SELECT id, status, box_size, net_weight, gross_weight, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE picking_order_id = ${orderId} ORDER BY created_at ASC, id ASC`);

  return c.json({ order, measuring_task: measuringTask, items, allocations, packages, boxes }, 200);
});
