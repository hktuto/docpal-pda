import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { confirmReceivingArrival } from "./receiving.js";
import {
  addAllUnboxedToBox,
  assignScanToBox,
  cancelShelfBox,
  closeShelfBox,
  createShelfBox,
  deleteStagedPutAwayScan,
  getPutAwayAggregate,
  listPutAwayCandidates,
  recordPutAwayScan,
  removeScanFromBox,
} from "./putaway.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

async function stagingBoxIdOf(orderId: string): Promise<string | undefined> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT sb.id FROM shelf_boxes sb
        WHERE sb.shelf_code IS NULL AND sb.status = 'open'
          AND (
            EXISTS (
              SELECT 1 FROM shelf_box_items sbi
              JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
              JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
              WHERE sbi.shelf_box_id = sb.id AND ri.receiving_order_id = ${orderId}
            )
            OR NOT EXISTS (SELECT 1 FROM shelf_box_items sbi WHERE sbi.shelf_box_id = sb.id)
          )
        ORDER BY sb.created_at
        LIMIT 1`
  );
  return row?.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

/** Confirm the pending DAITO order (04958210) into in_hand for put-away tests. */
async function daitoInHand(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  return { orderId, actorId };
}

// --- candidates ---------------------------------------------------------------

test("candidates: receivable orders with received/unboxed item counts", async () => {
  await reseed(client);

  // seed has only a clear + a pending order → no candidates
  assert.equal((await listPutAwayCandidates(client.db)).length, 0);

  const { orderId, actorId } = await daitoInHand();
  let rows = await listPutAwayCandidates(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, orderId);
  assert.equal(row.batchNo, "04958210");
  assert.equal(row.status, "in_hand");
  assert.equal(row.supplierCode, "DAITO");
  assert.equal(row.supplierName, "DAITO");
  assert.equal(row.orgId, 2);
  assert.equal(row.subInventoryCode, "STORE1");
  assert.equal(row.receivedItems, 2);
  assert.equal(row.unboxedItems, 2);

  // fully stage one item → it no longer counts as unboxed
  const p413 = await itemIdOf(orderId, "P413"); // qty 3000
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: p413, qty: 3000 });
  rows = await listPutAwayCandidates(client.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receivedItems, 2);
  assert.equal(rows[0].unboxedItems, 1);
});

// --- scan ---------------------------------------------------------------------

test("scan: staging insert creates staging box + backfills batch attrs; guards", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000, lotCode NULL in seed

  const scan = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: itemId,
    qty: 2000,
    lotCode: "L-1",
  });
  assert.equal(scan.receivingInvoiceItemId, itemId);
  assert.equal(scan.partNo, "RK73B1JTTD181G");
  assert.equal(scan.qty, 2000);
  assert.equal(scan.dateCode, "2610"); // from the item
  assert.equal(scan.lotCode, "L-1"); // backfilled from the scan

  // staging box auto-created, scan row inside it
  const stagingId = await stagingBoxIdOf(orderId);
  assert.ok(stagingId);
  const placed = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan.id}`
  );
  assert.equal(placed!.boxId, stagingId);

  // batch backfill persisted on the item
  const item = await queryGet<{ lotCode: string | null }>(
    client.db,
    sql`SELECT lot_code AS "lotCode" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.lotCode, "L-1");

  // second scan reuses the same staging box
  const scan2 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 1000 });
  const placed2 = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan2.id}`
  );
  assert.equal(placed2!.boxId, stagingId);

  // over-remaining → 409 (5000 received − 3000 staged = 2000 remaining)
  const over = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 2001 })
  );
  assert.equal(over.status, 409);
  assert.equal(over.message, "scanned_qty_exceeds_remaining");

  // validations
  const badOrder = await catchHttp(
    recordPutAwayScan(client.db, randomUUID(), { actorId, receivingInvoiceItemId: itemId, qty: 1 })
  );
  assert.equal(badOrder.status, 404);
  assert.equal(badOrder.message, "receiving_order_not_found");

  const badItem = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: randomUUID(), qty: 1 })
  );
  assert.equal(badItem.status, 404);
  assert.equal(badItem.message, "receiving_invoice_item_not_found");

  // item belonging to a different order → 404
  const koaItemId = await itemIdOf(await orderIdOf("04958166"), "RK73H1JTTD1002F");
  const wrongOrder = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: koaItemId, qty: 1 })
  );
  assert.equal(wrongOrder.status, 404);
  assert.equal(wrongOrder.message, "receiving_invoice_item_not_found");

  const badActor = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId: randomUUID(), receivingInvoiceItemId: itemId, qty: 1 })
  );
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  const badQty = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 0 })
  );
  assert.equal(badQty.status, 400);
  assert.equal(badQty.message, "qty_must_be_positive_integer");
});

