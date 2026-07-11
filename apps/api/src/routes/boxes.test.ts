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
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
    VALUES ('po','e','R','finished','HK','HK','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
`);

test("PATCH /shipping-boxes/:id sets measurements; 404 missing; 400 bad json", async () => {
  const res = await app.request("/shipping-boxes/box", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ box_size: "S", net_weight_g: "500", gross_weight_g: 900 }),
  });
  assert.equal(res.status, 200);
  const row = sqlite.prepare("SELECT box_size, net_weight_g, gross_weight_g FROM shipping_boxes WHERE id='box'").get() as any;
  assert.deepEqual(row, { box_size: "S", net_weight_g: 500, gross_weight_g: 900 });

  const missing = await app.request("/shipping-boxes/nope", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_size: "S" }),
  });
  assert.equal(missing.status, 404);
  const bad = await app.request("/shipping-boxes/box", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("cleanup", () => { sqlite.close(); });
