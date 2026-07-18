import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx, applyPutAway } from "./invariants.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface ShelfBoxRow { id: string; receivingOrderId: string | null; shelfCode: string | null; status: string }

async function loadShelfBox(tx: DbOrTx, boxId: string): Promise<ShelfBoxRow> {
  const box = await queryGet<ShelfBoxRow>(
    tx,
    sql`SELECT id, receiving_order_id AS "receivingOrderId", shelf_code AS "shelfCode", status FROM shelf_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  return box;
}

async function nextShelfBoxId(tx: DbOrTx): Promise<string> {
  const rows = await queryAll<{ id: string }>(tx, sql`
    SELECT id FROM shelf_boxes WHERE id LIKE 'SBOX-%'
    UNION ALL
    SELECT entity_id AS id FROM transaction_logs WHERE entity_type = 'shelf_box' AND entity_id LIKE 'SBOX-%'
  `);
  let max = 0;
  for (const r of rows) {
    const n = Number(r.id.slice(5));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `SBOX-${String(max + 1).padStart(4, "0")}`;
}

async function ensureStagingBox(tx: DbOrTx, receivingOrderId: string): Promise<string> {
  const existing = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM shelf_boxes WHERE receiving_order_id = ${receivingOrderId} AND shelf_code IS NULL AND status = 'open'`
  );
  if (existing) return existing.id;
  const id = await nextShelfBoxId(tx);
  await queryRun(
    tx,
    sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
        VALUES (${id}, ${receivingOrderId}, NULL, 'open', ${now()})`
  );
  await logTransition(tx, { entityType: "shelf_box", entityId: id, toState: "open", actorId: null, metadata: { kind: "staging", receiving_order_id: receivingOrderId } });
  return id;
}

export async function createShelfBox(
  tx: DbOrTx,
  a: { receivingOrderId: string; shelfCode: string; actorId?: string | null }
): Promise<Record<string, unknown>> {
  const order = await queryGet<{ id: string }>(tx, sql`SELECT id FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });
  const shelf = await queryGet<{ code: string }>(tx, sql`SELECT code FROM shelves WHERE code = ${a.shelfCode}`);
  if (!shelf) throw new HTTPException(404, { message: "shelf not found" });
  const id = await nextShelfBoxId(tx);
  await queryRun(
    tx,
    sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
        VALUES (${id}, ${a.receivingOrderId}, ${a.shelfCode}, 'open', ${now()})`
  );
  await logTransition(tx, { entityType: "shelf_box", entityId: id, toState: "open", actorId: a.actorId ?? null, metadata: { order: a.receivingOrderId, shelf: a.shelfCode } });
  return (await queryGet<Record<string, unknown>>(tx, sql`SELECT * FROM shelf_boxes WHERE id = ${id}`))!;
}

export async function cancelShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): Promise<void> {
  const box = await loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot cancel a staging box" });
  const cnt = (await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM shelf_box_items WHERE shelf_box_id = ${box.id}`))!.c;
  if (cnt > 0) throw new HTTPException(409, { message: "shelf box is not empty" });
  await logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromState: "open", toState: "cancelled", actorId: a.actorId ?? null });
  await queryRun(tx, sql`DELETE FROM shelf_boxes WHERE id = ${box.id}`);
}

async function loadItemForPutAway(tx: DbOrTx, itemId: string): Promise<{ id: string; partId: string; receivingOrderId: string; received: number; picked: number; putAway: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }> {
  const item = await queryGet<{ id: string; partId: string; receivingOrderId: string; received: number; picked: number; putAway: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
    tx,
    sql`SELECT rii.id, rii.part_id AS "partId", ri.receiving_order_id AS "receivingOrderId",
               rii.received_qty AS received, rii.picked_qty AS picked, rii.put_away_qty AS "putAway",
               rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving invoice item not found" });
  return item;
}

function remainingAfterStaged(tx: DbOrTx, itemId: string, item: { received: number; picked: number; putAway: number }): Promise<number> {
  return (async () => {
    const alloc = await queryGet<{ s: number }>(tx, sql`SELECT COALESCE(SUM(qty)::int, 0) AS s FROM allocations WHERE receiving_invoice_item_id = ${itemId}`);
    const staged = await queryGet<{ s: number }>(
      tx,
      sql`SELECT COALESCE(SUM(sbi.qty)::int, 0) AS s
          FROM shelf_box_items sbi
          JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
          WHERE sbi.receiving_invoice_item_id = ${itemId} AND sb.shelf_code IS NULL`
    );
    return item.received - item.picked - item.putAway - (alloc?.s ?? 0) - (staged?.s ?? 0);
  })();
}

export async function recordPutAwayScan(
  tx: DbOrTx,
  a: { receivingInvoiceItemId: string; qty: number; dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null }
): Promise<Record<string, unknown>> {
  const item = await loadItemForPutAway(tx, a.receivingInvoiceItemId);
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });
  const remaining = await remainingAfterStaged(tx, item.id, item);
  if (a.qty > remaining) throw new HTTPException(409, { message: "scanned qty exceeds remaining" });

  // Backfill NULL batch attributes on the RII from the scan label (RII row is the source of truth).
  const dc = a.dateCode ?? null;
  const lc = a.lotCode ?? null;
  const coo = a.coo ?? null;
  const cow = a.cow ?? null;
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items
        SET date_code = COALESCE(date_code, ${dc}),
            lot_code = COALESCE(lot_code, ${lc}),
            coo = COALESCE(coo, ${coo}),
            cow = COALESCE(cow, ${cow})
        WHERE id = ${item.id}`
  );

  const stagingBoxId = await ensureStagingBox(tx, item.receivingOrderId);
  const id = crypto.randomUUID();
  await queryRun(
    tx,
    sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_id, qty, verified)
        VALUES (${id}, ${stagingBoxId}, ${item.id}, ${item.partId}, ${a.qty}, false)`
  );
  return (await queryGet<Record<string, unknown>>(tx, sql`SELECT * FROM shelf_box_items WHERE id = ${id}`))!;
}

export async function removeScannedPiece(tx: DbOrTx, a: { scanId: string }): Promise<void> {
  const scan = await queryGet<{ id: string; shelfBoxId: string | null }>(
    tx,
    sql`SELECT id, shelf_box_id AS "shelfBoxId" FROM shelf_box_items WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "scan not found" });
  if (scan.shelfBoxId === null || (await queryGet<{ code: string | null }>(tx, sql`SELECT shelf_code AS code FROM shelf_boxes WHERE id = ${scan.shelfBoxId}`))?.code !== null) {
    throw new HTTPException(409, { message: "scan is not in the staging box" });
  }
  await queryRun(tx, sql`DELETE FROM shelf_box_items WHERE id = ${scan.id}`);
}

