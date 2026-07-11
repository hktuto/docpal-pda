import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return path.join(dir, "t.sqlite");
}

test("createDb enables foreign keys, WAL, NORMAL sync, busy_timeout", () => {
  const { sqlite } = createDb(tmpPath());
  assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(sqlite.pragma("synchronous", { simple: true }), 1); // 1 = NORMAL
  assert.equal(sqlite.pragma("busy_timeout", { simple: true }), 5000);
  sqlite.close();
});

test("createDb creates missing parent directories", () => {
  const p = path.join(os.tmpdir(), "wh-api-" + Date.now(), "nested", "t.sqlite");
  const { sqlite } = createDb(p);
  assert.ok(fs.existsSync(p));
  sqlite.close();
});
