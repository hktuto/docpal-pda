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
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','finished','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
  INSERT INTO verification_tasks (id, kind, status, picking_order_id, created_at, updated_at) VALUES ('vt','pre_shipment','pending','po','0','0');
`);

test("POST /shipping-boxes/:id/verify then POST /verification-tasks/:id/complete", async () => {
  const v = await app.request("/shipping-boxes/box/verify", { method: "POST" });
  assert.equal(v.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='box'").get() as any).status, "verified");
  const c = await app.request("/verification-tasks/vt/complete", { method: "POST" });
  assert.equal(c.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  const again = await app.request("/verification-tasks/vt/complete", { method: "POST" });
  assert.equal(again.status, 409);
});

test("cleanup", () => { sqlite.close(); });
