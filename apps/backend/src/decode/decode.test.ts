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
  // NCC drawno fixtures — wcl_part_drawno is externally managed (not in the
  // schema/migrations) and reseed() never truncates it, so the test creates
  // and populates it itself.
  await client.db.execute(sql`CREATE TABLE IF NOT EXISTS wcl_part_drawno (
    id varchar(100) PRIMARY KEY,
    wcl_part_no varchar(255) NOT NULL,
    drawno varchar(2000) NOT NULL
  )`);
  // real table carries the upstream org id and the lookup is org-scoped
  // (DRAWNO_ORG_ID) — add it idempotently for pre-existing test-db tables.
  await client.db.execute(sql`ALTER TABLE wcl_part_drawno ADD COLUMN IF NOT EXISTS organization_id bigint`);
  await client.db.execute(sql`DELETE FROM wcl_part_drawno`);
  await client.db.execute(
    sql`INSERT INTO wcl_part_drawno (id, wcl_part_no, drawno, organization_id) VALUES (${randomUUID()}, ${NCC_WCL_ITEM_NO}, '424307', 160)`
  );
  const nccProfile = builtinSupplierProfiles.find((p) => p.supplierCode === "23")!;
  await client.db.execute(
    sql`INSERT INTO suppliers (id, code, name) VALUES (${randomUUID()}, '23', 'HONGKONG CHEMI-CON LTD') ON CONFLICT (code) DO NOTHING`
  );
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

