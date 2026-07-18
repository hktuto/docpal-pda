import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  applyPick,
  assignPackageToBox,
  createAllocation,
  recomputeLot,
  recomputePickingItem,
  scanToPackage,
  unassignPackageFromBox,
} from "./invariants.js";
import { logTransition } from "../ingest/transition.js";
import { queryAll, queryGet, queryRun } from "./query.js";

// NOTE: like invariants.ts, timestamps are written with SQL now() — a JS Date in
// a raw sql`` param is never serialized by the drizzle-wrapped client.

/** Stock change in a shelf box: drop item verifications and revert a verified box to closed. */
async function markShelfBoxStockChanged(tx: DbOrTx, shelfBoxId: string): Promise<void> {
  await queryRun(tx, sql`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${shelfBoxId}`);
  await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

async function reduceAllocation(tx: DbOrTx, allocationId: string, qty: number): Promise<void> {
  await queryRun(tx, sql`UPDATE allocations SET qty = qty - ${qty}, updated_at = now() WHERE id = ${allocationId}`);
  const a = await queryGet<{ pickingItemId: string; inventoryLotId: string | null }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId", inventory_lot_id AS "inventoryLotId" FROM allocations WHERE id = ${allocationId}`
  );
  if (a) {
    await recomputePickingItem(tx, a.pickingItemId);
    if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
  }
}

/** Find-or-create the single-level allocation for (picking item, source) and add qty back. */
async function bumpAllocation(
  tx: DbOrTx,
  a: { pickingItemId: string; qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string }
): Promise<void> {
  const existing = await queryGet<{ id: string }>(
    tx,
    a.inventoryLotId
      ? sql`SELECT id FROM allocations WHERE picking_item_id = ${a.pickingItemId} AND inventory_lot_id = ${a.inventoryLotId}`
      : sql`SELECT id FROM allocations WHERE picking_item_id = ${a.pickingItemId} AND receiving_invoice_item_id = ${a.receivingInvoiceItemId}`
  );
  if (existing) {
    await queryRun(tx, sql`UPDATE allocations SET qty = qty + ${a.qty}, updated_at = now() WHERE id = ${existing.id}`);
    await recomputePickingItem(tx, a.pickingItemId);
    if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
  } else {
    await createAllocation(tx, {
      id: crypto.randomUUID(),
      pickingItemId: a.pickingItemId,
      qty: a.qty,
      inventoryLotId: a.inventoryLotId ?? null,
      receivingInvoiceItemId: a.receivingInvoiceItemId ?? null,
    });
  }
}

/**
 * Scan qty off a single-level allocation into one package. The allocation
 * points directly at its source: an inventory lot XOR a receiving invoice item.
 */