test("delete staged scan: mis-scan correction; boxed scan rejected", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000

  // staged row deleted; remaining restored (full 5000 scannable again)
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 500 });
  await deleteStagedPutAwayScan(client.db, { scanId: scan.id, actorId });
  assert.equal(
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM shelf_box_items WHERE id = ${scan.id}`),
    undefined
  );
  const again = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 5000 });
  assert.equal(again.qty, 5000);

  // guards: 404 missing, 409 for a boxed scan (use the untouched P413 item)
  const missing = await catchHttp(deleteStagedPutAwayScan(client.db, { scanId: randomUUID(), actorId }));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "scan_not_found");

  const p413 = await itemIdOf(orderId, "P413"); // qty 3000
  const scan2 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: p413, qty: 100 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await assignScanToBox(client.db, { scanId: scan2.id, shelfBoxId: box.id, actorId });
  const boxed = await catchHttp(deleteStagedPutAwayScan(client.db, { scanId: scan2.id, actorId }));
  assert.equal(boxed.status, 409);
  assert.equal(boxed.message, "scan_not_in_staging_box");

  const badActor = await catchHttp(
    (async () => {
      const s = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: p413, qty: 1 });
      await deleteStagedPutAwayScan(client.db, { scanId: s.id, actorId: randomUUID() });
    })()
  );
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");
});

// --- assign -------------------------------------------------------------------

test("assign: materializes lot with shelf location, sources, put_away_qty, ledger", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 2000 });

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  assert.equal(box.status, "open");
  assert.equal(box.shelfCode, "A-01-03");

  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });

  // scan moved into the box
  const moved = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan.id}`
  );
  assert.equal(moved!.boxId, box.id);

  // lot stamped with the item's batch attrs + the box's location pair
  const lot = await queryGet<{
    id: string;
    partNo: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string;
    boxId: string;
    orgId: number | null;
    subInventoryCode: string | null;
    totalQty: number;
    allocatedQty: number;
  }>(
    client.db,
    sql`SELECT id, part_no AS "partNo", date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
               shelf_code AS "shelfCode", box_id AS "boxId",
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode",
               total_qty AS "totalQty", allocated_qty AS "allocatedQty"
        FROM inventory_lots WHERE box_id = ${box.id}`
  );
  assert.ok(lot);
  assert.equal(lot.partNo, "RK73B1JTTD181G");
  assert.equal(lot.shelfCode, "A-01-03");
  assert.equal(lot.boxId, box.id);
  assert.equal(lot.dateCode, "2610");
  assert.equal(lot.coo, "JP");
  assert.equal(lot.orgId, 2);
  assert.equal(lot.subInventoryCode, "STORE1");
  assert.equal(lot.totalQty, 2000);
  assert.equal(lot.allocatedQty, 0);

  // lot source row
  const src = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = ${lot.id} AND receiving_invoice_item_id = ${itemId}`
  );
  assert.equal(src!.qty, 2000);

  // put_away_qty applied
  const item = await queryGet<{ putAway: number }>(
    client.db,
    sql`SELECT put_away_qty AS "putAway" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.putAway, 2000);

  // two ledger rows: dock −qty / on_hand +qty
  const txns = await queryAll<{
    txnType: string;
    qtyType: string;
    qtyDelta: number;
    lotId: string | null;
    shelfCode: string | null;
    boxId: string | null;
    referenceType: string | null;
    referenceId: string | null;
    itemId: string | null;
    actorId: string | null;
    dateCode: string | null;
  }>(
    client.db,
    sql`SELECT txn_type AS "txnType", qty_type AS "qtyType", qty_delta AS "qtyDelta",
               inventory_lot_id AS "lotId", shelf_code AS "shelfCode", box_id AS "boxId",
               reference_type AS "referenceType", reference_id AS "referenceId",
               receiving_invoice_item_id AS "itemId", actor_id AS "actorId", date_code AS "dateCode"
        FROM inventory_transactions WHERE txn_type = 'PUT_AWAY'`
  );
  assert.equal(txns.length, 2);
  const byType = new Map(txns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("dock")!.qtyDelta, -2000);
  assert.equal(byType.get("on_hand")!.qtyDelta, 2000);
  for (const t of txns) {
    assert.equal(t.lotId, lot.id);
    assert.equal(t.shelfCode, "A-01-03");
    assert.equal(t.boxId, box.id);
    assert.equal(t.referenceType, "shelf_box");
    assert.equal(t.referenceId, box.id);
    assert.equal(t.itemId, itemId);
    assert.equal(t.actorId, actorId);
    assert.equal(t.dateCode, "2610");
  }
});