async function markBoxStockChanged(tx: DbOrTx, shelfBoxId: string): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${shelfBoxId}`
  );
  await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

export async function assignScanToBox(
  tx: DbOrTx,
  a: { scanId: string; shelfBoxId: string; actorId?: string | null }
): Promise<void> {
  const scan = await queryGet<{ id: string; itemId: string; qty: number; shelfBoxId: string | null; partId: string }>(
    tx,
    sql`SELECT id, receiving_invoice_item_id AS "itemId", qty, shelf_box_id AS "shelfBoxId", part_id AS "partId"
        FROM shelf_box_items WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "scan not found" });
  if (scan.shelfBoxId === null || (await queryGet<{ code: string | null }>(tx, sql`SELECT shelf_code AS code FROM shelf_boxes WHERE id = ${scan.shelfBoxId}`))?.code !== null) {
    throw new HTTPException(409, { message: "scan is not in a staging box" });
  }
  const box = await loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot assign into the staging box" });
  const item = await loadItemForPutAway(tx, scan.itemId);
  if (box.receivingOrderId !== item.receivingOrderId) throw new HTTPException(409, { message: "scan and box belong to different receiving orders" });

  await queryRun(tx, sql`UPDATE shelf_box_items SET shelf_box_id = ${box.id}, verified = false WHERE id = ${scan.id}`);

  const lot = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM inventory_lots
        WHERE part_id = ${item.partId} AND shelf_code = ${box.shelfCode} AND box_id = ${box.id}
          AND date_code IS NOT DISTINCT FROM ${item.dateCode} AND lot_code IS NOT DISTINCT FROM ${item.lotCode}
          AND coo IS NOT DISTINCT FROM ${item.coo} AND cow IS NOT DISTINCT FROM ${item.cow}`
  );
  let lotId: string;
  if (lot) {
    lotId = lot.id;
    await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty + ${scan.qty} WHERE id = ${lotId}`);
  } else {
    lotId = crypto.randomUUID();
    await queryRun(
      tx,
      sql`INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty)
          VALUES (${lotId}, ${item.partId}, ${item.dateCode}, ${item.lotCode}, ${item.coo}, ${item.cow}, ${box.shelfCode}, ${box.id}, ${scan.qty}, 0)`
    );
  }

  const src = await queryGet<{ id: string }>(tx, sql`SELECT id FROM inventory_lot_sources WHERE inventory_lot_id = ${lotId} AND receiving_invoice_item_id = ${scan.itemId}`);
  if (src) await queryRun(tx, sql`UPDATE inventory_lot_sources SET qty = qty + ${scan.qty} WHERE id = ${src.id}`);
  else await queryRun(
    tx,
    sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty)
        VALUES (${crypto.randomUUID()}, ${lotId}, ${scan.itemId}, ${scan.qty})`
  );

  await applyPutAway(tx, scan.itemId, scan.qty);
  await markBoxStockChanged(tx, box.id);
  await tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export async function addAllUnboxedToBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): Promise<{ count: number }> {
  const box = await loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot add to the staging box" });
  const scans = await queryAll<{ id: string }>(
    tx,
    sql`SELECT sbi.id FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE sb.shelf_code IS NULL AND ri.receiving_order_id = ${box.receivingOrderId}
        ORDER BY sbi.id`
  );
  for (const s of scans) await assignScanToBox(tx, { scanId: s.id, shelfBoxId: box.id, actorId: a.actorId ?? null });
  return { count: scans.length };
}

export async function removeScanFromBox(tx: DbOrTx, a: { scanId: string; actorId?: string | null }): Promise<void> {
  const scan = await queryGet<{ id: string; itemId: string; qty: number; shelfBoxId: string | null }>(
    tx,
    sql`SELECT id, receiving_invoice_item_id AS "itemId", qty, shelf_box_id AS "shelfBoxId"
        FROM shelf_box_items WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "scan not found" });
  if (scan.shelfBoxId === null) throw new HTTPException(409, { message: "scan is not in a box" });
  const box = await loadShelfBox(tx, scan.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "scan is in the staging box" });
  const item = await loadItemForPutAway(tx, scan.itemId);

  const stagingBoxId = await ensureStagingBox(tx, item.receivingOrderId);
  await queryRun(tx, sql`UPDATE shelf_box_items SET shelf_box_id = ${stagingBoxId}, verified = false WHERE id = ${scan.id}`);

  const src = await queryGet<{ id: string; lotId: string; qty: number }>(
    tx,
    sql`SELECT ils.id, ils.inventory_lot_id AS "lotId", ils.qty FROM inventory_lot_sources ils
        JOIN inventory_lots il ON il.id = ils.inventory_lot_id
        WHERE ils.receiving_invoice_item_id = ${scan.itemId} AND il.box_id = ${box.id}
          AND il.date_code IS NOT DISTINCT FROM ${item.dateCode} AND il.lot_code IS NOT DISTINCT FROM ${item.lotCode}
          AND il.coo IS NOT DISTINCT FROM ${item.coo} AND il.cow IS NOT DISTINCT FROM ${item.cow}`
  );
  if (src) {
    const hasAllocations = (await queryGet<{ n: number }>(tx, sql`SELECT COUNT(*)::int AS n FROM allocations WHERE inventory_lot_id = ${src.lotId}`))!.n;
    if (hasAllocations > 0) throw new HTTPException(409, { message: "lot has pick allocations" });
    if (src.qty - scan.qty <= 0) await queryRun(tx, sql`DELETE FROM inventory_lot_sources WHERE id = ${src.id}`);
    else await queryRun(tx, sql`UPDATE inventory_lot_sources SET qty = qty - ${scan.qty} WHERE id = ${src.id}`);
    const total = (await queryGet<{ v: number }>(tx, sql`SELECT total_qty AS v FROM inventory_lots WHERE id = ${src.lotId}`))!.v;
    if (total - scan.qty <= 0) await queryRun(tx, sql`DELETE FROM inventory_lots WHERE id = ${src.lotId}`);
    else await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty - ${scan.qty} WHERE id = ${src.lotId}`);
  }

  await queryRun(tx, sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty - ${scan.qty} WHERE id = ${scan.itemId}`);
  await markBoxStockChanged(tx, box.id);
  await tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export async function verifyShelfBoxItem(
  tx: DbOrTx,
  a: { shelfBoxId: string; partId: string; actorId?: string | null }
): Promise<{ verifiedCount: number }> {
  const result = await queryRun(
    tx,
    sql`UPDATE shelf_box_items SET verified = true, verified_at = ${now()}
        WHERE shelf_box_id = ${a.shelfBoxId} AND part_id = ${a.partId} AND (verified IS NULL OR verified = false)`
  );
  if (result.changes === 0) throw new HTTPException(404, { message: "no unverified items for part in box" });
  return { verifiedCount: result.changes };
}

