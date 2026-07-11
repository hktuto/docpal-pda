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

test("cleanup", () => { sqlite.close(); });
