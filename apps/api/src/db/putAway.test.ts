import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import { resetTables } from "./tables.js";
import {
  createShelfBox,
  cancelShelfBox,
  recordPutAwayScan,
  removeScannedPiece,
  assignScanToBox,
  addAllUnboxedToBox,
  removeScanFromBox,
  closeShelfBox,
} from "./putAway.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql: sqlClient, db } = await createTestDb();

const TS = "2026-01-01T00:00:00.000Z";

async function seedBase() {
  await db.execute(sql`INSERT INTO users (id, username, password_hash, display_name, role, created_at)
    VALUES ('u1','op','pw','Op','operator',${TS})`);
  await db.execute(sql`INSERT INTO suppliers (id, code, name) VALUES ('sup','S','Sup')`);
  await db.execute(sql`INSERT INTO receiving_orders (id, ref_no, status, supplier_id, created_at, updated_at)
    VALUES ('ro','RO-1','in_hand','sup',${TS},${TS})`);
  await db.execute(sql`INSERT INTO shelves (code, location_type, created_at, updated_at)
    VALUES ('A1','shelf',${TS},${TS})`);
}

async function seedReceivableItem() {
  await db.execute(sql`INSERT INTO parts (id, part_no) VALUES ('p','X')`);
  await db.execute(sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv','ro','INV-1','sup',${TS},${TS})`);
  await db.execute(sql`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
    VALUES ('rii','inv','p',10,10)`);
}

async function seedDb() {
  await resetTables(db);
  await seedBase();
}

function stagingOf(itemId: string) {
  return db.execute<{ shelfBoxId: string | null }>(sql`
    SELECT sb.id AS "shelfBoxId"
    FROM shelf_box_items sbi
    JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
    WHERE sbi.id = ${itemId} AND sb.shelf_code IS NULL
  `).then((r) => r[0]?.shelfBoxId ?? null);
}

test("createShelfBox creates an open box scoped to the order + shelf; cancelShelfBox deletes an empty open box", async () => {
  await seedDb();
  const created = await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1", actorId: "u1" })
  );
  const { id } = created as { id: string };
  assert.match(id, /^SBOX-\d{4}$/);
  assert.equal(created.shelf_code, "A1");
  assert.equal(created.receiving_order_id, "ro");
  assert.equal(created.status, "open");

  const [box] = await db.execute<{ receiving_order_id: string; shelf_code: string; status: string }>(
    sql`SELECT receiving_order_id, shelf_code, status FROM shelf_boxes WHERE id = ${id}`
  );
  assert.deepEqual(box, { receiving_order_id: "ro", shelf_code: "A1", status: "open" });

  const c = (await db.execute<{ c: number }>(
    sql`SELECT COUNT(*)::int c FROM transaction_logs WHERE entity_type='shelf_box' AND to_state='open'`
  ))[0].c;
  assert.equal(c, 1);

  await db.transaction(async (tx) => cancelShelfBox(tx, { shelfBoxId: id, actorId: "u1" }));
  const c2 = (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM shelf_boxes WHERE id = ${id}`))[0].c;
  assert.equal(c2, 0);
  await assertInvariantsHold(db);
});

test("cancelled shelf-box ids are never reissued", async () => {
  await seedDb();
  const first = await db.transaction(async (tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.equal(first.id, "SBOX-0001");
  await db.transaction(async (tx) => cancelShelfBox(tx, { shelfBoxId: first.id as string }));
  const second = await db.transaction(async (tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.equal(second.id, "SBOX-0002");
  await assertInvariantsHold(db);
});

test("create/cancel guards: 404 order, 404 shelf, 409 cancel non-open", async () => {
  await seedDb();
  await assert.rejects(
    async () => db.transaction(async (tx) => createShelfBox(tx, { receivingOrderId: "nope", shelfCode: "A1" })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "ZZ" })),
    (e: any) => e.status === 404
  );
  const { id } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.execute(sql`UPDATE shelf_boxes SET status='closed' WHERE id = ${id}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => cancelShelfBox(tx, { shelfBoxId: id })),
    (e: any) => e.status === 409
  );
});

