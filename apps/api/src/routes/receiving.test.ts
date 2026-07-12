import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");

const sqlite = new Database(dbPath);

test("PUT receiving -> confirm-arrival flips to in_hand, sets received_qty=qty, logs transition, allocates", async () => {
  sqlite.exec(`INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('pABO','ABO','AB0','0','0')`);
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','PO','picking','0','0')`);
  sqlite.exec(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','pABO',60,'0','0')`);

  const put = await app.request("/receiving-orders/EXT-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { ref_no: "RO-1" }, invoices: [{ invoice_no: "INV-1", items: [{ line_no: 1, part_no: "ABO", qty: 100 }] }] }),
  });
  assert.equal(put.status, 201);

  const confirm = await app.request("/receiving-orders/EXT-1/confirm-arrival", { method: "POST" });
  assert.equal(confirm.status, 200);
  const body = (await confirm.json()) as { id: string; status: string };
  assert.equal(body.status, "in_hand");

  const ro = sqlite.prepare("SELECT status FROM receiving_orders WHERE external_id='EXT-1'").get() as any;
  assert.equal(ro.status, "in_hand");
  const rii = sqlite.prepare("SELECT received_qty, available_qty, allocated_qty FROM receiving_invoice_items").get() as any;
  assert.equal(rii.received_qty, 100);
  assert.equal(rii.allocated_qty, 60);
  assert.equal(rii.available_qty, 40);
  const logs = sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='receiving_order' AND to_status='in_hand'").get() as any;
  assert.equal(logs.c, 1);
});

test("confirm-arrival is 409 when not pending and 404 when unknown", async () => {
  const miss = await app.request("/receiving-orders/NOPE/confirm-arrival", { method: "POST" });
  assert.equal(miss.status, 404);

  sqlite.exec(`INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro2','E2','R','in_hand','0','0')`);
  const again = await app.request("/receiving-orders/E2/confirm-arrival", { method: "POST" });
  assert.equal(again.status, 409);
});

test("confirm-arrival also matches the internal order id (web passes internal ids)", async () => {
  sqlite.exec(`INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('roint','EINT','R-INT','pending','0','0')`);
  const res = await app.request("/receiving-orders/roint/confirm-arrival", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; status: string };
  assert.deepEqual(body, { id: "roint", status: "in_hand" });
  assert.equal((sqlite.prepare("SELECT status FROM receiving_orders WHERE id='roint'").get() as any).status, "in_hand");
});

test("cleanup", () => { sqlite.close(); });
