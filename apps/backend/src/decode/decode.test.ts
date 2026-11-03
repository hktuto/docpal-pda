// Decode endpoint tests (spec 2026-11-03-backend-scan-decode-design.md):
// round-trip of a KOA label raw through the DB-backed template decode, the
// order-targets gate, and POST /scan/decode auth/validation behaviour.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryGet } from "../db/query.js";
import { builtinSupplierProfiles } from "../db/seed-supplier-profiles.js";
import { buildKoaLabelRaw } from "./codecs.js";
import { decodeScan } from "./index.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const PART_NO = "RK73H1JTTD3302F";

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

after(async () => {
  await client.sql.end();
});

async function login(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

function postDecode(token: string | null, body: unknown) {
  return app.request("/scan/decode", {
    method: "POST",
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// --- decodeScan (domain function) -------------------------------------------

test("decodeScan round-trips a KOA label raw via DB templates + month-counter periods", async () => {
  const profile = await queryGet<{ brands: string[] | null }>(
    client.db,
    sql`SELECT brands FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile, "KOA profile seeded");

  // Same fixture as labels.test.ts: canonical YYWW "2609" is label-encoded
  // into the KOA raw (counter "1223"); the seeded wwyy format puts the
  // decoded dateCode back as WWYY "0926".
  const raw = buildKoaLabelRaw({ partNo: PART_NO, qty: 500, dateCode: "2609", serialNo: "900001" });
  assert.ok(raw);
  const result = await decodeScan(client.db, { raw });

  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, PART_NO);
  assert.equal(result.parsed.qty, 500);
  assert.equal(result.parsed.dateCode, "0926");
  assert.equal(result.parsed.lotCode, "1223");
  assert.equal(result.parsed.serialNo, "900001");
  assert.equal(result.parsed.wclItemNo, `KOA+${PART_NO}`);
  assert.equal(result.supplier?.code, "KOA");
  assert.deepEqual(result.supplier?.brands, profile!.brands ?? undefined);
  assert.deepEqual(result.options.itemIds, [PART_NO]);
  assert.deepEqual(result.options.qtys, [500]);
});

test("decodeScan returns matched=false for a value no template hits", async () => {
  const result = await decodeScan(client.db, { raw: "not a supplier label" });
  assert.equal(result.matched, false);
  assert.equal(result.parsed.itemId, null);
  assert.deepEqual(result.options.itemIds, []);
});

test("decodeScan gates template matches on order targets (normalized, case/space-insensitive)", async () => {
  const raw = buildKoaLabelRaw({ partNo: PART_NO, qty: 500, dateCode: "2609", serialNo: "900001" });
  assert.ok(raw);

  const offOrder = await decodeScan(client.db, { raw, targets: ["SOME-OTHER-PART"] });
  assert.equal(offOrder.matched, false, "a label outside the order context must not win");

  const onOrder = await decodeScan(client.db, { raw, targets: [`  ${PART_NO.toLowerCase()} `] });
  assert.equal(onOrder.matched, true);
  assert.equal(onOrder.parsed.itemId, PART_NO);
});

test("decodeScan targets gate matches by wcl_item_no and unwrapped keys too", async () => {
  const raw = buildKoaLabelRaw({ partNo: PART_NO, qty: 500, dateCode: "2609", serialNo: "900001" });
  assert.ok(raw);

  // WCL key target (seed KOA template yields wclItemNo "KOA+<part>") — the
  // 1f28c493 case: an allocation pinned via wcl_item_no must not find zero lines.
  const byWcl = await decodeScan(client.db, { raw, targets: [`koa+${PART_NO}`] });
  assert.equal(byWcl.matched, true);

  // Wrapped part target unwraps before compare (bare-MPN label vs AMP(...) key).
  const wrapped = await decodeScan(client.db, { raw, targets: [`AMP(${PART_NO})`] });
  assert.equal(wrapped.matched, true);
});

// --- POST /scan/decode (route) -------------------------------------------------

test("POST /scan/decode requires a bearer token", async () => {
  const res = await postDecode(null, { raw: "anything" });
  assert.equal(res.status, 401);
});

test("POST /scan/decode validates the payload", async () => {
  const token = await login();

  const empty = await postDecode(token, {});
  assert.equal(empty.status, 400);
  assert.match(await empty.text(), /raw must be a non-empty string/);

  const badTargets = await postDecode(token, { raw: "x", targets: [1, 2] });
  assert.equal(badTargets.status, 400);
  assert.match(await badTargets.text(), /targets must be an array of strings/);

  const badSupplier = await postDecode(token, { raw: "x", supplierCode: 7 });
  assert.equal(badSupplier.status, 400);
});

test("POST /scan/decode returns the OcrParseResult-shaped body", async () => {
  const token = await login();
  const raw = buildKoaLabelRaw({ partNo: PART_NO, qty: 500, dateCode: "2609", serialNo: "900001" });
  assert.ok(raw);

  const res = await postDecode(token, { raw, targets: [PART_NO], supplierCode: "KOA" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.matched, true);
  assert.equal(body.parsed.itemId, PART_NO);
  assert.equal(body.supplier.code, "KOA");
  assert.equal("raw" in body, false, "the client's capture is never echoed back");
});

// --- NCC drawing-number → wcl_item_no resolution (spec 2026-11-03-ncc-drawno-part-lookup) ---

const NCC_WCL_ITEM_NO = "NCC-EKLJ401ELL470MM20S";
// 28-char layout: drawing(6) + lot(13) + qty(5) + serial(4); itemId = "424307".
const NCC_RAW = "424307" + "6030912801026" + "00200" + "0460";

before(async () => {
  // wcl_part_drawno is externally managed (not in the schema/migrations) and
  // reseed() never truncates it — created + populated by the test itself.
  await client.db.execute(sql`CREATE TABLE IF NOT EXISTS wcl_part_drawno (
    id varchar(100) PRIMARY KEY,
    wcl_part_no varchar(255) NOT NULL,
    drawno varchar(2000) NOT NULL
  )`);
  await client.db.execute(sql`DELETE FROM wcl_part_drawno`);
  await client.db.execute(
    sql`INSERT INTO wcl_part_drawno (id, wcl_part_no, drawno) VALUES (${randomUUID()}, ${NCC_WCL_ITEM_NO}, '424307')`
  );
  const nccProfile = builtinSupplierProfiles.find((p) => p.supplierCode === "23")!;
  await client.db.execute(
    sql`INSERT INTO supplier_profiles (id, supplier_code, qr_template, date_code_encoding, brands)
        VALUES (${randomUUID()}, '23', ${nccProfile.qrTemplate}, ${nccProfile.dateCodeEncoding ?? null}, ${`{${(nccProfile.brands ?? []).join(",")}}`}::text[])
        ON CONFLICT (supplier_code) DO NOTHING`
  );
  await client.db.execute(
    sql`INSERT INTO parts (id, brand, part_no, wcl_item_no)
        VALUES (${randomUUID()}, 'NCC', 'EKLJ401ELL470MM20S', ${NCC_WCL_ITEM_NO})
        ON CONFLICT (wcl_item_no) DO NOTHING`
  );
});

test("decodeScan resolves an NCC drawing code past the targets gate (Case B)", async () => {
  // The drawing code is never among the order targets — the gated decode
  // alone would reject the NCC template hit.
  const result = await decodeScan(client.db, { raw: NCC_RAW, targets: [NCC_WCL_ITEM_NO] });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "424307"); // stays the drawing code
  assert.equal(result.parsed.wclItemNo, NCC_WCL_ITEM_NO);
  assert.equal(result.supplier?.code, "23");
});

test("decodeScan attaches the resolved wclItemNo without targets (Case A)", async () => {
  const result = await decodeScan(client.db, { raw: NCC_RAW });
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "424307");
  assert.equal(result.parsed.wclItemNo, NCC_WCL_ITEM_NO);
});

test("decodeScan with targets naming a different part stays unmatched", async () => {
  const result = await decodeScan(client.db, { raw: NCC_RAW, targets: ["NCC-SOME-OTHER-PART"] });
  assert.equal(result.matched, false);
});
