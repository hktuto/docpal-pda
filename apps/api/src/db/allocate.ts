import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { createAllocation, deleteAllocation } from "./invariants.js";

function newId(): string {
  return crypto.randomUUID();
}

// inventory_lots has no created_at anymore, so shelf lots go FEFO:
// date_code ASC NULLS LAST, id as the stable tiebreak.
async function shelfCandidates(tx: DbOrTx, partId: string): Promise<{ id: string; availableQty: number }[]> {
  return queryAll<{ id: string; availableQty: number }>(tx, sql`
    SELECT id, available_qty AS "availableQty"
    FROM inventory_lots
    WHERE part_id = ${partId} AND shelf_code IS NOT NULL AND available_qty > 0
    ORDER BY date_code ASC NULLS LAST, id ASC
  `);
}

// rii availability is computed on the fly (received - picked - put_away - Σ allocations).
// Orders FIFO (delivery_date NULLS LAST, ref_no), boxed rii rows before unboxed,
// then invoice_no / date_code as before.
async function receivingCandidates(tx: DbOrTx, partId: string): Promise<{ itemId: string; availableQty: number }[]> {
  return queryAll<{ itemId: string; availableQty: number }>(tx, sql`
    SELECT rii.id AS "itemId",
      rii.received_qty - rii.picked_qty - rii.put_away_qty
        - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS "availableQty"
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
    WHERE ro.status = 'in_hand' AND rii.part_id = ${partId}
      AND rii.received_qty - rii.picked_qty - rii.put_away_qty
        - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) > 0
    ORDER BY ro.delivery_date ASC NULLS LAST, ro.ref_no ASC,
      (rii.box_id IS NOT NULL) DESC, ri.invoice_no ASC, rii.date_code ASC NULLS LAST, rii.id ASC
  `);
}

export async function allocatePickingItem(tx: DbOrTx, pickingItemId: string): Promise<void> {
  const existing = await queryAll<{ id: string }>(tx, sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  for (const a of existing) await deleteAllocation(tx, a.id);

  // need = qty - Σ ALL packages for the item (remaining is computed, not stored).
  const row = await queryGet<{ partId: string; need: number }>(
    tx,
    sql`SELECT pi.part_id AS "partId",
          pi.qty - COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS need
        FROM picking_items pi WHERE pi.id = ${pickingItemId}`
  );
  if (!row) return;
  let need = row.need;
  if (need <= 0) return;

  // Phase 1: on-shelf inventory lots. One allocations row per lot.
  for (const lot of await shelfCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const take = Math.min(need, lot.availableQty);
    if (take <= 0) continue;
    await createAllocation(tx, { id: newId(), pickingItemId, qty: take, inventoryLotId: lot.id });
    need -= take;
  }

  // Phase 2: in_hand receiving orders' rii rows. One allocations row per rii row.
  for (const item of await receivingCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const take = Math.min(need, item.availableQty);
    if (take <= 0) continue;
    await createAllocation(tx, { id: newId(), pickingItemId, qty: take, receivingInvoiceItemId: item.itemId });
    need -= take;
  }
}

export async function allocatePickingOrder(db: AppDb, pickingOrderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const items = await queryAll<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${pickingOrderId} ORDER BY created_at ASC, id ASC`
    );
    for (const it of items) await allocatePickingItem(tx, it.id);
  });
}

export async function allocateAll(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    const items = await queryAll<{ id: string }>(
      tx,
      sql`SELECT pi.id FROM picking_items pi
          WHERE pi.qty - COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) > 0
          ORDER BY pi.created_at ASC, pi.id ASC`
    );
    for (const it of items) await allocatePickingItem(tx, it.id);
  });
}
