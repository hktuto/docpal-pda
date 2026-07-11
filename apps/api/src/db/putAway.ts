import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx, recomputeReceivingItem } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface ShelfBoxRow { id: string; receivingOrderId: string | null; shelfCode: string; status: string }

function loadShelfBox(tx: DbOrTx, boxId: string): ShelfBoxRow {
  const box = tx.get<ShelfBoxRow>(
    sql`SELECT id, receiving_order_id AS receivingOrderId, shelf_code AS shelfCode, status FROM shelf_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  return box;
}

function nextShelfBoxId(tx: DbOrTx): string {
  // Cancelled boxes are hard-deleted, so also scan transition_logs (no FK, kept
  // forever) to never reissue an id whose audit history still references it.
  const rows = tx.all<{ id: string }>(sql`
    SELECT id FROM shelf_boxes WHERE id LIKE 'SBOX-%'
    UNION ALL
    SELECT entity_id AS id FROM transition_logs WHERE entity_type = 'shelf_box' AND entity_id LIKE 'SBOX-%'
  `);
  let max = 0;
  for (const r of rows) { const n = Number(r.id.slice(5)); if (Number.isInteger(n) && n > max) max = n; }
  return `SBOX-${String(max + 1).padStart(4, "0")}`;
}

export function createShelfBox(tx: DbOrTx, a: { receivingOrderId: string; shelfCode: string; actorId?: string | null }): { id: string } {
  const order = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });
  const shelf = tx.get<{ code: string }>(sql`SELECT code FROM shelves WHERE code = ${a.shelfCode}`);
  if (!shelf) throw new HTTPException(404, { message: "shelf not found" });
  const id = nextShelfBoxId(tx);
  tx.run(
    sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at)
        VALUES (${id}, ${a.receivingOrderId}, ${a.shelfCode}, 'open', ${now()}, ${now()})`
  );
  logTransition(tx, { entityType: "shelf_box", entityId: id, toStatus: "open", actorId: a.actorId ?? null, note: `order=${a.receivingOrderId} shelf=${a.shelfCode}` });
  return { id };
}

export function cancelShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const cnt = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id = ${box.id}`)!.c;
  if (cnt > 0) throw new HTTPException(409, { message: "shelf box is not empty" });
  logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromStatus: "open", toStatus: "cancelled", actorId: a.actorId ?? null });
  tx.run(sql`DELETE FROM shelf_boxes WHERE id = ${box.id}`);
}

export function recordPutAwayScan(
  tx: DbOrTx,
  a: { receivingInvoiceItemId: string; qty: number; dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null }
): { id: string } {
  const item = tx.get<{ id: string; received: number; picked: number; putAway: number; allocated: number }>(
    sql`SELECT id, received_qty AS received, picked_qty AS picked, put_away_qty AS putAway, allocated_qty AS allocated
        FROM receiving_invoice_items WHERE id = ${a.receivingInvoiceItemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving invoice item not found" });
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });
  const unboxed = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM put_away_scans WHERE receiving_invoice_item_id = ${item.id} AND shelf_box_id IS NULL`
  )!.s;
  const remaining = item.received - item.picked - item.putAway - item.allocated - unboxed;
  if (a.qty > remaining) throw new HTTPException(409, { message: "scanned qty exceeds remaining" });
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, date_code, lot_code, coo, cow, created_at, updated_at)
        VALUES (${id}, ${item.id}, ${a.qty}, NULL, ${a.dateCode ?? null}, ${a.lotCode ?? null}, ${a.coo ?? null}, ${a.cow ?? null}, ${now()}, ${now()})`
  );
  return { id };
}