test("recordPutAwayScan drops an unboxed scan in the staging box; over-scan 409; removeScannedPiece deletes unboxed", async () => {
  await seedDb();
  await seedReceivableItem();
  const scan = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4, dateCode: "D1" })
  )) as any;
  const { id } = scan;
  assert.equal(scan.receiving_invoice_item_id, "rii");
  assert.equal(scan.qty, 4);
  assert.ok(scan.shelf_box_id, "scan should live in a staging box");
  assert.equal(scan.verified, false);

  const [row] = await db.execute<{
    receiving_invoice_item_id: string;
    qty: number;
    shelf_box_id: string;
  }>(sql`SELECT receiving_invoice_item_id, qty, shelf_box_id FROM shelf_box_items WHERE id = ${id}`);
  assert.equal(row.receiving_invoice_item_id, "rii");
  assert.equal(row.qty, 4);
  assert.ok(row.shelf_box_id);
  assert.equal(
    (await db.execute<{ date_code: string | null }>(sql`SELECT date_code FROM receiving_invoice_items WHERE id = 'rii'`))[0].date_code,
    "D1"
  );

  // 4 scanned + another 7 would exceed remaining 10
  await assert.rejects(
    async () => db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 7 })),
    (e: any) => e.status === 409
  );
  await db.transaction(async (tx) => removeScannedPiece(tx, { scanId: id }));
  const c = (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM shelf_box_items WHERE id = ${id}`))[0].c;
  assert.equal(c, 0);
  await assertInvariantsHold(db);
});

test("record/remove guards: 404 item, 400 bad qty, 404 scan, 409 remove boxed", async () => {
  await seedDb();
  await seedReceivableItem();
  await assert.rejects(
    async () => db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "nope", qty: 1 })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 0 })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1.5 })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScannedPiece(tx, { scanId: "nope" })),
    (e: any) => e.status === 404
  );
  const { id } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId: id, shelfBoxId: boxId }));
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScannedPiece(tx, { scanId: id })),
    (e: any) => e.status === 409
  );
});

test("assignScanToBox boxes the scan, materializes the lot, reduces availability, clears order", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 10, dateCode: "D1", lotCode: "L1" })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId, actorId: "u1" }));

  assert.equal(
    (await db.execute<{ shelf_box_id: string | null }>(sql`SELECT shelf_box_id FROM shelf_box_items WHERE id = ${scanId}`))[0]
      .shelf_box_id,
    boxId
  );
  const [lot] = await db.execute<{
    part_id: string;
    shelf_code: string;
    box_id: string;
    total_qty: number;
    date_code: string | null;
    lot_code: string | null;
  }>(sql`SELECT part_id, shelf_code, box_id, total_qty, date_code, lot_code FROM inventory_lots WHERE box_id = ${boxId}`);
  assert.deepEqual(lot, { part_id: "p", shelf_code: "A1", box_id: boxId, total_qty: 10, date_code: "D1", lot_code: "L1" });
  assert.equal(
    (await db.execute<{ qty: number }>(sql`SELECT qty FROM inventory_lot_sources WHERE receiving_invoice_item_id='rii'`))[0].qty,
    10
  );
  const rii = (await db.execute<{ put_away_qty: number }>(
    sql`SELECT put_away_qty FROM receiving_invoice_items WHERE id='rii'`
  ))[0];
  assert.equal(rii.put_away_qty, 10);
  assert.equal(
    (await db.execute<{ status: string }>(sql`SELECT status FROM receiving_orders WHERE id='ro'`))[0].status,
    "clear"
  );
  await assertInvariantsHold(db);
});

test("assignScanToBox guards: 404 scan, 409 already boxed, 409 box not open", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await assert.rejects(
    async () => db.transaction(async (tx) => assignScanToBox(tx, { scanId: "nope", shelfBoxId: boxId })),
    (e: any) => e.status === 404
  );
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 })
  )) as any;
  const { id: otherBoxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: otherBoxId }));
  await assert.rejects(
    async () => db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId })),
    (e: any) => e.status === 409
  );
  const { id: scanId2 } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 })
  )) as any;
  await db.execute(sql`UPDATE shelf_boxes SET status='closed' WHERE id = ${boxId}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => assignScanToBox(tx, { scanId: scanId2, shelfBoxId: boxId })),
    (e: any) => e.status === 409
  );
});

test("addAllUnboxedToBox boxes every unboxed scan of the box's order", async () => {
  await seedDb();
  await seedReceivableItem();
  await db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4 }));
  await db.transaction(async (tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 6 }));
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  const { count } = await db.transaction(async (tx) =>
    addAllUnboxedToBox(tx, { shelfBoxId: boxId, actorId: "u1" })
  );
  assert.equal(count, 2);
  const c = (await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int c FROM shelf_box_items sbi
    JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
    WHERE sb.shelf_code IS NULL
  `))[0].c;
  assert.equal(c, 0);
  assert.equal(
    (await db.execute<{ status: string }>(sql`SELECT status FROM receiving_orders WHERE id='ro'`))[0].status,
    "clear"
  );
  await assertInvariantsHold(db);
});

test("removeScanFromBox reverses the assignment (scan back to staging, lot + source removed, availability restored)", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 10 })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  await db.transaction(async (tx) => removeScanFromBox(tx, { scanId, actorId: "u1" }));

  const backInStaging = await stagingOf(scanId);
  assert.ok(backInStaging, "scan should be back in the staging box");
  assert.equal(
    (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM inventory_lots WHERE box_id = ${boxId}`))[0].c,
    0
  );
  assert.equal(
    (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM inventory_lot_sources WHERE receiving_invoice_item_id='rii'`))[0].c,
    0
  );
  const rii = (await db.execute<{ put_away_qty: number }>(
    sql`SELECT put_away_qty FROM receiving_invoice_items WHERE id='rii'`
  ))[0];
  assert.equal(rii.put_away_qty, 0);
  await assertInvariantsHold(db);
});

test("remove/close guards: 404 scan, 409 not in box, 409 box not open; close 409 empty + not open", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 })
  )) as any;
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScanFromBox(tx, { scanId: "nope" })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScanFromBox(tx, { scanId })),
    (e: any) => e.status === 409
  );
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  await db.execute(sql`UPDATE shelf_boxes SET status='closed' WHERE id = ${boxId}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScanFromBox(tx, { scanId })),
    (e: any) => e.status === 409
  );

  const { id: empty } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await assert.rejects(
    async () => db.transaction(async (tx) => closeShelfBox(tx, { shelfBoxId: empty })),
    (e: any) => e.status === 409
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => closeShelfBox(tx, { shelfBoxId: boxId })),
    (e: any) => e.status === 409
  );
});