export async function scanAllocation(
  tx: DbOrTx,
  a: { allocationId: string; qty: number; actorId?: string | null }
): Promise<{ packageIds: string[] }> {
  const alloc = await queryGet<{ id: string; pickingItemId: string; qty: number; lotId: string | null; riiId: string | null }>(
    tx,
    sql`SELECT id, picking_item_id AS "pickingItemId", qty, inventory_lot_id AS "lotId", receiving_invoice_item_id AS "riiId"
        FROM allocations WHERE id = ${a.allocationId}`
  );
  if (!alloc) throw new HTTPException(404, { message: "allocation not found" });
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });

  // picked (boxed) + unboxed = Σ ALL packages; "remaining" is computed, not stored.
  const item = (await queryGet<{ id: string; pickingOrderId: string; qty: number; packagedQty: number }>(
    tx,
    sql`SELECT pi.id, pi.picking_order_id AS "pickingOrderId", pi.qty,
          COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS "packagedQty"
        FROM picking_items pi WHERE pi.id = ${alloc.pickingItemId}`
  ))!;
  const order = (await queryGet<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM picking_orders WHERE id = ${item.pickingOrderId}`
  ))!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
  if (a.qty > alloc.qty) throw new HTTPException(409, { message: `qty ${a.qty} exceeds allocation ${alloc.qty}` });
  if (item.packagedQty + a.qty > item.qty)
    throw new HTTPException(409, { message: "scan quantity exceeds required" });

  const packageIds: string[] = [];

  if (alloc.lotId) {
    const lot = (await queryGet<{ id: string; totalQty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; boxId: string | null }>(
      tx,
      sql`SELECT id, total_qty AS "totalQty", date_code AS "dateCode", lot_code AS "lotCode", coo, cow, box_id AS "boxId" FROM inventory_lots WHERE id = ${alloc.lotId}`
    ))!;
    if (lot.totalQty < a.qty) throw new HTTPException(409, { message: "insufficient lot quantity" });
    await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty - ${a.qty} WHERE id = ${lot.id}`);
    if (lot.boxId) await markShelfBoxStockChanged(tx, lot.boxId);
    await reduceAllocation(tx, alloc.id, a.qty); // allocations.qty -= qty; recomputeLot -> allocated = Σ allocations
    const pid = crypto.randomUUID();
    await scanToPackage(tx, {
      id: pid,
      pickingItemId: item.id,
      qty: a.qty,
      sourceType: "inventory_lot",
      sourceId: lot.id,
      dateCode: lot.dateCode,
      lotCode: lot.lotCode,
      coo: lot.coo,
      cow: lot.cow,
    });
    packageIds.push(pid);
  } else if (alloc.riiId) {
    const rii = (await queryGet<{ dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
      tx,
      sql`SELECT date_code AS "dateCode", lot_code AS "lotCode", coo, cow FROM receiving_invoice_items WHERE id = ${alloc.riiId}`
    ))!;
    await applyPick(tx, alloc.riiId, a.qty); // rii.picked_qty += qty (availability is computed, not stored)
    await reduceAllocation(tx, alloc.id, a.qty);
    const pid = crypto.randomUUID();
    await scanToPackage(tx, {
      id: pid,
      pickingItemId: item.id,
      qty: a.qty,
      sourceType: "receiving_invoice_item",
      sourceId: alloc.riiId,
      dateCode: rii.dateCode,
      lotCode: rii.lotCode,
      coo: rii.coo,
      cow: rii.cow,
    });
    packageIds.push(pid);
  } else {
    throw new HTTPException(409, { message: "allocation has no source" });
  }

  if (order.status === "pending") {
    await queryRun(tx, sql`UPDATE picking_orders SET status = 'picking', updated_at = now() WHERE id = ${order.id}`);
    await logTransition(tx, { entityType: "picking_order", entityId: order.id, fromState: "pending", toState: "picking", actorId: a.actorId ?? null });
  }
  await logTransition(tx, {
    entityType: "picking_item",
    entityId: item.id,
    fromState: "picking",
    toState: "scanned",
    actorId: a.actorId ?? null,
    metadata: { qty: a.qty, allocation: alloc.id },
  });

  return { packageIds };
}

