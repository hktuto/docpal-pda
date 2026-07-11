import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
const { app } = await import("../index.js");
const sqlite = new Database(dbPath);

sqlite.exec(`
  INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
  INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
`);

test("POST /receiving-orders/:id/shelf-boxes creates; DELETE /shelf-boxes/:id cancels; 404 missing shelf", async () => {
  const created = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as any;
  const del = await app.request(`/shelf-boxes/${id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const bad = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "ZZ" }),
  });
  assert.equal(bad.status, 404);
});

test("POST /put-away/scans records; remove-piece deletes; over-scan 409", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at)
      VALUES ('rii','inv','p',10,10,'0','0');
  `);
  const created = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 4 }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as any;
  const over = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 7 }),
  });
  assert.equal(over.status, 409);
  const del = await app.request(`/put-away/scans/${id}/remove-piece`, { method: "POST" });
  assert.equal(del.status, 200);
});

test("cleanup", () => { sqlite.close(); });