test("assign: same part/batch/box merges into the same lot", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const scan1 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 1000 });
  const scan2 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 1500 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });

  await assignScanToBox(client.db, { scanId: scan1.id, shelfBoxId: box.id, actorId });
  await assignScanToBox(client.db, { scanId: scan2.id, shelfBoxId: box.id, actorId });

  const lots = await queryAll<{ id: string; totalQty: number }>(
    client.db,
    sql`SELECT id, total_qty AS "totalQty" FROM inventory_lots WHERE box_id = ${box.id}`
  );
  assert.equal(lots.length, 1);
  assert.equal(lots[0].totalQty, 2500);

  const src = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = ${lots[0].id} AND receiving_invoice_item_id = ${itemId}`
  );
  assert.equal(src!.qty, 2500);

  const item = await queryGet<{ putAway: number }>(
    client.db,
    sql`SELECT put_away_qty AS "putAway" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.putAway, 2500);
});

test("assign guards: staging/box state/order mismatch/actor", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });

  const badActor = await catchHttp(assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  const noScan = await catchHttp(assignScanToBox(client.db, { scanId: randomUUID(), shelfBoxId: box.id, actorId }));
  assert.equal(noScan.status, 404);
  assert.equal(noScan.message, "scan_not_found");

  const noBox = await catchHttp(assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: "SBOX-9999", actorId }));
  assert.equal(noBox.status, 404);
  assert.equal(noBox.message, "shelf_box_not_found");

  // cannot assign into the staging box itself
  const stagingId = (await stagingBoxIdOf(orderId))!;
  const intoStaging = await catchHttp(assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: stagingId, actorId }));
  assert.equal(intoStaging.status, 409);
  assert.equal(intoStaging.message, "cannot_assign_into_staging_box");

  // box of a different receiving order (the cleared KOA order)
  const koaBox = await createShelfBox(client.db, {
    receivingOrderId: await orderIdOf("04958166"),
    shelfCode: "A-01-04",
    actorId,
  });
  const wrongOrder = await catchHttp(assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: koaBox.id, actorId }));
  assert.equal(wrongOrder.status, 409);
  assert.equal(wrongOrder.message, "different_receiving_orders");

  // happy path, then: scan no longer in staging + box no longer open
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });
  const again = await catchHttp(assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "scan_not_in_staging_box");

  const scan2 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  await closeShelfBox(client.db, { shelfBoxId: box.id, actorId });
  const closed = await catchHttp(assignScanToBox(client.db, { scanId: scan2.id, shelfBoxId: box.id, actorId }));
  assert.equal(closed.status, 409);
  assert.equal(closed.message, "shelf_box_not_open");
});

// --- remove from box ------------------------------------------------------------

