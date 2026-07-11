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

test("PUT picking order runs allocation against existing in_hand receiving stock", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('pP','P','P','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','re','R','in_hand','2026-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii','ri','pP',100,100,100,'0','0');
  `);
  const res = await app.request("/picking-orders/PE-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { ref_no: "PO-1" }, items: [{ line_id: "L1", part_no: "P", qty: 30 }] }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { created: boolean; changed: boolean };
  assert.equal(body.created, true);

  const alloc = sqlite.prepare("SELECT qty, receiving_order_id AS ro FROM allocations").get() as any;
  assert.equal(alloc.qty, 30);
  assert.equal(alloc.ro, "ro");
  const rii = sqlite.prepare("SELECT allocated_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.equal(rii.allocated_qty, 30);
  assert.equal(rii.available_qty, 70);
});

test("cleanup", () => { sqlite.close(); });
