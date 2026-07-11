import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { createShelfBox, cancelShelfBox, recordPutAwayScan, removeScannedPiece } from "./putAway.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
  `);
  return { sqlite, db };
}

test("createShelfBox creates an open box scoped to the order + shelf; cancelShelfBox deletes an empty open box", () => {
  const { sqlite, db } = makeDb();
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1", actorId: "u1" }));
  assert.match(id, /^SBOX-\d{4}$/);
  const box = sqlite.prepare("SELECT receiving_order_id, shelf_code, status FROM shelf_boxes WHERE id=?").get(id) as any;
  assert.deepEqual(box, { receiving_order_id: "ro", shelf_code: "A1", status: "open" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shelf_box' AND to_status='open'").get() as any).c, 1);

  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shelf_boxes WHERE id=?").get(id) as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("cancelled shelf-box ids are never reissued", () => {
  const { sqlite, db } = makeDb();
  const first = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.equal(first.id, "SBOX-0001");
  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: first.id }));
  const second = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.equal(second.id, "SBOX-0002");
  assertInvariantsHold(db);
  sqlite.close();
});

test("create/cancel guards: 404 order, 404 shelf, 409 cancel non-open", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "nope", shelfCode: "A1" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "ZZ" })), (e: any) => e.status === 404);
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  sqlite.prepare("UPDATE shelf_boxes SET status='closed' WHERE id=?").run(id);
  assert.throws(() => db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id })), (e: any) => e.status === 409); // not open
  sqlite.close();
});

// seed a part + invoice + receivable item (received 10) — call after makeDb
function seedReceivableItem(sqlite: any) {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii','inv','p',10,10,10,'0','0');
  `);
}

test("recordPutAwayScan drops an unboxed scan; over-scan 409; removeScannedPiece deletes unboxed", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4, dateCode: "D1" }));
  const row = sqlite.prepare("SELECT receiving_invoice_item_id, qty, shelf_box_id, date_code FROM put_away_scans WHERE id=?").get(id) as any;
  assert.deepEqual(row, { receiving_invoice_item_id: "rii", qty: 4, shelf_box_id: null, date_code: "D1" });
  // 4 scanned + another 7 would exceed remaining 10
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 7 })), (e: any) => e.status === 409);
  db.transaction((tx) => removeScannedPiece(tx, { scanId: id }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM put_away_scans WHERE id=?").get(id) as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("record/remove guards: 404 item, 400 bad qty, 404 scan, 409 remove boxed", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "nope", qty: 1 })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 0 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1.5 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => removeScannedPiece(tx, { scanId: "nope" })), (e: any) => e.status === 404);
  const { id } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 }));
  sqlite.prepare("INSERT INTO shelf_boxes (id, shelf_code, status, created_at, updated_at) VALUES ('somebox','A1','open','0','0')").run();
  sqlite.prepare("UPDATE put_away_scans SET shelf_box_id='somebox' WHERE id=?").run(id);
  assert.throws(() => db.transaction((tx) => removeScannedPiece(tx, { scanId: id })), (e: any) => e.status === 409); // boxed
  sqlite.close();
});
