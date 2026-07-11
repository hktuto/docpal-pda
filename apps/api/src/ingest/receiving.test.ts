import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { upsertReceivingOrder } from "./receiving.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { ReceivingPutBody } from "@warehouse/shared";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`);
  return { sqlite, db };
}

test("upsertReceivingOrder creates order + invoices + items with norms; received_qty stays 0 while pending", () => {
  const { sqlite, db } = makeDb();
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20", supplier_code: "SUP" },
    invoices: [
      { invoice_no: "INV-1", items: [
        { line_no: 1, part_no: "ABO", qty: 100, date_code: "2024O1", coo: "cn" },
        { line_no: 2, part_no: "X1", qty: 5, box_id: "B1" },
      ] },
      { invoice_no: "INV-2", supplier_code: "SUP", items: [
        { line_no: 1, part_no: "ABO", qty: 50 },
      ] },
    ],
  };
  const res = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(res.created, true);
  assert.equal(res.changed, true);

  const ro = sqlite.prepare("SELECT status, supplier_id, ref_no FROM receiving_orders WHERE external_id='EXT-1'").get() as any;
  assert.equal(ro.status, "pending");
  assert.equal(ro.supplier_id, "s");
  assert.equal(ro.ref_no, "RO-1");

  const items = sqlite.prepare(`
    SELECT rii.qty, rii.received_qty, rii.box_id, rii.date_code_norm, rii.coo_norm, ri.invoice_no, rii.line_no
    FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    ORDER BY ri.invoice_no, rii.line_no`).all() as any[];
  assert.deepEqual(items, [
    { qty: 100, received_qty: 0, box_id: null, date_code_norm: "202401", coo_norm: "CN", invoice_no: "INV-1", line_no: 1 },
    { qty: 5, received_qty: 0, box_id: "B1", date_code_norm: null, coo_norm: null, invoice_no: "INV-1", line_no: 2 },
    { qty: 50, received_qty: 0, box_id: null, date_code_norm: null, coo_norm: null, invoice_no: "INV-2", line_no: 1 },
  ]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM parts").get() as any).c, 2);
  assertInvariantsHold(db);
  sqlite.close();
});

test("upsertReceivingOrder rejects a missing ref_no and a negative qty with 400", () => {
  const { db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => upsertReceivingOrder(tx, "E", { order: { ref_no: "" }, invoices: [] } as any)),
    (e: any) => e.status === 400
  );
  assert.throws(
    () => db.transaction((tx) => upsertReceivingOrder(tx, "E2", {
      order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: -1 }] }],
    } as any)),
    (e: any) => e.status === 400
  );
});

test("re-PUT of an identical payload is a no-op (changed=false, updated_at unchanged)", () => {
  const { sqlite, db } = makeDb();
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20" },
    invoices: [{ invoice_no: "INV-1", items: [{ line_no: 1, part_no: "ABO", qty: 100, date_code: "202401" }] }],
  };
  const first = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  const stamp = (sqlite.prepare("SELECT updated_at FROM receiving_orders WHERE id=?").get(first.orderId) as any).updated_at;
  const itemStamp = (sqlite.prepare("SELECT updated_at FROM receiving_invoice_items").get() as any).updated_at;

  const second = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal((sqlite.prepare("SELECT updated_at FROM receiving_orders WHERE id=?").get(first.orderId) as any).updated_at, stamp);
  assert.equal((sqlite.prepare("SELECT updated_at FROM receiving_invoice_items").get() as any).updated_at, itemStamp);
  sqlite.close();
});

test("update adds a line, changes a qty (pending), and removes an untouched line", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [{ invoice_no: "INV-1", items: [
      { line_no: 1, part_no: "ABO", qty: 100 },
      { line_no: 2, part_no: "X1", qty: 5 },
    ] }],
  };
  const first = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", v1));

  const v2: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [{ invoice_no: "INV-1", items: [
      { line_no: 1, part_no: "ABO", qty: 120 },
      { line_no: 3, part_no: "Z9", qty: 7 },
    ] }],
  };
  const second = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", v2));
  assert.equal(second.created, false);
  assert.equal(second.changed, true);

  const rows = sqlite.prepare(`
    SELECT rii.line_no, rii.qty, p.part_no FROM receiving_invoice_items rii
    JOIN parts p ON p.id=rii.part_id JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    WHERE ri.receiving_order_id=? ORDER BY rii.line_no`).all(first.orderId) as any[];
  assert.deepEqual(rows, [
    { line_no: 1, qty: 120, part_no: "ABO" },
    { line_no: 3, qty: 7, part_no: "Z9" },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});
