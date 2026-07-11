import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import {
  type DbOrTx,
  createAllocation,
  deleteAllocation,
} from "./invariants.js";

function newId(): string {
  return crypto.randomUUID();
}

function shelfCandidates(tx: DbOrTx, partId: string): { id: string; availableQty: number }[] {
  return tx.all<{ id: string; availableQty: number }>(sql`
    SELECT id, available_qty AS availableQty
    FROM inventory_lots
    WHERE part_id = ${partId} AND shelf_code IS NOT NULL AND available_qty > 0
    ORDER BY created_at ASC, date_code_norm ASC NULLS LAST
  `);
}

function currentAvailable(tx: DbOrTx, kind: "lot" | "rii", id: string): number {
  if (kind === "lot") {
    return tx.get<{ v: number }>(sql`SELECT available_qty AS v FROM inventory_lots WHERE id = ${id}`)?.v ?? 0;
  }
  return tx.get<{ v: number }>(sql`SELECT available_qty AS v FROM receiving_invoice_items WHERE id = ${id}`)?.v ?? 0;
}

export function allocatePickingItem(tx: DbOrTx, pickingItemId: string): void {
  const existing = tx.all<{ id: string }>(sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  for (const a of existing) deleteAllocation(tx, a.id);

  const row = tx.get<{ partId: string; remaining: number }>(
    sql`SELECT part_id AS partId, remaining_qty AS remaining FROM picking_items WHERE id = ${pickingItemId}`
  );
  if (!row) return;
  let need = row.remaining;
  if (need <= 0) return;

  for (const lot of shelfCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const take = Math.min(need, lot.availableQty, currentAvailable(tx, "lot", lot.id));
    if (take <= 0) continue;
    createAllocation(tx, { id: newId(), pickingItemId, qty: take, inventoryLotId: lot.id });
    need -= take;
  }
}