export async function closeShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): Promise<void> {
  const box = await loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot close the staging box" });
  const cnt = (await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM shelf_box_items WHERE shelf_box_id = ${box.id}`))!.c;
  if (cnt === 0) throw new HTTPException(409, { message: "cannot close an empty shelf box" });
  await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${box.id}`);
  await logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromState: "open", toState: "closed", actorId: a.actorId ?? null });
  if (box.receivingOrderId) await tryMarkReceivingOrderClear(tx, { receivingOrderId: box.receivingOrderId, actorId: a.actorId ?? null });
}

export async function tryMarkReceivingOrderClear(tx: DbOrTx, a: { receivingOrderId: string; actorId?: string | null }): Promise<void> {
  const order = await queryGet<{ id: string; status: string }>(tx, sql`SELECT id, status FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order || order.status !== "in_hand") return;
  const items = await queryAll<{ id: string; received: number; picked: number; putAway: number }>(
    tx,
    sql`SELECT rii.id, rii.received_qty AS received, rii.picked_qty AS picked, rii.put_away_qty AS "putAway"
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}`
  );
  if (items.length === 0) return;
  for (const it of items) {
    const remaining = await remainingAfterStaged(tx, it.id, it);
    if (remaining > 0) return;
  }
  await queryRun(tx, sql`UPDATE receiving_orders SET status = 'clear' WHERE id = ${order.id}`);
  await logTransition(tx, { entityType: "receiving_order", entityId: order.id, fromState: "in_hand", toState: "clear", actorId: a.actorId ?? null });
}