test("closeShelfBox closes a non-empty open box + logs transition", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 2 })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  await db.transaction(async (tx) => closeShelfBox(tx, { shelfBoxId: boxId, actorId: "u1" }));
  assert.equal(
    (await db.execute<{ status: string }>(sql`SELECT status FROM shelf_boxes WHERE id = ${boxId}`))[0].status,
    "closed"
  );
  assert.equal(
    (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM transaction_logs WHERE entity_type='shelf_box' AND to_state='closed'`))[0].c,
    1
  );
  await assertInvariantsHold(db);
});

test("removeScanFromBox reverses only the matching attribute lot when a box holds lots of the same item", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scan1 } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 3, dateCode: "D1" })
  )) as any;
  const { id: scan2 } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4, dateCode: "D2" })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId: scan1, shelfBoxId: boxId }));
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId: scan2, shelfBoxId: boxId }));
  await db.transaction(async (tx) => removeScanFromBox(tx, { scanId: scan2, actorId: "u1" }));

  const d1 = (await db.execute<{ total_qty: number }>(
    sql`SELECT total_qty FROM inventory_lots WHERE box_id = ${boxId} AND date_code = 'D1'`
  ))[0];
  assert.equal(d1.total_qty, 3);
  assert.equal(
    (await db.execute<{ c: number }>(sql`SELECT COUNT(*)::int c FROM inventory_lots WHERE box_id = ${boxId} AND date_code = 'D2'`))[0].c,
    0
  );
  assert.equal(
    (await db.execute<{ qty: number }>(sql`SELECT qty FROM inventory_lot_sources WHERE receiving_invoice_item_id='rii'`))[0].qty,
    3
  );
  const rii = (await db.execute<{ put_away_qty: number }>(
    sql`SELECT put_away_qty FROM receiving_invoice_items WHERE id='rii'`
  ))[0];
  assert.equal(rii.put_away_qty, 3);
  await assertInvariantsHold(db);
});

test("removeScanFromBox 409s when the lot has pick allocations (lot untouched)", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 5 })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  await db.execute(sql`UPDATE inventory_lots SET allocated_qty = 2 WHERE box_id = ${boxId}`);
  await db.execute(sql`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at)
    VALUES ('po','PO-1','picking',${TS},${TS})`);
  await db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at)
    VALUES ('pi','po','p',2,${TS},${TS})`);
  await db.execute(sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
    SELECT 'alloc','pi',2,id,${TS},${TS} FROM inventory_lots WHERE box_id = ${boxId}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScanFromBox(tx, { scanId })),
    (e: any) => e.status === 409
  );
  const lot = (await db.execute<{ total_qty: number; allocated_qty: number }>(
    sql`SELECT total_qty, allocated_qty FROM inventory_lots WHERE box_id = ${boxId}`
  ))[0];
  assert.deepEqual(lot, { total_qty: 5, allocated_qty: 2 });
});

test("removeScanFromBox 409s on a fully-picked allocation residue (qty 0 row still references the lot)", async () => {
  await seedDb();
  await seedReceivableItem();
  const { id: scanId } = (await db.transaction(async (tx) =>
    recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 5 })
  )) as any;
  const { id: boxId } = (await db.transaction(async (tx) =>
    createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" })
  )) as { id: string };
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  await db.execute(sql`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at)
    VALUES ('po','PO-1','picking',${TS},${TS})`);
  await db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at)
    VALUES ('pi','po','p',5,${TS},${TS})`);
  await db.execute(sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
    SELECT 'alloc','pi',0,id,${TS},${TS} FROM inventory_lots WHERE box_id = ${boxId}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScanFromBox(tx, { scanId })),
    (e: any) => e.status === 409 && /pick allocations/.test(e.message)
  );
  assert.equal(
    (await db.execute<{ total_qty: number }>(sql`SELECT total_qty FROM inventory_lots WHERE box_id = ${boxId}`))[0].total_qty,
    5
  );
});

test.after(async () => {
  await sqlClient.end();
});
