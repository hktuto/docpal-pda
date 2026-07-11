import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  applyPick,
  assignPackageToBox,
  createAllocation,
  linkAllocation,
  recomputeLot,
  recomputePickingItem,
  recomputeReceivingItem,
  scanToPackage,
} from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

function reduceAllocation(tx: DbOrTx, allocationId: string, qty: number): void {
  tx.run(sql`UPDATE allocations SET qty = qty - ${qty}, updated_at = ${now()} WHERE id = ${allocationId}`);
  const a = tx.get<{ pickingItemId: string; inventoryLotId: string | null }>(
    sql`SELECT picking_item_id AS pickingItemId, inventory_lot_id AS inventoryLotId FROM allocations WHERE id = ${allocationId}`
  );
  if (a) {
    recomputePickingItem(tx, a.pickingItemId);
    if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
  }
}

export function scanAllocation(
  tx: DbOrTx,
  a: { allocationId: string; qty: number; actorId?: string | null }
): { packageIds: string[] } {
  const alloc = tx.get<{ id: string; pickingItemId: string; qty: number; lotId: string | null; receivingOrderId: string | null }>(
    sql`SELECT id, picking_item_id AS pickingItemId, qty, inventory_lot_id AS lotId, receiving_order_id AS receivingOrderId
        FROM allocations WHERE id = ${a.allocationId}`
  );
  if (!alloc) throw new HTTPException(404, { message: "allocation not found" });
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });

  const item = tx.get<{ id: string; pickingOrderId: string; qty: number; pickedQty: number; scannedNotBoxedQty: number }>(
    sql`SELECT id, picking_order_id AS pickingOrderId, qty, picked_qty AS pickedQty, scanned_not_boxed_qty AS scannedNotBoxedQty
        FROM picking_items WHERE id = ${alloc.pickingItemId}`
  )!;
  const order = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM picking_orders WHERE id = ${item.pickingOrderId}`
  )!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
  if (a.qty > alloc.qty) throw new HTTPException(409, { message: `qty ${a.qty} exceeds allocation ${alloc.qty}` });
  if (item.pickedQty + item.scannedNotBoxedQty + a.qty > item.qty)
    throw new HTTPException(409, { message: "scan quantity exceeds required" });

  const packageIds: string[] = [];

  if (alloc.lotId) {
    const lot = tx.get<{ id: string; totalQty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
      sql`SELECT id, total_qty AS totalQty, date_code AS dateCode, lot_code AS lotCode, coo, cow FROM inventory_lots WHERE id = ${alloc.lotId}`
    )!;
    if (lot.totalQty < a.qty) throw new HTTPException(409, { message: "insufficient lot quantity" });
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty - ${a.qty}, updated_at = ${now()} WHERE id = ${lot.id}`);
    reduceAllocation(tx, alloc.id, a.qty); // allocations.qty -= qty; recomputeLot -> allocated = Σ allocations
    const pid = crypto.randomUUID();
    scanToPackage(tx, { id: pid, pickingItemId: item.id, qty: a.qty, sourceType: "inventory_lot", sourceId: lot.id,
      dateCode: lot.dateCode, lotCode: lot.lotCode, coo: lot.coo, cow: lot.cow });
    packageIds.push(pid);
  } else if (alloc.receivingOrderId) {
    const links = tx.all<{ id: string; riiId: string; qty: number }>(
      sql`SELECT id, receiving_invoice_item_id AS riiId, qty FROM allocation_receiving_items
          WHERE allocation_id = ${alloc.id} AND qty > 0 ORDER BY created_at ASC, id ASC`
    );
    let remaining = a.qty;
    for (const link of links) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, link.qty);
      const rii = tx.get<{ dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
        sql`SELECT date_code AS dateCode, lot_code AS lotCode, coo, cow FROM receiving_invoice_items WHERE id = ${link.riiId}`
      )!;
      tx.run(sql`UPDATE allocation_receiving_items SET qty = qty - ${take}, updated_at = ${now()} WHERE id = ${link.id}`);
      applyPick(tx, link.riiId, take); // picked_qty += take; recompute rii (allocated from Σ links, available)
      const pid = crypto.randomUUID();
      scanToPackage(tx, { id: pid, pickingItemId: item.id, qty: take, sourceType: "receiving_invoice_item", sourceId: link.riiId,
        dateCode: rii.dateCode, lotCode: rii.lotCode, coo: rii.coo, cow: rii.cow });
      packageIds.push(pid);
      remaining -= take;
    }
    if (remaining > 0) throw new HTTPException(409, { message: "allocation links under-cover the requested qty" });
    reduceAllocation(tx, alloc.id, a.qty);
  } else {
    throw new HTTPException(409, { message: "allocation has no source" });
  }

  if (order.status === "pending") {
    tx.run(sql`UPDATE picking_orders SET status = 'picking', updated_at = ${now()} WHERE id = ${order.id}`);
    logTransition(tx, { entityType: "picking_order", entityId: order.id, fromStatus: "pending", toStatus: "picking", actorId: a.actorId ?? null });
  }
  logTransition(tx, { entityType: "picking_item", entityId: item.id, fromStatus: "picking", toStatus: "scanned",
    actorId: a.actorId ?? null, note: `qty=${a.qty} allocation=${alloc.id}` });

  return { packageIds };
}

