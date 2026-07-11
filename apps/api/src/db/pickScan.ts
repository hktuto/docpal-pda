import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  applyPick,
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