test("remove-from-box: reverses lot/sources/put_away_qty with reverse ledger rows", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan1 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 1000 });
  const scan2 = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 1500 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await assignScanToBox(client.db, { scanId: scan1.id, shelfBoxId: box.id, actorId });
  await assignScanToBox(client.db, { scanId: scan2.id, shelfBoxId: box.id, actorId });
  const lot = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM inventory_lots WHERE box_id = ${box.id}`))!;

  // partial removal: lot + source shrink, scan back to staging
  await removeScanFromBox(client.db, { shelfBoxId: box.id, scanId: scan1.id, actorId });
  const after = await queryGet<{ totalQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE id = ${lot.id}`
  );
  assert.equal(after!.totalQty, 1500);
  const src = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = ${lot.id}`
  );
  assert.equal(src!.qty, 1500);
  const item = await queryGet<{ putAway: number }>(
    client.db,
    sql`SELECT put_away_qty AS "putAway" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.putAway, 1500);
  const backInStaging = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan1.id}`
  );
  assert.equal(backInStaging!.boxId, (await stagingBoxIdOf(orderId))!);

  // reverse ledger rows reference the surviving lot
  const reverseTxns = await queryAll<{ qtyType: string; qtyDelta: number; lotId: string | null }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta", inventory_lot_id AS "lotId"
        FROM inventory_transactions WHERE txn_type = 'PUT_AWAY' AND txn_reason = 'remove from box'`
  );
  assert.equal(reverseTxns.length, 2);
  const byType = new Map(reverseTxns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("dock")!.qtyDelta, 1000);
  assert.equal(byType.get("on_hand")!.qtyDelta, -1000);
  assert.equal(byType.get("dock")!.lotId, lot.id);
});

test("remove-from-box: deletes the emptied lot (ledger rows not referencing it)", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 2000 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });
  const lot = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM inventory_lots WHERE box_id = ${box.id}`))!;

  await removeScanFromBox(client.db, { shelfBoxId: box.id, scanId: scan.id, actorId });

  assert.equal(await queryGet(client.db, sql`SELECT id FROM inventory_lots WHERE id = ${lot.id}`), undefined);
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM inventory_lot_sources WHERE inventory_lot_id = ${lot.id}`),
    undefined
  );
  const item = await queryGet<{ putAway: number }>(
    client.db,
    sql`SELECT put_away_qty AS "putAway" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.putAway, 0);

  const reverseTxns = await queryAll<{ qtyType: string; qtyDelta: number; lotId: string | null }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta", inventory_lot_id AS "lotId"
        FROM inventory_transactions WHERE txn_type = 'PUT_AWAY' AND txn_reason = 'remove from box'`
  );
  assert.equal(reverseTxns.length, 2);
  const byType = new Map(reverseTxns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("dock")!.qtyDelta, 2000);
  assert.equal(byType.get("on_hand")!.qtyDelta, -2000);
  assert.equal(byType.get("dock")!.lotId, null); // lot deleted — no dangling FK

  // the assign ledger rows survive (detached from the deleted lot, not removed)
  const allTxns = await queryAll<{ lotId: string | null }>(
    client.db,
    sql`SELECT inventory_lot_id AS "lotId" FROM inventory_transactions
        WHERE txn_type = 'PUT_AWAY' AND reference_id = ${box.id}`
  );
  assert.equal(allTxns.length, 4);
  assert.ok(allTxns.every((t) => t.lotId === null));
});

test("remove-from-box: 409 when the lot has pick allocations", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 2000 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });
  const lot = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM inventory_lots WHERE box_id = ${box.id}`))!;

  const pickingItem = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no = 'SO-2026-0001' LIMIT 1`
  );
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_at, updated_at)
        VALUES (${randomUUID()}, ${pickingItem!.id}, ${lot.id}, 100, now(), now())`
  );

  const err = await catchHttp(removeScanFromBox(client.db, { shelfBoxId: box.id, scanId: scan.id, actorId }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "lot_has_pick_allocations");

  // rolled back: scan still in the box, lot untouched
  const placed = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan.id}`
  );
  assert.equal(placed!.boxId, box.id);
  const untouched = await queryGet<{ totalQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE id = ${lot.id}`
  );
  assert.equal(untouched!.totalQty, 2000);
});

// --- add-all-unboxed --------------------------------------------------------------

test("add-all-unboxed: assigns every staging scan of the order", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const item1 = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const item2 = await itemIdOf(orderId, "P413"); // qty 3000
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item1, qty: 2000 });
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item1, qty: 1000 });
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item2, qty: 3000 });

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  const result = await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });
  assert.equal(result.count, 3);

  // staging box empty; box holds all three rows
  const staged = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id WHERE sb.shelf_code IS NULL`
  );
  assert.equal(staged!.c, 0);
  const boxed = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM shelf_box_items WHERE shelf_box_id = ${box.id}`
  );
  assert.equal(boxed!.c, 3);

  // two lots (one per part); the two same-part scans merged
  const lots = await queryAll<{ totalQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE box_id = ${box.id} ORDER BY total_qty`
  );
  assert.deepEqual(lots.map((l) => l.totalQty), [3000, 3000]);

  // empty add-all is a no-op
  const again = await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });
  assert.equal(again.count, 0);
});