export function removeScannedPackage(tx: DbOrTx, p: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; sourceType: string; sourceId: string; qty: number; shippingBoxId: string | null }>(
    sql`SELECT id, picking_item_id AS pickingItemId, source_type AS sourceType, source_id AS sourceId, qty, shipping_box_id AS shippingBoxId
        FROM picking_packages WHERE id = ${p.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });

  const item = tx.get<{ id: string; pickingOrderId: string }>(
    sql`SELECT id, picking_order_id AS pickingOrderId FROM picking_items WHERE id = ${pkg.pickingItemId}`
  )!;
  const order = tx.get<{ status: string }>(sql`SELECT status FROM picking_orders WHERE id = ${item.pickingOrderId}`)!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });

  if (pkg.sourceType === "inventory_lot") {
    const lot = tx.get<{ id: string }>(sql`SELECT id FROM inventory_lots WHERE id = ${pkg.sourceId}`);
    if (!lot) throw new HTTPException(404, { message: "inventory lot not found" });
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${lot.id}`);
    const existing = tx.get<{ id: string }>(
      sql`SELECT id FROM allocations WHERE picking_item_id = ${pkg.pickingItemId} AND inventory_lot_id = ${lot.id}`
    );
    if (existing) {
      tx.run(sql`UPDATE allocations SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${existing.id}`);
      recomputePickingItem(tx, pkg.pickingItemId);
      recomputeLot(tx, lot.id);
    } else {
      createAllocation(tx, { id: crypto.randomUUID(), pickingItemId: pkg.pickingItemId, qty: pkg.qty, inventoryLotId: lot.id });
    }
  } else if (pkg.sourceType === "receiving_invoice_item") {
    const rii = tx.get<{ pickedQty: number; receivingOrderId: string }>(
      sql`SELECT rii.picked_qty AS pickedQty, ri.receiving_order_id AS receivingOrderId
          FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE rii.id = ${pkg.sourceId}`
    );
    if (!rii) throw new HTTPException(404, { message: "receiving invoice item not found" });
    tx.run(sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty}, updated_at = ${now()} WHERE id = ${pkg.sourceId}`);
    let allocation = tx.get<{ id: string }>(
      sql`SELECT id FROM allocations WHERE picking_item_id = ${pkg.pickingItemId} AND receiving_order_id = ${rii.receivingOrderId}`
    );
    let allocationId: string;
    if (allocation) {
      tx.run(sql`UPDATE allocations SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${allocation.id}`);
      allocationId = allocation.id;
    } else {
      allocationId = crypto.randomUUID();
      createAllocation(tx, { id: allocationId, pickingItemId: pkg.pickingItemId, qty: pkg.qty, receivingOrderId: rii.receivingOrderId });
    }
    const link = tx.get<{ id: string }>(
      sql`SELECT id FROM allocation_receiving_items WHERE allocation_id = ${allocationId} AND receiving_invoice_item_id = ${pkg.sourceId}`
    );
    if (link) {
      tx.run(sql`UPDATE allocation_receiving_items SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${link.id}`);
    } else {
      linkAllocation(tx, { id: crypto.randomUUID(), allocationId, receivingInvoiceItemId: pkg.sourceId, qty: pkg.qty });
    }
    recomputeReceivingItem(tx, pkg.sourceId);
  } else {
    throw new HTTPException(409, { message: "unknown package source type" });
  }

  tx.run(sql`DELETE FROM picking_packages WHERE id = ${pkg.id}`);
  recomputePickingItem(tx, pkg.pickingItemId);
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "scanned", toStatus: "removed",
    actorId: p.actorId ?? null, note: `qty=${pkg.qty} package=${pkg.id}` });
}

function loadOrderForWrite(tx: DbOrTx, orderId: string): { id: string; status: string } {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });
  return order;
}

function assertOrderWritable(order: { status: string }): void {
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
}

export function createShippingBox(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): string {
  const order = loadOrderForWrite(tx, a.pickingOrderId);
  assertOrderWritable(order);
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at)
        VALUES (${id}, ${a.pickingOrderId}, 'open', ${now()}, ${now()})`
  );
  logTransition(tx, { entityType: "shipping_box", entityId: id, fromStatus: null, toStatus: "open", actorId: a.actorId ?? null,
    note: `picking_order=${a.pickingOrderId}` });
  return id;
}

