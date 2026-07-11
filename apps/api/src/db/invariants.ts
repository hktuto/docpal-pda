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
