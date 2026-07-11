import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { now } from "./now.js";

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type DbOrTx = AppDb | Tx;

/** Recompute receiving_invoice_items.allocated_qty and available_qty from source rows. */
export function recomputeReceivingItem(tx: DbOrTx, itemId: string): void {
  const item = tx
    .get<{ received: number; picked: number; put_away: number }>(
      sql`SELECT received_qty AS received, picked_qty AS picked, put_away_qty AS put_away FROM receiving_invoice_items WHERE id = ${itemId}`
    );
  if (!item) return;
  const alloc = tx
    .get<{ s: number }>(
      sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocation_receiving_items WHERE receiving_invoice_item_id = ${itemId}`
    );
  const allocated = alloc?.s ?? 0;
  const available = item.received - item.picked - item.put_away - allocated;
  tx.run(
    sql`UPDATE receiving_invoice_items SET allocated_qty = ${allocated}, available_qty = ${available}, updated_at = ${now()} WHERE id = ${itemId}`
  );
}

export function applyReceipt(tx: DbOrTx, itemId: string, qty: number): void {
  tx.run(sql`UPDATE receiving_invoice_items SET received_qty = received_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

export function applyPick(tx: DbOrTx, itemId: string, qty: number): void {
  tx.run(sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

export function applyPutAway(tx: DbOrTx, itemId: string, qty: number, shelfBoxId: string | null): void {
  tx.run(
    sql`INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${itemId}, ${qty}, ${shelfBoxId}, ${now()}, ${now()})`
  );
  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

/** Recompute picking_items.allocated_qty and scanned_not_boxed_qty (remaining_qty is generated). */
export function recomputePickingItem(tx: DbOrTx, pickingItemId: string): void {
  const alloc = tx.get<{ s: number }>(sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  const scanned = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM picking_packages WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NULL`
  );
  tx.run(
    sql`UPDATE picking_items SET allocated_qty = ${alloc?.s ?? 0}, scanned_not_boxed_qty = ${scanned?.s ?? 0}, updated_at = ${now()} WHERE id = ${pickingItemId}`
  );
}

/** Recompute inventory_lots.allocated_qty (available_qty is generated). */
export function recomputeLot(tx: DbOrTx, lotId: string): void {
  const alloc = tx.get<{ s: number }>(sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocations WHERE inventory_lot_id = ${lotId}`);
  tx.run(sql`UPDATE inventory_lots SET allocated_qty = ${alloc?.s ?? 0}, updated_at = ${now()} WHERE id = ${lotId}`);
}

export function createAllocation(
  tx: DbOrTx,
  a: { id: string; pickingItemId: string; qty: number; inventoryLotId?: string | null; receivingOrderId?: string | null }
): void {
  tx.run(
    sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_order_id, created_at, updated_at)
        VALUES (${a.id}, ${a.pickingItemId}, ${a.qty}, ${a.inventoryLotId ?? null}, ${a.receivingOrderId ?? null}, ${now()}, ${now()})`
  );
  recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
}

export function linkAllocation(
  tx: DbOrTx,
  l: { id: string; allocationId: string; receivingInvoiceItemId: string; qty: number }
): void {
  tx.run(
    sql`INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at)
        VALUES (${l.id}, ${l.allocationId}, ${l.receivingInvoiceItemId}, ${l.qty}, ${now()}, ${now()})`
  );
  recomputeReceivingItem(tx, l.receivingInvoiceItemId);
}

export function deleteAllocation(tx: DbOrTx, allocationId: string): void {
  const a = tx.get<{ pickingItemId: string; inventoryLotId: string | null }>(
    sql`SELECT picking_item_id AS pickingItemId, inventory_lot_id AS inventoryLotId FROM allocations WHERE id = ${allocationId}`
  );
  if (!a) return;
  const linked = tx.all<{ itemId: string }>(
    sql`SELECT receiving_invoice_item_id AS itemId FROM allocation_receiving_items WHERE allocation_id = ${allocationId}`
  );
  tx.run(sql`DELETE FROM allocations WHERE id = ${allocationId}`); // cascade deletes allocation_receiving_items
  recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
  for (const { itemId } of linked) recomputeReceivingItem(tx, itemId);
}

export function scanToPackage(
  tx: DbOrTx,
  p: { id: string; pickingItemId: string; qty: number; sourceType: "receiving_invoice_item" | "inventory_lot"; sourceId: string }
): void {
  tx.run(
    sql`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
        VALUES (${p.id}, ${p.pickingItemId}, ${p.sourceType}, ${p.sourceId}, ${p.qty}, NULL, ${now()}, ${now()})`
  );
  recomputePickingItem(tx, p.pickingItemId);
}

export function assignPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string }): void {
  const pkg = tx.get<{ pickingItemId: string }>(sql`SELECT picking_item_id AS pickingItemId FROM picking_packages WHERE id = ${a.packageId}`);
  if (!pkg) return;
  tx.run(sql`UPDATE picking_packages SET shipping_box_id = ${a.shippingBoxId}, updated_at = ${now()} WHERE id = ${a.packageId}`);
  recomputePickingItem(tx, pkg.pickingItemId);
}