export async function removeScannedPackage(tx: DbOrTx, p: { packageId: string; actorId?: string | null }): Promise<void> {
  const pkg = await queryGet<{ id: string; pickingItemId: string; sourceType: string; sourceId: string; qty: number; shippingBoxId: string | null }>(
    tx,
    sql`SELECT id, picking_item_id AS "pickingItemId", source_type AS "sourceType", source_id AS "sourceId", qty, shipping_box_id AS "shippingBoxId"
        FROM picking_packages WHERE id = ${p.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });

  const item = (await queryGet<{ id: string; pickingOrderId: string }>(
    tx,
    sql`SELECT id, picking_order_id AS "pickingOrderId" FROM picking_items WHERE id = ${pkg.pickingItemId}`
  ))!;
  const order = (await queryGet<{ status: string }>(tx, sql`SELECT status FROM picking_orders WHERE id = ${item.pickingOrderId}`))!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });

  if (pkg.sourceType === "inventory_lot") {
    const lot = await queryGet<{ id: string; boxId: string | null }>(tx, sql`SELECT id, box_id AS "boxId" FROM inventory_lots WHERE id = ${pkg.sourceId}`);
    if (!lot) throw new HTTPException(404, { message: "inventory lot not found" });
    await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty} WHERE id = ${lot.id}`);
    if (lot.boxId) await markShelfBoxStockChanged(tx, lot.boxId);
    await bumpAllocation(tx, { pickingItemId: pkg.pickingItemId, qty: pkg.qty, inventoryLotId: lot.id });
  } else if (pkg.sourceType === "receiving_invoice_item") {
    const rii = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM receiving_invoice_items WHERE id = ${pkg.sourceId}`
    );
    if (!rii) throw new HTTPException(404, { message: "receiving invoice item not found" });
    await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty} WHERE id = ${pkg.sourceId}`);
    await bumpAllocation(tx, { pickingItemId: pkg.pickingItemId, qty: pkg.qty, receivingInvoiceItemId: pkg.sourceId });
  } else {
    throw new HTTPException(409, { message: "unknown package source type" });
  }

  await queryRun(tx, sql`DELETE FROM picking_packages WHERE id = ${pkg.id}`);
  await recomputePickingItem(tx, pkg.pickingItemId);
  await logTransition(tx, {
    entityType: "picking_item",
    entityId: pkg.pickingItemId,
    fromState: "scanned",
    toState: "removed",
    actorId: p.actorId ?? null,
    metadata: { qty: pkg.qty, package: pkg.id },
  });
}

async function loadOrderForWrite(tx: DbOrTx, orderId: string): Promise<{ id: string; status: string }> {
  const order = await queryGet<{ id: string; status: string }>(tx, sql`SELECT id, status FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });
  return order;
}

function assertOrderWritable(order: { status: string }): void {
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
}

export async function createShippingBox(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): Promise<string> {
  const order = await loadOrderForWrite(tx, a.pickingOrderId);
  assertOrderWritable(order);
  const id = crypto.randomUUID();
  await queryRun(
    tx,
    sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at)
        VALUES (${id}, ${a.pickingOrderId}, 'open', now(), now())`
  );
  await logTransition(tx, {
    entityType: "shipping_box",
    entityId: id,
    fromState: null,
    toState: "open",
    actorId: a.actorId ?? null,
    metadata: { picking_order: a.pickingOrderId },
  });
  return id;
}

export async function cancelShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): Promise<void> {
  const box = await queryGet<{ id: string; status: string; pickingOrderId: string }>(
    tx,
    sql`SELECT id, status, picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${a.shippingBoxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const used = (await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM picking_packages WHERE shipping_box_id = ${box.id}`))!;
  if (used.c > 0) throw new HTTPException(409, { message: "box is not empty" });
  await queryRun(tx, sql`DELETE FROM shipping_boxes WHERE id = ${box.id}`);
  await logTransition(tx, {
    entityType: "shipping_box",
    entityId: box.id,
    fromState: box.status,
    toState: "cancelled",
    actorId: a.actorId ?? null,
    metadata: { picking_order: box.pickingOrderId },
  });
}

/** Finish order + create measuring task when fully boxed. Call only after picked_qty is fresh (i.e., after a recomputePickingItem-emitting mutation in this tx). */
export async function maybeAutoFinishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): Promise<boolean> {
  const order = await queryGet<{ id: string; status: string }>(tx, sql`SELECT id, status FROM picking_orders WHERE id = ${a.pickingOrderId}`);
  if (!order) return false;
  if (order.status !== "pending" && order.status !== "picking") return false;
  const items = await queryAll<{ qty: number; pickedQty: number }>(
    tx,
    sql`SELECT qty, picked_qty AS "pickedQty" FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) return false;
  if (!items.every((i) => i.pickedQty >= i.qty)) return false;

  await queryRun(tx, sql`UPDATE picking_orders SET status = 'finished', updated_at = now() WHERE id = ${order.id}`);
  await queryRun(
    tx,
    sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at)
        VALUES (${crypto.randomUUID()}, ${order.id}, 'pending', now())
        ON CONFLICT (picking_order_id) DO NOTHING`
  );
  await logTransition(tx, { entityType: "picking_order", entityId: order.id, fromState: order.status, toState: "finished", actorId: a.actorId ?? null });
  return true;
}

