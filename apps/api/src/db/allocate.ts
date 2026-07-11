import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import {
  type DbOrTx,
  createAllocation,
  linkAllocation,
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

function receivingOrderCandidates(tx: DbOrTx, partId: string): { receivingOrderId: string }[] {
  return tx.all<{ receivingOrderId: string }>(sql`
    SELECT DISTINCT ro.id AS receivingOrderId
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE rii.part_id = ${partId} AND ro.status = 'in_hand' AND rii.available_qty > 0
    ORDER BY ro.delivery_date ASC NULLS LAST, ro.external_id ASC
  `);
}

function receivingOrderItems(
  tx: DbOrTx,
  receivingOrderId: string,
  partId: string
): { itemId: string; boxId: string | null; availableQty: number }[] {
  return tx.all<{ itemId: string; boxId: string | null; availableQty: number }>(sql`
    SELECT rii.id AS itemId, rii.box_id AS boxId, rii.available_qty AS availableQty
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${partId} AND rii.available_qty > 0
    ORDER BY ri.invoice_no ASC, rii.date_code ASC NULLS LAST
  `);
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

  for (const ord of receivingOrderCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const items = receivingOrderItems(tx, ord.receivingOrderId, row.partId);
    const boxed = items.filter((i) => i.boxId !== null);
    const unboxed = items.filter((i) => i.boxId === null);

    for (const b of boxed) {
      if (need <= 0) break;
      const take = Math.min(need, b.availableQty, currentAvailable(tx, "rii", b.itemId));
      if (take <= 0) continue;
      const aid = newId();
      createAllocation(tx, { id: aid, pickingItemId, qty: take, receivingOrderId: ord.receivingOrderId });
      linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId: b.itemId, qty: take });
      need -= take;
    }

    if (need <= 0) continue;
    let poolNeed = need;
    const portions: { itemId: string; qty: number }[] = [];
    for (const u of unboxed) {
      if (poolNeed <= 0) break;
      const take = Math.min(poolNeed, u.availableQty, currentAvailable(tx, "rii", u.itemId));
      if (take <= 0) continue;
      portions.push({ itemId: u.itemId, qty: take });
      poolNeed -= take;
    }
    const poolTake = need - poolNeed;
    if (poolTake > 0) {
      const aid = newId();
      createAllocation(tx, { id: aid, pickingItemId, qty: poolTake, receivingOrderId: ord.receivingOrderId });
      for (const p of portions) {
        linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId: p.itemId, qty: p.qty });
      }
      need -= poolTake;
    }
  }
}
