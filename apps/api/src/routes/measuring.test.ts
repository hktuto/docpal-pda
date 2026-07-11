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

test("cleanup", () => { sqlite.close(); });
