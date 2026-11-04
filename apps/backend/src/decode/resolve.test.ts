// TE identity-translation tests: labels print a truncated MPN, so a matched
// TE decode resolves the real part_no/wcl_item_no from the parts master
// (equality then trigram substring — resolveTeIdentity), replacing the
// parsed identity for every caller. Mirrors the NCC drawno branch.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { buildKoaLabelRaw } from "./codecs.js";
import { decodeScan } from "./service.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

// Synthetic TE-shaped profile (brands ["TE"] is the branch guard) + truncated
// label template. Parts fixture: one uniquely-extendable PN and an
// ambiguous pair ("1571983-1" is a substring of both stored keys).
const TE_SUPPLIER = "999990";
const TE_TEMPLATE = "^PN(?<itemId>[0-9\\-]{6,})$";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
  // reseed truncates these tables — populate after setupTestDb (same pattern
  // as the NCC drawno fixtures in decode.test.ts).
  await client.db.execute(
    sql`INSERT INTO suppliers (id, code, name) VALUES (${randomUUID()}, ${TE_SUPPLIER}, 'TE Parts Fixture') ON CONFLICT (code) DO NOTHING`
  );
  await client.db.execute(
    sql`INSERT INTO supplier_profiles (id, supplier_code, qr_template, brands)
        VALUES (${randomUUID()}, ${TE_SUPPLIER}, ${TE_TEMPLATE}, '{TE}')
        ON CONFLICT (supplier_code) DO NOTHING`
  );
  for (const [partNo, wclItemNo] of [
    ["1-9988776-5", "TE-AMP(1-9988776-5)"],
    ["1-1571983-1", "TE-AMP(1-1571983-1)"],
    ["1-1571983-11", "TE-AMP(1-1571983-11)"],
    // real-world pattern seen on the synced db (2026-11-04): ONE part_no
    // stored under two wcl keys ("TE-" supplier vs "TE+" variant)
    ["1-4444555-6", "TE-AMP(1-4444555-6)"],
    ["1-4444555-6", "TE+AMP(1-4444555-6)"],
  ] as const) {
    await client.db.execute(
      sql`INSERT INTO parts (id, brand, part_no, wcl_item_no)
          VALUES (${randomUUID()}, 'TE', ${partNo}, ${wclItemNo})
          ON CONFLICT (wcl_item_no) DO NOTHING`
    );
  }
});

after(async () => {
  await client.sql.end();
});

test("TE truncated MPN resolves to the canonical part_no + wcl_item_no (unique substring)", async () => {
  const result = await decodeScan(client.db, { raw: "PN9988776" });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1-9988776-5"); // stored full PN
  assert.equal(result.parsed.wclItemNo, "TE-AMP(1-9988776-5)"); // stored canonical WCL key
});

test("targets gate rejection: TE rerun resolves ambiguous substring via the order", async () => {
  // "1571983-1" is a substring of two stored PNs; equality misses, and only
  // the order target picks the right one.
  const result = await decodeScan(client.db, {
    raw: "PN1571983-1",
    targets: ["1-1571983-1"],
  });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1-1571983-1");
  assert.equal(result.parsed.wclItemNo, "TE-AMP(1-1571983-1)");
});

test("ambiguous without targets keeps the parsed label values", async () => {
  const result = await decodeScan(client.db, { raw: "PN1571983-1" });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1571983-1"); // unresolved — honest guess
});

test("full (non-truncated) TE MPN resolves by normalized equality", async () => {
  // Stored wrapped key, bare scanned PN — the equality step (idx_parts_norm_*)
  // hits before any substring search is needed.
  const result = await decodeScan(client.db, { raw: "PN1-1571983-1" });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1-1571983-1");
  assert.equal(result.parsed.wclItemNo, "TE-AMP(1-1571983-1)");
});

test("duplicate wcl keys for one part_no: itemId canonical, fake wcl DROPPED", async () => {
  // parts master holds 1-4444555-6 under TE-AMP(...) AND TE+AMP(...).
  // Blind scan (no targets): part_no is unambiguous — adopt it; the wcl is
  // not — the fake derived "TE/..." must not survive as if real.
  const result = await decodeScan(client.db, { raw: "PN4444555-6" });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1-4444555-6");
  assert.equal(result.parsed.wclItemNo, undefined);
});

test("duplicate wcl keys resolve when the order target names one", async () => {
  const result = await decodeScan(client.db, {
    raw: "PN4444555-6",
    targets: ["TE+AMP(1-4444555-6)"],
  });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1-4444555-6");
  assert.equal(result.parsed.wclItemNo, "TE+AMP(1-4444555-6)");
});

test("non-TE suppliers never run the parts lookup", async () => {
  const raw = buildKoaLabelRaw({ partNo: "RK73H1JTTD3302F", qty: 500, dateCode: "2609", serialNo: "900001" });
  assert.ok(raw);
  const result = await decodeScan(client.db, { raw });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "RK73H1JTTD3302F");
  assert.equal(result.parsed.wclItemNo, "KOA+RK73H1JTTD3302F");
});