export function cancelShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void {
  const box = tx.get<{ id: string; status: string; pickingOrderId: string }>(
    sql`SELECT id, status, picking_order_id AS pickingOrderId FROM shipping_boxes WHERE id = ${a.shippingBoxId}`
  );
  if (!box) throw new HTTPException(404, { message: "box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const used = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM picking_packages WHERE shipping_box_id = ${box.id}`)!;
  if (used.c > 0) throw new HTTPException(409, { message: "box is not empty" });
  tx.run(sql`DELETE FROM shipping_boxes WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromStatus: box.status, toStatus: "cancelled",
    actorId: a.actorId ?? null, note: `picking_order=${box.pickingOrderId}` });
}

/** Finish order + create measuring task when fully boxed. Call only after picked_qty is fresh (i.e., after a recomputePickingItem-emitting mutation in this tx). */
export function maybeAutoFinishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): boolean {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM picking_orders WHERE id = ${a.pickingOrderId}`);
  if (!order) return false;
  if (order.status !== "pending" && order.status !== "picking") return false;
  const items = tx.all<{ qty: number; pickedQty: number }>(
    sql`SELECT qty, picked_qty AS pickedQty FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) return false;
  if (!items.every((i) => i.pickedQty >= i.qty)) return false;

  tx.run(sql`UPDATE picking_orders SET status = 'finished', updated_at = ${now()} WHERE id = ${order.id}`);
  tx.run(
    sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${order.id}, 'pending', ${now()}, ${now()})
        ON CONFLICT (picking_order_id) DO NOTHING`
  );
  logTransition(tx, { entityType: "picking_order", entityId: order.id, fromStatus: order.status, toStatus: "finished", actorId: a.actorId ?? null });
  return true;
}

export function finishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): void {
  const order = loadOrderForWrite(tx, a.pickingOrderId);
  assertOrderWritable(order);
  const items = tx.all<{ qty: number; pickedQty: number }>(
    sql`SELECT qty, picked_qty AS pickedQty FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) throw new HTTPException(409, { message: "no items to pick" });
  if (!items.every((i) => i.pickedQty >= i.qty)) throw new HTTPException(409, { message: "not all items fully boxed" });
  const done = maybeAutoFinishPickingOrder(tx, a);
  if (!done) throw new HTTPException(409, { message: "picking order could not be finished" });
}

function loadBoxForPack(tx: DbOrTx, boxId: string): { id: string; status: string; pickingOrderId: string } {
  const box = tx.get<{ id: string; status: string; pickingOrderId: string }>(
    sql`SELECT id, status, picking_order_id AS pickingOrderId FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  return box;
}

export function addPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; pickingOrderId: string; shippingBoxId: string | null; qty: number }>(
    sql`SELECT pp.id, pp.picking_item_id AS pickingItemId, pi.picking_order_id AS pickingOrderId, pp.shipping_box_id AS shippingBoxId, pp.qty
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });
  const box = loadBoxForPack(tx, a.shippingBoxId);
  if (box.pickingOrderId !== pkg.pickingOrderId) throw new HTTPException(409, { message: "package does not belong to this picking order" });
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);

  assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id }); // sets box + recomputePickingItem (picked up, scanned down)
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "scanned", toStatus: "boxed",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
  maybeAutoFinishPickingOrder(tx, { pickingOrderId: pkg.pickingOrderId, actorId: a.actorId ?? null });
}

export function addAllUnboxedToBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): number {
  const box = loadBoxForPack(tx, a.shippingBoxId);
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);
  const packages = tx.all<{ id: string; pickingItemId: string; qty: number }>(
    sql`SELECT pp.id, pp.picking_item_id AS pickingItemId, pp.qty FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
        WHERE pi.picking_order_id = ${box.pickingOrderId} AND pp.shipping_box_id IS NULL ORDER BY pp.created_at ASC, pp.id ASC`
  );
  for (const pkg of packages) {
    assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id });
    logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "scanned", toStatus: "boxed",
      actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
  }
  maybeAutoFinishPickingOrder(tx, { pickingOrderId: box.pickingOrderId, actorId: a.actorId ?? null });
  return packages.length;
}

export function removePackageFromBox(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; shippingBoxId: string | null; qty: number }>(
    sql`SELECT id, picking_item_id AS pickingItemId, shipping_box_id AS shippingBoxId, qty FROM picking_packages WHERE id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = loadBoxForPack(tx, pkg.shippingBoxId);
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  // only 'issue' is blocked: unpacking a finished order is allowed (measuring-time correction); re-packing is blocked by assertOrderWritable in the add paths.
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });

  tx.run(sql`UPDATE picking_packages SET shipping_box_id = NULL, verified = 0, updated_at = ${now()} WHERE id = ${pkg.id}`);
  recomputePickingItem(tx, pkg.pickingItemId);
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "boxed", toStatus: "scanned",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
}