// --- close --------------------------------------------------------------------

test("close: guards + happy path + transition log", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });

  const empty = await catchHttp(closeShelfBox(client.db, { shelfBoxId: box.id, actorId }));
  assert.equal(empty.status, 409);
  assert.equal(empty.message, "cannot_close_empty_shelf_box");

  const stagingId = (await stagingBoxIdOf(orderId))!;
  const staging = await catchHttp(closeShelfBox(client.db, { shelfBoxId: stagingId, actorId }));
  assert.equal(staging.status, 409);
  assert.equal(staging.message, "cannot_close_staging_box");

  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });
  await closeShelfBox(client.db, { shelfBoxId: box.id, actorId });
  const closed = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM shelf_boxes WHERE id = ${box.id}`
  );
  assert.equal(closed!.status, "closed");

  const logs = await queryAll<{ fromState: string | null; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'shelf_box' AND entity_id = ${box.id}
        ORDER BY created_at, id`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState, l.actorId]),
    [
      [null, "open", actorId],
      ["open", "closed", actorId],
    ]
  );

  const again = await catchHttp(closeShelfBox(client.db, { shelfBoxId: box.id, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "shelf_box_not_open");
});

// --- auto-clear -----------------------------------------------------------------

test("auto-clear: fully put-away order flips to clear (+ transition log)", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const item1 = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const item2 = await itemIdOf(orderId, "P413"); // qty 3000
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item1, qty: 5000 });
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item2, qty: 3000 });

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });

  const order = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "clear");

  const logs = await queryAll<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}
        ORDER BY created_at, id`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState]),
    [
      ["pending", "in_hand"],
      ["in_hand", "clear"],
    ]
  );

  // cleared orders drop out of the candidates list
  assert.equal((await listPutAwayCandidates(client.db)).length, 0);
});

// --- cancel -------------------------------------------------------------------

test("cancel: guards + hard delete + transition log", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await cancelShelfBox(client.db, { shelfBoxId: box.id, actorId });
  assert.equal(await queryGet(client.db, sql`SELECT id FROM shelf_boxes WHERE id = ${box.id}`), undefined);
  const cancelLog = await queryGet<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'shelf_box' AND entity_id = ${box.id} AND to_state = 'cancelled'`
  );
  assert.deepEqual(cancelLog, { fromState: "open", toState: "cancelled" });

  const gone = await catchHttp(cancelShelfBox(client.db, { shelfBoxId: box.id, actorId }));
  assert.equal(gone.status, 404);
  assert.equal(gone.message, "shelf_box_not_found");

  // non-empty box
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  const box2 = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-04", actorId });
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box2.id, actorId });
  const notEmpty = await catchHttp(cancelShelfBox(client.db, { shelfBoxId: box2.id, actorId }));
  assert.equal(notEmpty.status, 409);
  assert.equal(notEmpty.message, "shelf_box_not_empty");

  // staging box
  const stagingId = (await stagingBoxIdOf(orderId))!;
  const staging = await catchHttp(cancelShelfBox(client.db, { shelfBoxId: stagingId, actorId }));
  assert.equal(staging.status, 409);
  assert.equal(staging.message, "cannot_cancel_staging_box");

  // closed box
  await removeScanFromBox(client.db, { shelfBoxId: box2.id, scanId: scan.id, actorId });
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box2.id, actorId });
  await closeShelfBox(client.db, { shelfBoxId: box2.id, actorId });
  const closed = await catchHttp(cancelShelfBox(client.db, { shelfBoxId: box2.id, actorId }));
  assert.equal(closed.status, 409);
  assert.equal(closed.message, "shelf_box_not_open");

  const badActor = await catchHttp(cancelShelfBox(client.db, { shelfBoxId: box2.id, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");
});

// --- aggregate read -------------------------------------------------------------

test("aggregate: order + lots + staging scans + boxes with items; 404", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const item1 = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const item2 = await itemIdOf(orderId, "P413"); // qty 3000
  const assigned = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item1, qty: 2000 });
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item1, qty: 500 });
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: item2, qty: 3000 });

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  await assignScanToBox(client.db, { scanId: assigned.id, shelfBoxId: box.id, actorId });

  const agg = await getPutAwayAggregate(client.db, orderId);
  assert.deepEqual(agg.order, { id: orderId, batchNo: "04958210", status: "in_hand" });

  // expected items block: the receivable list with remaining after put-away +
  // staged (received − picked − put_away − allocated − staged)
  assert.equal(agg.items.length, 2);
  const byPart = new Map(agg.items.map((i) => [i.partNo, i]));
  const exp1 = byPart.get("RK73B1JTTD181G")!;
  assert.deepEqual(
    [exp1.id, exp1.lineQty, exp1.receivedQty, exp1.pickedQty, exp1.putAwayQty, exp1.allocatedQty, exp1.remainingQty],
    [item1, 5000, 5000, 0, 2000, 0, 2500] // 2000 boxed + 500 staged
  );
  assert.equal(exp1.dateCode, "2610");
  assert.equal(exp1.coo, "JP");
  const exp2 = byPart.get("P413")!;
  assert.deepEqual(
    [exp2.id, exp2.lineQty, exp2.receivedQty, exp2.putAwayQty, exp2.remainingQty],
    [item2, 3000, 3000, 0, 0] // fully staged
  );

  assert.equal(agg.lots.length, 1);
  const lot = agg.lots[0];
  assert.equal(lot.partNo, "RK73B1JTTD181G");
  assert.equal(lot.shelfCode, "A-01-03");
  assert.equal(lot.boxId, box.id);
  assert.equal(lot.dateCode, "2610");
  assert.equal(lot.orgId, 2);
  assert.equal(lot.subInventoryCode, "STORE1");
  assert.equal(lot.totalQty, 2000);
  assert.equal(lot.allocatedQty, 0);
  assert.equal(lot.availableQty, 2000);

  // the two unassigned scans stay in staging
  assert.equal(agg.scans.length, 2);
  assert.deepEqual(
    agg.scans.map((s) => s.qty).sort((a, b) => a - b),
    [500, 3000]
  );
  for (const s of agg.scans) {
    assert.ok(s.id && s.receivingInvoiceItemId && s.partNo);
  }

  assert.equal(agg.boxes.length, 1);
  assert.equal(agg.boxes[0].id, box.id);
  assert.equal(agg.boxes[0].shelfCode, "A-01-03");
  assert.equal(agg.boxes[0].status, "open");
  assert.equal(agg.boxes[0].items.length, 1);
  const boxItem = agg.boxes[0].items[0];
  assert.equal(boxItem.id, assigned.id);
  assert.equal(boxItem.partNo, "RK73B1JTTD181G");
  assert.equal(boxItem.qty, 2000);
  assert.equal(boxItem.verified, false);

  const notFound = await catchHttp(getPutAwayAggregate(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "receiving_order_not_found");
});