export function removeScannedPiece(tx: DbOrTx, a: { scanId: string }): void {
  const scan = tx.get<{ id: string; shelfBoxId: string | null }>(
    sql`SELECT id, shelf_box_id AS shelfBoxId FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId !== null) throw new HTTPException(409, { message: "scan is already in a box" });
  tx.run(sql`DELETE FROM put_away_scans WHERE id = ${scan.id}`);
}

/** Next local day 09:00 as an ISO (UTC) string. Coalesced per box per UTC calendar day. */
function nextMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** Any shelf-box stock change schedules a next-day recount, coalesced per box per day. */
export function scheduleCycleCount(tx: DbOrTx, shelfBoxId: string): void {
  const dueAt = nextMorning();
  const existing = tx.get<{ id: string }>(
    sql`SELECT id FROM verification_tasks WHERE kind = 'cycle_count' AND shelf_box_id = ${shelfBoxId} AND date(due_at) = date(${dueAt})`
  );
  if (existing) return; // one task per box per day
  tx.run(
    sql`INSERT INTO verification_tasks (id, kind, status, due_at, shelf_box_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, 'cycle_count', 'pending', ${dueAt}, ${shelfBoxId}, ${now()}, ${now()})`
  );
  // stock changed => the box needs re-verification
  tx.run(sql`UPDATE put_away_scans SET verified = 0, verified_at = NULL, updated_at = ${now()} WHERE shelf_box_id = ${shelfBoxId}`);
  tx.run(sql`UPDATE shelf_boxes SET status = 'closed', updated_at = ${now()} WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

/** Receiving order in_hand -> clear once every invoice item is fully picked/allocated/put-away/scanned. */
export function tryMarkReceivingOrderClear(tx: DbOrTx, a: { receivingOrderId: string; actorId?: string | null }): void {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order || order.status !== "in_hand") return;
  const items = tx.all<{ id: string; received: number; picked: number; putAway: number; allocated: number }>(
    sql`SELECT rii.id, rii.received_qty AS received, rii.picked_qty AS picked, rii.put_away_qty AS putAway, rii.allocated_qty AS allocated
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}`
  );
  if (items.length === 0) return;
  for (const it of items) {
    const unboxed = tx.get<{ s: number }>(
      sql`SELECT COALESCE(SUM(qty), 0) AS s FROM put_away_scans WHERE receiving_invoice_item_id = ${it.id} AND shelf_box_id IS NULL`
    )!.s;
    if (it.received - it.picked - it.putAway - it.allocated - unboxed > 0) return; // something still left
  }
  tx.run(sql`UPDATE receiving_orders SET status = 'clear', updated_at = ${now()} WHERE id = ${order.id}`);
  logTransition(tx, { entityType: "receiving_order", entityId: order.id, fromStatus: "in_hand", toStatus: "clear", actorId: a.actorId ?? null });
}

export function assignScanToBox(tx: DbOrTx, a: { scanId: string; shelfBoxId: string; actorId?: string | null }): void {
  const scan = tx.get<{ id: string; itemId: string; qty: number; shelfBoxId: string | null; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
    sql`SELECT id, receiving_invoice_item_id AS itemId, qty, shelf_box_id AS shelfBoxId,
               date_code AS dateCode, lot_code AS lotCode, coo AS coo, cow AS cow
        FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId !== null) throw new HTTPException(409, { message: "scan is already in a box" });
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const item = tx.get<{ partId: string; receivingOrderId: string }>(
    sql`SELECT rii.part_id AS partId, ri.receiving_order_id AS receivingOrderId
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${scan.itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving invoice item not found" });
  if (box.receivingOrderId !== item.receivingOrderId) throw new HTTPException(409, { message: "scan and box belong to different receiving orders" });

  tx.run(sql`UPDATE put_away_scans SET shelf_box_id = ${box.id}, updated_at = ${now()} WHERE id = ${scan.id}`);

  // materialize / increment the inventory lot at (part, date, lot, coo, cow, shelf, box) — null-safe attribute match via IS
  const lot = tx.get<{ id: string }>(
    sql`SELECT id FROM inventory_lots
        WHERE part_id = ${item.partId} AND shelf_code = ${box.shelfCode} AND box_id = ${box.id}
          AND date_code IS ${scan.dateCode} AND lot_code IS ${scan.lotCode} AND coo IS ${scan.coo} AND cow IS ${scan.cow}`
  );
  let lotId: string;
  if (lot) {
    lotId = lot.id;
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${lotId}`);
  } else {
    lotId = crypto.randomUUID();
    tx.run(
      sql`INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at)
          VALUES (${lotId}, ${item.partId}, ${scan.dateCode}, ${scan.lotCode}, ${scan.coo}, ${scan.cow}, ${box.shelfCode}, ${box.id}, ${scan.qty}, 0, ${now()}, ${now()})`
    );
  }

  const src = tx.get<{ id: string }>(
    sql`SELECT id FROM inventory_lot_sources WHERE inventory_lot_id = ${lotId} AND receiving_invoice_item_id = ${scan.itemId}`
  );
  if (src) tx.run(sql`UPDATE inventory_lot_sources SET qty = qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${src.id}`);
  else tx.run(
    sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${lotId}, ${scan.itemId}, ${scan.qty}, ${now()}, ${now()})`
  );

  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${scan.itemId}`);
  recomputeReceivingItem(tx, scan.itemId);

  scheduleCycleCount(tx, box.id);
  tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export function addAllUnboxedToBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): { count: number } {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const scans = tx.all<{ id: string }>(
    sql`SELECT pas.id FROM put_away_scans pas
        JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE pas.shelf_box_id IS NULL AND ri.receiving_order_id = ${box.receivingOrderId}
        ORDER BY pas.created_at ASC`
  );
  for (const s of scans) assignScanToBox(tx, { scanId: s.id, shelfBoxId: box.id, actorId: a.actorId ?? null });
  return { count: scans.length };
}

export function removeScanFromBox(tx: DbOrTx, a: { scanId: string; actorId?: string | null }): void {
  const scan = tx.get<{ id: string; itemId: string; qty: number; shelfBoxId: string | null }>(
    sql`SELECT id, receiving_invoice_item_id AS itemId, qty, shelf_box_id AS shelfBoxId FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId === null) throw new HTTPException(409, { message: "scan is not in a box" });
  const box = loadShelfBox(tx, scan.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const item = tx.get<{ partId: string; receivingOrderId: string }>(
    sql`SELECT rii.part_id AS partId, ri.receiving_order_id AS receivingOrderId
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id WHERE rii.id = ${scan.itemId}`
  )!;

  tx.run(sql`UPDATE put_away_scans SET shelf_box_id = NULL, verified = 0, verified_at = NULL, updated_at = ${now()} WHERE id = ${scan.id}`);

  // reverse the lot materialization (find the lot via its source row in this box)
  const src = tx.get<{ id: string; lotId: string; qty: number }>(
    sql`SELECT ils.id, ils.inventory_lot_id AS lotId, ils.qty FROM inventory_lot_sources ils
        JOIN inventory_lots il ON il.id = ils.inventory_lot_id
        WHERE ils.receiving_invoice_item_id = ${scan.itemId} AND il.box_id = ${box.id}`
  );
  if (src) {
    if (src.qty - scan.qty <= 0) tx.run(sql`DELETE FROM inventory_lot_sources WHERE id = ${src.id}`);
    else tx.run(sql`UPDATE inventory_lot_sources SET qty = qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${src.id}`);
    const lot = tx.get<{ total: number }>(sql`SELECT total_qty AS total FROM inventory_lots WHERE id = ${src.lotId}`)!;
    if (lot.total - scan.qty <= 0) tx.run(sql`DELETE FROM inventory_lots WHERE id = ${src.lotId}`);
    else tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${src.lotId}`);
  }

  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${scan.itemId}`);
  recomputeReceivingItem(tx, scan.itemId);

  scheduleCycleCount(tx, box.id);
  tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export function closeShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const cnt = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id = ${box.id}`)!.c;
  if (cnt === 0) throw new HTTPException(409, { message: "cannot close an empty shelf box" });
  tx.run(sql`UPDATE shelf_boxes SET status = 'closed', updated_at = ${now()} WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromStatus: "open", toStatus: "closed", actorId: a.actorId ?? null });
  if (box.receivingOrderId) tryMarkReceivingOrderClear(tx, { receivingOrderId: box.receivingOrderId, actorId: a.actorId ?? null });
}
