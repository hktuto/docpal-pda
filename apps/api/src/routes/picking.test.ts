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

const post = (url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

sqlite.exec(`
  INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
    VALUES ('op7r','op7r','h','operator','Op7r','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p7r','P7R','P7R','0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES
    ('po7r1','e7r1','PO-7R1','pending','0','0'),
    ('po7r2','e7r2','PO-7R2','picking','0','0'),
    ('po7r3','e7r3','PO-7R3','finished','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
    ('pi7r1','po7r1','p7r',10,'0','0'),
    ('pi7r2','po7r2','p7r',10,'0','0');
`);

test("POST /picking-orders/report-issues reports pending/picking orders and skips finished ones", async () => {
  const res = await post("/picking-orders/report-issues", {
    picking_order_ids: ["po7r1", "po7r2", "po7r3"], reason: "insufficient_stock", qty: 5, remark: "short", actor_id: "op7r",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reported: string[]; skipped: string[] };
  assert.deepEqual(body.reported, ["po7r1", "po7r2"]);
  assert.deepEqual(body.skipped, ["po7r3"]);
  const row = sqlite
    .prepare("SELECT status, issue_reason, issue_qty, issue_remark, issue_reported_by FROM picking_orders WHERE id='po7r1'")
    .get() as any;
  assert.deepEqual(row, { status: "issue", issue_reason: "insufficient_stock", issue_qty: 5, issue_remark: "short", issue_reported_by: "op7r" });
});

test("POST /picking-orders/report-issues validation: malformed JSON / actor_id / ids / reason -> 400", async () => {
  const badJson = await post("/picking-orders/report-issues", "{nope");
  assert.equal(badJson.status, 400);
  const noActor = await post("/picking-orders/report-issues", { picking_order_ids: ["po7r1"], reason: "merge" });
  assert.equal(noActor.status, 400);
  const emptyIds = await post("/picking-orders/report-issues", { picking_order_ids: [], reason: "merge", actor_id: "op7r" });
  assert.equal(emptyIds.status, 400);
  const nonArrayIds = await post("/picking-orders/report-issues", { picking_order_ids: "po7r1", reason: "merge", actor_id: "op7r" });
  assert.equal(nonArrayIds.status, 400);
  const unknownReason = await post("/picking-orders/report-issues", { picking_order_ids: ["po7r1"], reason: "bogus", actor_id: "op7r" });
  assert.equal(unknownReason.status, 400);
});

test("cleanup", () => { sqlite.close(); });