// --- scanned box id (createShelfBox boxId) --------------------------------------

test("create with scanned boxId: custom id, open-same-order reuse, conflicts", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();

  // scanned physical box id replaces the server-generated id
  const box = await createShelfBox(client.db, {
    receivingOrderId: orderId,
    shelfCode: "A-01-03",
    actorId,
    boxId: "PHYS-BOX-001",
  });
  assert.equal(box.id, "PHYS-BOX-001");
  assert.equal(box.status, "open");
  assert.equal(box.shelfCode, "A-01-03");

  // re-scanning the same open box of this order returns it unchanged (shelf NOT moved)
  const again = await createShelfBox(client.db, {
    receivingOrderId: orderId,
    shelfCode: "A-01-04",
    actorId,
    boxId: "PHYS-BOX-001",
  });
  assert.equal(again.id, "PHYS-BOX-001");
  assert.equal(again.shelfCode, "A-01-03");

  // blank id → 400
  const blank = await catchHttp(
    createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId, boxId: "   " })
  );
  assert.equal(blank.status, 400);
  assert.equal(blank.message, "box_id_required");

  // open box belonging to a different order → 409
  await createShelfBox(client.db, {
    receivingOrderId: await orderIdOf("04958166"),
    shelfCode: "A-01-04",
    actorId,
    boxId: "PHYS-BOX-002",
  });
  const otherOrder = await catchHttp(
    createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId, boxId: "PHYS-BOX-002" })
  );
  assert.equal(otherOrder.status, 409);
  assert.equal(otherOrder.message, "box_id_already_exists");

  // closed box id → 409
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId, boxId: "PHYS-BOX-003" });
  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: "PHYS-BOX-003", actorId });
  await closeShelfBox(client.db, { shelfBoxId: "PHYS-BOX-003", actorId });
  const closed = await catchHttp(
    createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId, boxId: "PHYS-BOX-003" })
  );
  assert.equal(closed.status, 409);
  assert.equal(closed.message, "box_id_already_exists");
});

