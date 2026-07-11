import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
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
