import { sql } from "drizzle-orm";
import { queryGet, queryRun, type DbOrTx } from "./query.js";

export { type DbOrTx } from "./query.js";

// NOTE: timestamps are written with SQL now() on purpose. drizzle() replaces the
// client's timestamp serializers with identity, so a JS Date embedded in a raw
// sql`` param is never serialized and crashes the driver; SQL now() sidesteps it.

/**
 * Receiving invoice items keep no derived columns: availability is computed on
 * the fly as received_qty - picked_qty - put_away_qty - Σ allocations.qty(rii).
 */
export async function applyReceipt(tx: DbOrTx, itemId: string, qty: number): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET received_qty = received_qty + ${qty} WHERE id = ${itemId}`
  );
}

export async function applyPick(tx: DbOrTx, itemId: string, qty: number): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${qty} WHERE id = ${itemId}`
  );
}

export async function applyPutAway(tx: DbOrTx, itemId: string, qty: number): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${qty} WHERE id = ${itemId}`
  );
}

/** Recompute picking_items.allocated_qty (Σ allocations) and picked_qty (Σ boxed packages). */
export async function recomputePickingItem(tx: DbOrTx, pickingItemId: string): Promise<void> {
  const alloc = await queryGet<{ s: number }>(tx, sql`SELECT COALESCE(SUM(qty)::int, 0) AS s FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  const boxed = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty)::int, 0) AS s FROM picking_packages WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NOT NULL`
  );
  await queryRun(
    tx,
    sql`UPDATE picking_items SET allocated_qty = ${alloc?.s ?? 0}, picked_qty = ${boxed?.s ?? 0}, updated_at = now() WHERE id = ${pickingItemId}`
  );
}

/** Recompute inventory_lots.allocated_qty (available_qty is generated; lots have no updated_at). */
export async function recomputeLot(tx: DbOrTx, lotId: string): Promise<void> {
  const alloc = await queryGet<{ s: number }>(tx, sql`SELECT COALESCE(SUM(qty)::int, 0) AS s FROM allocations WHERE inventory_lot_id = ${lotId}`);
  await queryRun(tx, sql`UPDATE inventory_lots SET allocated_qty = ${alloc?.s ?? 0} WHERE id = ${lotId}`);
}

/** Single-level allocation: exactly one of inventoryLotId / receivingInvoiceItemId. */
export async function createAllocation(
  tx: DbOrTx,
  a: { id: string; pickingItemId: string; qty: number; inventoryLotId?: string | null; receivingInvoiceItemId?: string | null }
): Promise<void> {
  await queryRun(
    tx,
    sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_invoice_item_id, created_at, updated_at)
        VALUES (${a.id}, ${a.pickingItemId}, ${a.qty}, ${a.inventoryLotId ?? null}, ${a.receivingInvoiceItemId ?? null}, now(), now())`
  );
  await recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
}

export async function deleteAllocation(tx: DbOrTx, allocationId: string): Promise<void> {
  const a = await queryGet<{ pickingItemId: string; inventoryLotId: string | null }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId", inventory_lot_id AS "inventoryLotId" FROM allocations WHERE id = ${allocationId}`
  );
  if (!a) return;
  await queryRun(tx, sql`DELETE FROM allocations WHERE id = ${allocationId}`);
  await recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) await recomputeLot(tx, a.inventoryLotId);
}

export async function scanToPackage(
  tx: DbOrTx,
  p: {
    id: string; pickingItemId: string; qty: number;
    sourceType: "receiving_invoice_item" | "inventory_lot"; sourceId: string;
    dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null;
  }
): Promise<void> {
  const item = await queryGet<{ pickingOrderId: string }>(
    tx,
    sql`SELECT picking_order_id AS "pickingOrderId" FROM picking_items WHERE id = ${p.pickingItemId}`
  );
  if (!item) return;
  await queryRun(
    tx,
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, date_code, lot_code, coo, cow, created_at, updated_at)
        VALUES (${p.id}, ${p.pickingItemId}, ${item.pickingOrderId}, ${p.sourceType}, ${p.sourceId}, ${p.qty}, NULL,
                ${p.dateCode ?? null}, ${p.lotCode ?? null}, ${p.coo ?? null}, ${p.cow ?? null}, now(), now())`
  );
  await recomputePickingItem(tx, p.pickingItemId);
}

/**
 * Box a package. picking_packages stays the truth; shipping_box_items is a
 * best-effort compat mirror — one mirror row per boxed package, keyed by the
 * package id so unboxing can remove exactly it.
 */
export async function assignPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string }): Promise<void> {
  const pkg = await queryGet<{ pickingItemId: string; partId: string; qty: number }>(
    tx,
    sql`SELECT pp.picking_item_id AS "pickingItemId", pi.part_id AS "partId", pp.qty
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) return;
  await queryRun(tx, sql`UPDATE picking_packages SET shipping_box_id = ${a.shippingBoxId}, updated_at = now() WHERE id = ${a.packageId}`);
  await queryRun(tx, sql`DELETE FROM shipping_box_items WHERE id = ${a.packageId}`);
  await queryRun(
    tx,
    sql`INSERT INTO shipping_box_items (id, shipping_box_id, picking_item_id, part_id, qty, created_at, updated_at)
        VALUES (${a.packageId}, ${a.shippingBoxId}, ${pkg.pickingItemId}, ${pkg.partId}, ${pkg.qty}, now(), now())`
  );
  await recomputePickingItem(tx, pkg.pickingItemId);
}

/** Unbox a package: clear shipping_box_id and drop the compat mirror row. */
export async function unassignPackageFromBox(tx: DbOrTx, a: { packageId: string }): Promise<void> {
  const pkg = await queryGet<{ pickingItemId: string; shippingBoxId: string | null }>(
    tx,
    sql`SELECT picking_item_id AS "pickingItemId", shipping_box_id AS "shippingBoxId" FROM picking_packages WHERE id = ${a.packageId}`
  );
  if (!pkg || pkg.shippingBoxId === null) return;
  await queryRun(tx, sql`UPDATE picking_packages SET shipping_box_id = NULL, verified = false, updated_at = now() WHERE id = ${a.packageId}`);
  await queryRun(tx, sql`DELETE FROM shipping_box_items WHERE id = ${a.packageId}`);
  await recomputePickingItem(tx, pkg.pickingItemId);
}