// --- scan straight into a box (recordPutAwayScan shelfBoxId) ---------------------

test("scan with shelfBoxId: lands directly in the box (lot + ledger); guards roll back", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });

  const scan = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: itemId,
    qty: 2000,
    shelfBoxId: box.id,
  });

  // the scan row sits in the real box; nothing left in staging
  const placed = await queryGet<{ boxId: string }>(
    client.db,
    sql`SELECT shelf_box_id AS "boxId" FROM shelf_box_items WHERE id = ${scan.id}`
  );
  assert.equal(placed!.boxId, box.id);
  const staged = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id WHERE sb.shelf_code IS NULL`
  );
  assert.equal(staged!.c, 0);

  // lot + source + put_away_qty materialized, two PUT_AWAY ledger rows
  const lot = await queryGet<{ id: string; totalQty: number; shelfCode: string }>(
    client.db,
    sql`SELECT id, total_qty AS "totalQty", shelf_code AS "shelfCode" FROM inventory_lots WHERE box_id = ${box.id}`
  );
  assert.equal(lot!.shelfCode, "A-01-03");
  assert.equal(lot!.totalQty, 2000);
  const src = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM inventory_lot_sources WHERE inventory_lot_id = ${lot!.id} AND receiving_invoice_item_id = ${itemId}`
  );
  assert.equal(src!.qty, 2000);
  const item = await queryGet<{ putAway: number }>(
    client.db,
    sql`SELECT put_away_qty AS "putAway" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(item!.putAway, 2000);
  const txns = await queryAll<{ qtyType: string; qtyDelta: number }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta" FROM inventory_transactions WHERE txn_type = 'PUT_AWAY'`
  );
  assert.equal(txns.length, 2);
  const byType = new Map(txns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("dock")!.qtyDelta, -2000);
  assert.equal(byType.get("on_hand")!.qtyDelta, 2000);

  // closed box → 409, and the staging insert rolls back with it
  await closeShelfBox(client.db, { shelfBoxId: box.id, actorId });
  const closedErr = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100, shelfBoxId: box.id })
  );
  assert.equal(closedErr.status, 409);
  assert.equal(closedErr.message, "shelf_box_not_open");
  const stagedAfter = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id WHERE sb.shelf_code IS NULL`
  );
  assert.equal(stagedAfter!.c, 0);

  // box of a different order → 409
  const koaBox = await createShelfBox(client.db, {
    receivingOrderId: await orderIdOf("04958166"),
    shelfCode: "A-01-04",
    actorId,
  });
  const wrongOrder = await catchHttp(
    recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100, shelfBoxId: koaBox.id })
  );
  assert.equal(wrongOrder.status, 409);
  assert.equal(wrongOrder.message, "different_receiving_orders");
});

test("assign: lot takes the BOX's location pair, not the receiving order's", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const scan = await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 500 });

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  // admin overrides the box's pair after creation (the box decides the stock
  // partition since 2026-07-23 — not the receiving order)
  await client.db.execute(
    sql`UPDATE shelf_boxes SET org_id = 220, sub_inventory_code = 'THHK2' WHERE id = ${box.id}`
  );

  await assignScanToBox(client.db, { scanId: scan.id, shelfBoxId: box.id, actorId });

  const lot = await queryGet<{ orgId: number | null; subInventoryCode: string | null }>(
    client.db,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode" FROM inventory_lots WHERE box_id = ${box.id}`
  );
  assert.equal(lot!.orgId, 220);
  assert.equal(lot!.subInventoryCode, "THHK2");
});