test("POST /scan/decode is public (no bearer token required)", async () => {
  // Open-path since 2026-11-18 (docs/backend/scan-decode-api.md) — external
  // systems decode labels without credentials; still validates the payload.
  const res = await postDecode(null, { raw: "anything" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.matched, false);
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

// --- POST /scan/koa-date-code (route, public lot-code → date-code helper) ----

function postKoaDateCode(token: string | null, body: unknown) {
  return app.request("/scan/koa-date-code", {
    method: "POST",
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("POST /scan/koa-date-code is public and returns yyww/yymmdd/wwyy", async () => {
  // No bearer token (open-path since 2026-11-18, same as /scan/decode).
  // Counter 54 of the 2018/06 cycle = 2022/02; day 20 → 2022-02-20 (Sunday,
  // ISO week 07) — the verified decodeKoaDateCode fixture from receiving.test.ts.
  const res = await postKoaDateCode(null, { lotCode: "5420Q156", asOf: "2023-01-01" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { yyww: "2207", yymmdd: "220220", wwyy: "0722" });
});

test("POST /scan/koa-date-code resolves the current cycle without a suffix", async () => {
  // Counter 12 of the 2025/12 cycle = 2026/02; day 23 → 2026-02-23 (Monday of
  // ISO week 09) — the same values the KOA round-trip label encodes.
  const res = await postKoaDateCode(null, { lotCode: "1223", asOf: "2026-06-01" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { yyww: "2609", yymmdd: "260223", wwyy: "0926" });
});

test("POST /scan/koa-date-code asOf pins a rolled counter to the older era", async () => {
  // Counter 16 recurs per cycle: with asOf 2026-04 the 2026/06 hit is still in
  // the future, so the 2018/06 cycle's 2018/12 wins; day 25 → 2018-12-25
  // (ISO week 52 of 2018).
  const res = await postKoaDateCode(null, { lotCode: "1625H713", asOf: "2026-04-01" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { yyww: "1852", yymmdd: "181225", wwyy: "5218" });
});

test("POST /scan/koa-date-code returns nulls + reason for unresolvable codes", async () => {
  const expected = { yyww: null, yymmdd: null, wwyy: null, reason: "unresolvable_lot_code" };

  const noDigits = await postKoaDateCode(null, { lotCode: "ABC", asOf: "2023-01-01" });
  assert.equal(noDigits.status, 200);
  assert.deepEqual(await noDigits.json(), expected);

  // counter 00 is outside every seeded cycle (10→99)
  const counterOutOfRange = await postKoaDateCode(null, { lotCode: "0099", asOf: "2023-01-01" });
  assert.deepEqual(await counterOutOfRange.json(), expected);

  // day 32 is never a real day
  const badDay = await postKoaDateCode(null, { lotCode: "5432", asOf: "2023-01-01" });
  assert.deepEqual(await badDay.json(), expected);

  // Feb 30: counter 54 lands on 2022/02, whose month has only 28 days
  const febThirty = await postKoaDateCode(null, { lotCode: "5430", asOf: "2023-01-01" });
  assert.deepEqual(await febThirty.json(), expected);
});

test("POST /scan/koa-date-code validates the payload", async () => {
  const missing = await postKoaDateCode(null, {});
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /lotCode must be a non-empty string/);

  const notString = await postKoaDateCode(null, { lotCode: 5420 });
  assert.equal(notString.status, 400);

  const badAsOfFormat = await postKoaDateCode(null, { lotCode: "5420", asOf: "01-01-2023" });
  assert.equal(badAsOfFormat.status, 400);
  assert.match(await badAsOfFormat.text(), /asOf must be a YYYY-MM-DD date string/);

  const badAsOfDate = await postKoaDateCode(null, { lotCode: "5420", asOf: "2023-13-01" });
  assert.equal(badAsOfDate.status, 400);
  assert.match(await badAsOfDate.text(), /not a real calendar date/);
});

// --- POST /scan/koa-lot-code (route, public date-code → lot-code helper) -----

function postKoaLotCode(body: unknown) {
  return app.request("/scan/koa-lot-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /scan/koa-lot-code is public and encodes the Monday of an ISO week", async () => {
  // ISO week 07 of 2022 starts on Monday 2022-02-14; counter 54 = 2022/02.
  const byYyww = await postKoaLotCode({ yyww: "2207" });
  assert.equal(byYyww.status, 200);
  assert.deepEqual(await byYyww.json(), { lotCodeDigits: "5414", counter: 54, day: 14 });

  // wwyy is the same week in label format — same encoding.
  const byWwyy = await postKoaLotCode({ wwyy: "0722" });
  assert.equal(byWwyy.status, 200);
  assert.deepEqual(await byWwyy.json(), { lotCodeDigits: "5414", counter: 54, day: 14 });
});

test("POST /scan/koa-lot-code encodes an exact yymmdd and round-trips with the forward helper", async () => {
  const res = await postKoaLotCode({ yymmdd: "220220" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lotCodeDigits: "5420", counter: 54, day: 20 });

  // Round-trip: the forward helper's yymmdd fed back here reproduces the
  // lot code's leading digits.
  const forward = await postKoaDateCode(null, { lotCode: "5420Q156", asOf: "2023-01-01" });
  const { yymmdd } = await forward.json();
  const back = await postKoaLotCode({ yymmdd });
  assert.equal(back.status, 200);
  assert.equal((await back.json()).lotCodeDigits, "5420");
});

test("POST /scan/koa-lot-code returns nulls + reason for dates no cycle covers", async () => {
  // 2009/12 predates the first seeded cycle (2010/12).
  const res = await postKoaLotCode({ yymmdd: "091201" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    lotCodeDigits: null,
    counter: null,
    day: null,
    reason: "date_outside_counter_periods",
  });
});

test("POST /scan/koa-lot-code validates the payload", async () => {
  const none = await postKoaLotCode({});
  assert.equal(none.status, 400);
  assert.match(await none.text(), /exactly one of yyww, yymmdd, wwyy/);

  const two = await postKoaLotCode({ yyww: "2207", wwyy: "0722" });
  assert.equal(two.status, 400);

  const badWeek = await postKoaLotCode({ yyww: "2254" });
  assert.equal(badWeek.status, 400);
  assert.match(await badWeek.text(), /week must be 01-53/);

  const badDate = await postKoaLotCode({ yymmdd: "220230" }); // Feb 30
  assert.equal(badDate.status, 400);
  assert.match(await badDate.text(), /not a real calendar date/);
});

// --- NCC drawing-number → wcl_item_no resolution (spec 2026-11-03-ncc-drawno-part-lookup) ---

const NCC_WCL_ITEM_NO = "NCC-EKLJ401ELL470MM20S";
// 28-char layout: drawing(6) + lot(13) + qty(5) + serial(4); itemId = "424307".
const NCC_RAW = "424307" + "6030912801026" + "00200" + "0460";

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
