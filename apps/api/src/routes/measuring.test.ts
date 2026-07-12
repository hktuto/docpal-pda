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

test("GET /measuring-tasks filters by status and since", async () => {
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','R','finished','0','0')`);
  sqlite.exec(`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES
    ('mt','po','pending','2026-07-10T00:00:00.000Z','2026-07-10T00:00:00.000Z')`);
  const all = await app.request("/measuring-tasks");
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as any[]).length, 1);
  const pending = await app.request("/measuring-tasks?status=pending");
  assert.equal(((await pending.json()) as any[])[0].id, "mt");
  const since = await app.request("/measuring-tasks?since=2026-07-11T00:00:00.000Z");
  assert.deepEqual(await since.json(), []);
});

test("POST /measuring-tasks/:id/complete completes and creates pre_shipment task; 404 missing", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box',1,'0','0');
  `);
  // the existing measuring.test.ts seed already created order 'po' + task 'mt' (status pending) in its first test
  const ok = await app.request("/measuring-tasks/mt/complete", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM measuring_tasks WHERE id='mt'").get() as any).status, "completed");
  const vts = sqlite.prepare("SELECT kind, status FROM verification_tasks WHERE picking_order_id='po'").all() as any[];
  assert.deepEqual(vts, [{ kind: "pre_shipment", status: "pending" }]);
  const missing = await app.request("/measuring-tasks/nope/complete", { method: "POST" });
  assert.equal(missing.status, 404);
});

test("GET /measuring-tasks/:id returns task detail with boxes and packages", async () => {
  const res = await app.request("/measuring-tasks/mt");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.task.picking_order_id, "po");
  assert.equal(d.order.ref_no, "R");
  assert.equal(d.items.length, 1);
  assert.equal(d.boxes.length, 1);
  assert.equal(d.boxes[0].packages[0].part_no, "X");
  assert.equal(d.boxes[0].packages[0].verified, 1);
  const missing = await app.request("/measuring-tasks/nope");
  assert.equal(missing.status, 404);
});

test("GET /measuring-tasks includes totals", async () => {
  const res = await app.request("/measuring-tasks");
  const rows = (await res.json()) as any[];
  const mt = rows.find((r: any) => r.id === "mt");
  assert.equal(mt.ref_no, "R");
  assert.equal(mt.total_items, 4);
  assert.equal(mt.packed_items, 4);
});

test("cleanup", () => { sqlite.close(); });
