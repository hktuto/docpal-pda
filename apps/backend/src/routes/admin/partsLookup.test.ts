// Batch parts-master lookup (spec
// docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md):
// found via either column after canonical normalize/unwrap, unknown +
// ambiguous keys are not-found, echoed in input order.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];

async function login(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function lookup(token: string, keys: string[]) {
  return app.request("/admin/parts-lookup", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ keys }),
  });
}

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
});

test("parts-lookup: hits either column via normalize/unwrap; misses + ambiguous are not-found", async () => {
  await reseed(client);
  await client.db.execute(sql`
    INSERT INTO parts (id, brand, part_no, wcl_item_no) VALUES
      ('pl-1', 'KOA', 'KOA+RK73H2BRTTD 4303F', 'WCL-KOA-1'),
      ('pl-2', 'TE',  'TE-AMP(5205208-1)', 'WCL-TE-2'),
      ('pl-3', 'AA',  'DUP-PART', 'WCL-DUP-A'),
      ('pl-4', 'BB',  'DUP-PART', 'WCL-DUP-B')`);
  const token = await login();

  const res = await lookup(token, [
    "koa+rk73h2brttd 4303f", // case/space-insensitive → found (part_no)
    "5205208-1", // TE-AMP unwrapped → found
    "WCL-KOA-1", // wcl_item_no side → found
    "NOT-A-PART", // unknown → not found
    "DUP-PART", // two groups → ambiguous → not found
  ]);
  assert.equal(res.status, 200);
  const { matches } = (await res.json()) as {
    matches: { key: string; found: boolean; brand: string | null }[];
  };
  assert.deepEqual(
    matches.map((m) => [m.key, m.found, m.brand]),
    [
      ["koa+rk73h2brttd 4303f", true, "KOA"],
      ["5205208-1", true, "TE"],
      ["WCL-KOA-1", true, "KOA"],
      ["NOT-A-PART", false, null],
      ["DUP-PART", false, null],
    ]
  );
});

test("parts-lookup: validation errors", async () => {
  await reseed(client);
  const token = await login();
  const empty = await lookup(token, []);
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /keys must be a non-empty array/);

  const mixed = await app.request("/admin/parts-lookup", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ keys: ["OK", 42] }),
  });
  assert.equal(mixed.status, 400);
  assert.match(await mixed.text(), /keys must be strings/);
});
