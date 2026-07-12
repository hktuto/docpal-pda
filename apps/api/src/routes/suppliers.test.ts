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

// Fixture mirrors the web getSuppliersWithQrTemplates filter:
// only suppliers with a non-null qr_template are returned.
// - s11a: template + qty encoding set
// - s11b: no template (excluded)
// - s11c: template set, qty encoding NULL
sqlite.exec(`
  INSERT INTO suppliers (id, code, name, qr_template, qrcode_qty_encoding, created_at, updated_at) VALUES
    ('s11a','SUP11A','Supplier 11 A','^(?<part>[A-Z0-9]+);(?<qty>\\d+)$','qty','0','0'),
    ('s11b','SUP11B','Supplier 11 B',NULL,NULL,'0','0'),
    ('s11c','SUP11C','Supplier 11 C','^(?<part>[A-Z0-9]+)$',NULL,'0','0');
`);

test("GET /suppliers/qr-templates returns only suppliers with a qr_template, ordered by code", async () => {
  const res = await app.request("/suppliers/qr-templates");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  assert.deepEqual(rows.map((r) => r.code), ["SUP11A", "SUP11C"]);
  assert.deepEqual(rows, [
    {
      code: "SUP11A",
      qr_template: "^(?<part>[A-Z0-9]+);(?<qty>\\d+)$",
      qrcode_qty_encoding: "qty",
    },
    {
      code: "SUP11C",
      qr_template: "^(?<part>[A-Z0-9]+)$",
      qrcode_qty_encoding: null,
    },
  ]);
});

test("cleanup", () => {
  sqlite.close();
});