export async function finishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): Promise<void> {
  const order = await loadOrderForWrite(tx, a.pickingOrderId);
  assertOrderWritable(order);
  const items = await queryAll<{ qty: number; pickedQty: number }>(
    tx,
    sql`SELECT qty, picked_qty AS "pickedQty" FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) throw new HTTPException(409, { message: "no items to pick" });
  if (!items.every((i) => i.pickedQty >= i.qty)) throw new HTTPException(409, { message: "not all items fully boxed" });
  const done = await maybeAutoFinishPickingOrder(tx, a);
  if (!done) throw new HTTPException(409, { message: "picking order could not be finished" });
}

async function loadBoxForPack(tx: DbOrTx, boxId: string): Promise<{ id: string; status: string; pickingOrderId: string }> {
  const box = await queryGet<{ id: string; status: string; pickingOrderId: string }>(
    tx,
    sql`SELECT id, status, picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  return box;
}

export async function addPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string; actorId?: string | null }): Promise<void> {
  const pkg = await queryGet<{ id: string; pickingItemId: string; pickingOrderId: string; shippingBoxId: string | null; qty: number }>(
    tx,
    sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pi.picking_order_id AS "pickingOrderId", pp.shipping_box_id AS "shippingBoxId", pp.qty
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });
  const box = await loadBoxForPack(tx, a.shippingBoxId);
  if (box.pickingOrderId !== pkg.pickingOrderId) throw new HTTPException(409, { message: "package does not belong to this picking order" });
  const order = await loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);

  await assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id }); // sets box + recomputePickingItem (picked up, scanned down)
  await logTransition(tx, {
    entityType: "picking_item",
    entityId: pkg.pickingItemId,
    fromState: "scanned",
    toState: "boxed",
    actorId: a.actorId ?? null,
    metadata: { qty: pkg.qty, box: box.id },
  });
  await maybeAutoFinishPickingOrder(tx, { pickingOrderId: pkg.pickingOrderId, actorId: a.actorId ?? null });
}

export async function addAllUnboxedToBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): Promise<number> {
  const box = await loadBoxForPack(tx, a.shippingBoxId);
  const order = await loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);
  const packages = await queryAll<{ id: string; pickingItemId: string; qty: number }>(
    tx,
    sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pp.qty FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
        WHERE pi.picking_order_id = ${box.pickingOrderId} AND pp.shipping_box_id IS NULL ORDER BY pp.created_at ASC, pp.id ASC`
  );
  for (const pkg of packages) {
    await assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id });
    await logTransition(tx, {
      entityType: "picking_item",
      entityId: pkg.pickingItemId,
      fromState: "scanned",
      toState: "boxed",
      actorId: a.actorId ?? null,
      metadata: { qty: pkg.qty, box: box.id },
    });
  }
  await maybeAutoFinishPickingOrder(tx, { pickingOrderId: box.pickingOrderId, actorId: a.actorId ?? null });
  return packages.length;
}

export async function removePackageFromBox(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): Promise<void> {
  const pkg = await queryGet<{ id: string; pickingItemId: string; shippingBoxId: string | null; qty: number }>(
    tx,
    sql`SELECT id, picking_item_id AS "pickingItemId", shipping_box_id AS "shippingBoxId", qty FROM picking_packages WHERE id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = await loadBoxForPack(tx, pkg.shippingBoxId);
  const order = await loadOrderForWrite(tx, box.pickingOrderId);
  // only 'issue' is blocked: unpacking a finished order is allowed (measuring-time correction); re-packing is blocked by assertOrderWritable in the add paths.
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });

  await unassignPackageFromBox(tx, { packageId: pkg.id }); // clears box + drops the shipping_box_items mirror row
  await logTransition(tx, {
    entityType: "picking_item",
    entityId: pkg.pickingItemId,
    fromState: "boxed",
    toState: "scanned",
    actorId: a.actorId ?? null,
    metadata: { qty: pkg.qty, box: box.id },
  });
}
