import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { decodeKoaDateCode, decodeKoaQty, decodeYywwDateCode, decodeYyyymmMidmonthDateCode, normalizePartNo, parseQrRaw } from "./scanParse.js";
import { builtinSupplierProfiles } from "./seed-supplier-profiles.js";
import { insertReceivingOrder } from "./test-fixtures.js";
import { _setReceivingSubInventoryRulesForTests } from "../config.js";
import {
  cancelReceivingItemMismatch,
  confirmReceivingArrival,
  confirmReceivingItemMismatch,
  deleteReceivingInvoiceItem,
  editReceivingItemMismatch,
  getReceivingItemMismatch,
  listReceivingMismatches,
  listReceivingOrderLogs,
  poNoGlobTest,
  reportReceivingItemMismatch,
  scanReceivingOrder,
} from "./receiving.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

// --- scanParse unit cases ----------------------------------------------------

test("decodeKoaQty: last digit is the trailing-zero count", () => {
  assert.equal(decodeKoaQty("253"), 25000);
  assert.equal(decodeKoaQty("14"), 10000);
  assert.equal(decodeKoaQty("11"), 10);
  assert.equal(decodeKoaQty("00"), undefined);
  assert.equal(decodeKoaQty("0"), undefined);
  assert.equal(decodeKoaQty("abc"), undefined);
});

test("normalizePartNo: uppercase + collapse whitespace", () => {
  assert.equal(normalizePartNo("rk73b1 jttd181g"), "RK73B1JTTD181G");
  assert.equal(normalizePartNo("  RK73H1JTTD4702F "), "RK73H1JTTD4702F");
});

test("normalizePartNo: TE AMP() wrapper unwrapped to the bare PN", () => {
  // TE labels carry the bare PN; the parts master stores it wrapped.
  assert.equal(normalizePartNo("AMP(640385-8)"), "640385-8");
  assert.equal(normalizePartNo("amp( 640385-8 )"), "640385-8");
  assert.equal(normalizePartNo("TE-AMP(640385-8)"), "640385-8");
  assert.equal(normalizePartNo("640385-8"), "640385-8");
  // Non-wrapper values pass through untouched (incl. parens mid-string).
  assert.equal(normalizePartNo("S-5743NBH1A-M3T4U"), "S-5743NBH1A-M3T4U");
  assert.equal(normalizePartNo("AMP(640385-8)-1"), "AMP(640385-8)-1");
});

test("decodeKoaDateCode: rolling month counter + day → ISO week WWYY", () => {
  // KOA's counter rolls 10→99 per 90-month cycle (three seeded period rows);
  // the latest candidate not in the future of the reference date wins.
  const ref = new Date(2026, 9, 16); // 2026-10-16
  assert.equal(decodeKoaDateCode("1723L789", undefined, ref), "3026"); // counter 17 → 2026-07 (current cycle), day 23 → 2026-07-23 → ISO week 30
  assert.equal(decodeKoaDateCode("1114T232", undefined, ref), "0326"); // counter 11 → 2026-01, day 14 → 2026-01-14 → ISO week 03
  assert.equal(decodeKoaDateCode("19077387", undefined, ref), "3726"); // counter 19 → 2026-09, day 07 → 2026-09-07 → ISO week 37
  assert.equal(decodeKoaDateCode("1623", undefined, ref), "2626"); // counter 16 → 2026-06, day 23 → 2026-06-23 → ISO week 26
  assert.equal(decodeKoaDateCode("1823", undefined, ref), "3426"); // counter 18 → 2026-08, day 23 → 2026-08-23 → ISO week 34
  // counter 54 appears in all three cycles (2015-02 / 2022-02 / 2029-08) —
  // the not-in-future rule picks 2022-02
  assert.equal(decodeKoaDateCode("5420Q156", undefined, ref), "0722"); // day 20 → 2022-02-20 (Sunday) → ISO week 07
  assert.equal(decodeKoaDateCode("5421Q156", undefined, ref), "0822"); // day 21 → 2022-02-21 (Monday) → ISO week 08
  // counter 99: cycles end 2018-05 / 2025-11 / 2033-05 → 2025-11
  assert.equal(decodeKoaDateCode("9915X", undefined, ref), "4625"); // 2025-11-15 → ISO week 46
  // a reference date past 2029-08 moves counter 54 into the current cycle
  assert.equal(decodeKoaDateCode("5401", undefined, new Date(2030, 0, 1)), "3129"); // 2029-08-01 → ISO week 31
  // invalid
  assert.equal(decodeKoaDateCode("2352", undefined, ref), undefined); // day 52
  assert.equal(decodeKoaDateCode("L2601A", undefined, ref), undefined); // no leading digits
  assert.equal(decodeKoaDateCode("123", undefined, ref), undefined); // fewer than 4 digits
  assert.equal(decodeKoaDateCode("1700X", undefined, ref), undefined); // day 00
  assert.equal(decodeKoaDateCode("1732X", undefined, ref), undefined); // day 32
  assert.equal(decodeKoaDateCode("5429", undefined, ref), undefined); // day 29 > 28 in 2022-02
  assert.equal(decodeKoaDateCode("0023X", undefined, ref), undefined); // counter 00 in no period
  assert.equal(decodeKoaDateCode("0523X", undefined, ref), undefined); // counter 05 in no period
});

test("decodeKoaDateCode: an empty periods list falls back to the built-in defaults", () => {
  // Request paths pass the date_code_counter_periods rows verbatim; a DB
  // seeded before the table existed returns [] — that must behave like
  // omitting the argument, not like "no period covers this counter" (which
  // silently dropped the date code on KOA scans).
  const ref = new Date(2026, 9, 16); // 2026-10-16
  assert.equal(decodeKoaDateCode("18042421", [], ref), "3226"); // counter 18 → 2026-08, day 04 → 2026-08-04 → ISO week 32
  assert.equal(decodeKoaDateCode("1907H686", [], ref), "3726"); // counter 19 → 2026-09, day 07 → 2026-09-07 → ISO week 37
});

test("decodeKoaDateCode: decode output follows the configured label dateCodeFormat", () => {
  // Decode output is label format by contract (spec 2026-10-22) — under a
  // "yyww" flow config the canonical YYWW must be pair-swapped from the
  // default WWYY rendering, not hardcoded WWYY.
  const ref = new Date(2026, 9, 16); // 2026-10-16
  assert.equal(decodeKoaDateCode("1907H686", undefined, ref, "yyww"), "2637"); // week 37 of 2026
  assert.equal(decodeKoaDateCode("1907H686", undefined, ref, "wwyy"), "3726");
  assert.equal(decodeKoaDateCode("1907H686", [], ref, "yyww"), "2637"); // empty-table fallback + format
});

test("decodeYywwDateCode: YYWW → WWYY pair swap (iC-Haus DC)", () => {
  assert.equal(decodeYywwDateCode("2337"), "3723"); // 2023 week 37
  assert.equal(decodeYywwDateCode("2631"), "3126"); // 2026 week 31
  assert.equal(decodeYywwDateCode("2601"), "0126"); // week 01
  // invalid
  assert.equal(decodeYywwDateCode("237"), undefined); // fewer than 4 digits
  assert.equal(decodeYywwDateCode("23370"), undefined); // more than 4 digits
  assert.equal(decodeYywwDateCode("2300"), undefined); // week 00
  assert.equal(decodeYywwDateCode("2354"), undefined); // week 54
  assert.equal(decodeYywwDateCode("ABCD"), undefined); // non-digits
  // under a "yyww" label format the YYWW input is already label format
  assert.equal(decodeYywwDateCode("2337", "yyww"), "2337");
});

test("parseQrRaw: seeded KOA template parses raw and decodes koa_zeros qty", async () => {
  const profile = await queryGet<{ qrTemplate: string; qtyEncoding: string; dateCodeEncoding: string }>(
    client.db,
    sql`SELECT qr_template AS "qrTemplate", qty_encoding AS "qtyEncoding", date_code_encoding AS "dateCodeEncoding" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplate);
  // template: ^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$
  const parsed = parseQrRaw(":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F", profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(parsed.partNo, "RK73H1JTTD1002F");
  assert.equal(parsed.qty, 10000); // "14" → 1 × 10^4
  assert.equal(parsed.serialNo, "602"); // S-key serial from the serialNo group
  // segment 5 "L2601A" has no leading digits → no decodable date code, but the
  // raw value is preserved as the lot code
  assert.equal(parsed.dateCode, undefined);
  assert.equal(parsed.lotCode, "L2601A");
  assert.equal(parsed.wclItemNo, "KOA+RK73H1JTTD1002F"); // old-style marking tail

  // Outer package label: empty subId segment must also match (subId [^:]*).
  const outer = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(outer.partNo, "RK73H2ATTD2403F");
  assert.equal(outer.qty, 25000); // "253" → 25 × 10^3
  assert.equal(outer.dateCode, "4422"); // "63048349" → counter 63 → cycles 2015-05/2022-11/2030-05 → 2022-11, day 04 → 2022-11-04 → ISO week 44
  assert.equal(outer.lotCode, "63048349");
  assert.equal(outer.serialNo, "S613");

  // user's example: month counter + day date code
  const dc = parseQrRaw(":RK73H1JTTD1002F::14:X:1723L789:602:KOA+RK73H1JTTD1002F", profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(dc.dateCode, "3026"); // counter 17 → 2026-07, day 23 → 2026-07-23 → ISO week 30
});

test("parseQrRaw: KOA reel label carries the WCL item no in segment 7", async () => {
  const profile = await queryGet<{ qrTemplate: string; qtyEncoding: string; dateCodeEncoding: string }>(
    client.db,
    sql`SELECT qr_template AS "qrTemplate", qty_encoding AS "qtyEncoding", date_code_encoding AS "dateCodeEncoding" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplate);
  // Real 2026 reel label (picking order ME2610-0006): segment 7 is the WCL
  // item no; trailing segments and the absence of a trailing ':' are ignored.
  const raw = ":SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01";
  const parsed = parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(parsed.partNo, "SR732ERTTDR200F");
  assert.equal(parsed.qty, 15000); // "153" → 15 × 10^3
  assert.equal(parsed.dateCode, "3726"); // "19077387" → counter 19 → 2026-09, day 07 → 2026-09-07 → ISO week 37
  assert.equal(parsed.lotCode, "19077387");
  assert.equal(parsed.serialNo, "S002");
  assert.equal(parsed.wclItemNo, "KOA/SR732ERTTDR200F");
  // space-stripped, the wclItemNo equals the parts master wcl_item_no
  assert.equal(normalizePartNo(parsed.wclItemNo!), normalizePartNo("KOA/SR732ERTTD R200F"));

  // ...and with a trailing delimiter (some reels emit one)
  const trailing = parseQrRaw(raw + ":", profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(trailing.wclItemNo, "KOA/SR732ERTTDR200F");
});

test("parseQrRaw: NCC 28-digit label keeps drawing and lot boundaries", () => {
  const profile = builtinSupplierProfiles.find((p) => p.supplierCode === "23");
  assert.ok(profile?.qrTemplate);
  const raw = "5928846030912801026002000460";
  const parsed = parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding, undefined, "yyww");
  assert.equal(parsed.partNo, "592884");
  assert.equal(parsed.qty, 200);
  assert.equal(parsed.lotCode, "60309-0128010-26");
  assert.equal(parsed.dateCode, "2611"); // 2026-03-09 → ISO week 11
  assert.equal(parsed.serialNo, "0460");
  assert.equal(parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding).dateCode, "1126");

  const ktd = parseQrRaw("06711422706071038400210015000024", profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(ktd.partNo, "0671142270");
  assert.equal(ktd.qty, 1500);
  assert.equal(ktd.lotCode, "1038400");
  assert.equal(ktd.serialNo, "0024");
});

test("parseQrRaw: iC-Haus builtin template parses the Versandetikett JSON QR", () => {
  const profile = builtinSupplierProfiles.find((p) => p.supplierCode === "20");
  assert.ok(profile?.qrTemplate);
  const raw =
    '{"type":"Versandetikett","version":"1","AC":"IRZ4248_6","VI":"<keine>","DC":"2337","Q":"10","ID":"50788","VID":"1","C":"WELTM","CANR":"ICHAUS/IC-RZ4248 OQFN38-7X5","IANR":"iC-RZ4248 oQFN38-7x5","CONR":"339084940.3","COO":"DE","LTS":"20260929-4"}';
  const parsed = parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding, profile.dateCodeEncoding);
  assert.equal(parsed.partNo, "IC-RZ4248OQFN38-7X5"); // IANR — matches parts.part_no space-insensitively
  assert.equal(parsed.qty, 10);
  assert.equal(parsed.dateCode, "3723"); // DC "2337" is YYWW — decoded to WWYY via 'yyww'
  assert.equal(parsed.coo, "DE");
  assert.equal(parsed.wclItemNo, "ICHAUS/IC-RZ4248 OQFN38-7X5"); // CANR = parts.wcl_item_no
  assert.equal(parsed.serialNo, "20260929-4"); // LTS — put-away duplicate check
  assert.equal(parsed.lotCode, "IRZ4248_6"); // AC = lot code
  // key order doesn't matter (lookahead groups)
  const reordered = parseQrRaw('{"COO":"DE","Q":"10","DC":"2337","LTS":"20260929-4","AC":"IRZ4248_6","IANR":"iC-RZ4248 oQFN38-7x5","CANR":"ICHAUS/IC-RZ4248 OQFN38-7X5"}', profile.qrTemplate, null);
  assert.equal(reordered.partNo, "IC-RZ4248OQFN38-7X5");
  assert.equal(reordered.serialNo, "20260929-4");
});

test("parseQrRaw: TE datamatrix with yywwd encoding decodes the 5-digit DC", () => {
  // TE Connectivity ASC MH10 datamatrix: DC is YYWW + day digit ("26374" =
  // 2026 week 37 day 4) — decoded to the label format, day dropped.
  const template =
    "^\\[\\)>[\\x1d\\x1e\\xA0]?06[\\x1d\\xA0]LT(?<serialNo>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]PN(?<itemId>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]RV[^\\x1d\\xA0]*[\\x1d\\xA0]QT(?<qty>\\d+)[\\x1d\\xA0]PO[^\\x1d\\xA0]*[\\x1d\\xA0]BT(?<lotCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]BX[^\\x1d\\xA0]+[\\x1d\\xA0]DC(?<dateCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1e\\x04]*$";
  const raw =
    "[)>\x1e06\x1dLT3S550200578934\x1dPN1376348-1\x1dRVF\x1dQT5000\x1dPO200234935045\x1dBT26374N\x1dBX1\x1dDC26374\x1e\x04";
  const parsed = parseQrRaw(raw, template, null, "yywwd");
  assert.equal(parsed.partNo, "1376348-1");
  assert.equal(parsed.qty, 5000);
  assert.equal(parsed.dateCode, "3726"); // "26374" → wk37/2026, day dropped, WWYY
  assert.equal(parsed.lotCode, "26374N");
  assert.equal(parsed.serialNo, "3S550200578934");
  // yyww label format: identity, no pair swap
  assert.equal(parseQrRaw(raw, template, null, "yywwd", undefined, "yyww").dateCode, "2637");
  // without the encoding the raw 5-digit code passes through unchanged
  assert.equal(parseQrRaw(raw, template, null, null).dateCode, "26374");
});

test("parseQrRaw: apps-web KOA template variant (empty subId segment)", () => {
  // Verbatim from apps/web/tests/parseOcrScan.test.ts — no serialNo group:
  // older templates are tolerated and simply yield no serial.
  const template = "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$";
  const parsed = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", template, "koa_zeros");
  assert.equal(parsed.partNo, "RK73H2ATTD2403F");
  assert.equal(parsed.qty, 25000); // "253" → 25 × 10^3
  assert.equal(parsed.lotCode, "63048349");
  assert.equal(parsed.serialNo, undefined);
});

test("parseQrRaw: admin editor config builds a matching-equivalent KOA regex", async () => {
  // Mirror of buildRegex (delimited mode) in apps/admin/utils/qrTemplate.ts —
  // guards generator/parser drift: editor-generated regexes must parse here.
  function buildDelimited(delimiter: string, roles: string[]): string {
    const d = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return "^" + roles.map((r) => (r === "ignore" ? `[^${d}]*` : `(?<${r}>[^${d}]*)`)).join(d) + "$";
  }
  const profile = await queryGet<{
    qrTemplateConfig: { delimiter: string; fields: { role: string }[] };
  }>(
    client.db,
    sql`SELECT qr_template_config AS "qrTemplateConfig" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplateConfig, "seeded KOA profile carries a qr_template_config");
  const regex = buildDelimited(
    profile.qrTemplateConfig.delimiter,
    profile.qrTemplateConfig.fields.map((f) => f.role)
  );
  const inner = parseQrRaw(":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F", regex, "koa_zeros");
  assert.equal(inner.partNo, "RK73H1JTTD1002F");
  assert.equal(inner.qty, 10000);
  assert.equal(inner.lotCode, "L2601A"); // segment 5 role is lotCode in the seeded config
  assert.equal(inner.serialNo, "602");
  // outer label with an empty subId piece must match too
  const outer = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", regex, "koa_zeros");
  assert.equal(outer.partNo, "RK73H2ATTD2403F");
  assert.equal(outer.qty, 25000);
  assert.equal(outer.lotCode, "63048349");
});

test("parseQrRaw: ABLIC $-reel QR derives wclItemNo from the single-brand prefix", () => {
  const profile = builtinSupplierProfiles.find((p) => p.supplierCode === "84915");
  assert.ok(profile?.qrTemplate);
  // Real label shape: 1 $ MPN $ qty $ lot $ MPN-repeat $ yyyymm $ serial
  // (trailing spaces tolerated). The MPN-repeat segment is the itemId.
  const raw = "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007          ";
  const parsed = parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding ?? null, profile.dateCodeEncoding ?? null, undefined, "wwyy", profile.brands);
  assert.equal(parsed.partNo, "S-812C33AMC-C2NT2U");
  assert.equal(parsed.qty, 3000);
  assert.equal(parsed.lotCode, "VM5F6XA0033-0308");
  // yyyymm_midmonth: "202606" → 2026-06-15 → ISO week 25 → WWYY "2526"
  assert.equal(parsed.dateCode, "2526");
  assert.equal(parsed.serialNo, "66VM1953007");
  // ABLIC parts are stored as wcl_item_no "ABLIC/<mpn>"; the label prints no
  // WCL item no, so the single-brand profile derives it.
  assert.equal(parsed.wclItemNo, "ABLIC/S-812C33AMC-C2NT2U");

  // Without the profile brands there is nothing to derive from.
  assert.equal(parseQrRaw(raw, profile.qrTemplate, null).wclItemNo, undefined);
  // Multi-brand profiles never derive (the prefix would be ambiguous).
  assert.equal(parseQrRaw(raw, profile.qrTemplate, null, null, undefined, "wwyy", ["COPAL", "NIDEC"]).wclItemNo, undefined);
  // An explicit wclItemNo group always wins over the derivation.
  const koa = builtinSupplierProfiles.find((p) => p.supplierCode === "32")!;
  const koaParsed = parseQrRaw(":SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01", koa.qrTemplate, koa.qtyEncoding ?? null, koa.dateCodeEncoding ?? null, undefined, "wwyy", koa.brands);
  assert.equal(koaParsed.wclItemNo, "KOA/SR732ERTTDR200F");
});

test("parseQrRaw: COPAL new-layout reels — spec token, lowercase ohm, resCode appended", () => {
  const profile = builtinSupplierProfiles.find((p) => p.supplierCode === "19915");
  assert.ok(profile?.qrTemplate);
  const parse = (raw: string) =>
    parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding ?? null, profile.dateCodeEncoding ?? null, undefined, "wwyy", profile.brands);

  // Switch label (no OHM spec): the "03" spec token must not become the qty.
  const sw = parse("254442210031                CFS-0402MC           03                    240   240   C6Y      6101300000 AA        C");
  assert.equal(sw.partNo, "CFS-0402MC");
  assert.equal(sw.qty, 240);
  assert.equal(sw.serialNo, "6101300000");

  // Trimmer labels: lowercase "ohm", 3-digit "100K", spec token — resCode is
  // appended to the itemId because parts.part_no stores the resistance code
  // ("SM-3TW 104" / "FT-63ES 202"; normalizePartNo collapses whitespace).
  const sm3 = parse("206440005101                SM-3 TW        01   100K ohm(104)       1000  1000  C6H      6081500000 AA        C");
  assert.equal(sm3.partNo, "SM-3TW104");
  assert.equal(sm3.qty, 1000);
  const ft63 = parse("202821003211                FT-63 ES      10    2K   ohm(202)        1000  2142  C6J      609090084RR8J05741448C");
  assert.equal(ft63.partNo, "FT-63ES202");
  assert.equal(ft63.qty, 1000);
  assert.equal(ft63.serialNo, "609090084RR8J05741448C");

  // Old-layout reels keep parsing (uppercase OHM, no spec token).
  const old = parse("202821003111                FT-63 ES            1K  OHM(102)        1000  1413  C6F      607020289RR8J05662768C");
  assert.equal(old.partNo, "FT-63ES102");
  assert.equal(old.qty, 1000);
  const plain = parse("234101510021                CJS-1200TB1                             2000  2071  C6E      605220557MMJ805615383C");
  assert.equal(plain.partNo, "CJS-1200TB1");
  assert.equal(plain.qty, 2000);
});

test("decodeYyyymmMidmonthDateCode: YYYYMM anchored on the 15th → ISO week", () => {
  // 2026-06-15 is the Monday of ISO week 25; 2026-07-15 → week 29.
  assert.equal(decodeYyyymmMidmonthDateCode("202606"), "2526");
  assert.equal(decodeYyyymmMidmonthDateCode("202607"), "2926");
  assert.equal(decodeYyyymmMidmonthDateCode("202601"), "0326");
  // yyww label format: pair-swapped (canonical YYWW passes through).
  assert.equal(decodeYyyymmMidmonthDateCode("202606", "yyww"), "2625");
  // invalid
  assert.equal(decodeYyyymmMidmonthDateCode("202613"), undefined); // month 13
  assert.equal(decodeYyyymmMidmonthDateCode("202600"), undefined); // month 00
  assert.equal(decodeYyyymmMidmonthDateCode("20266"), undefined); // too short
  assert.equal(decodeYyyymmMidmonthDateCode("ABCDEF"), undefined);
});

test("parseQrRaw: no template / no match / invalid regex → {}", () => {
  assert.deepEqual(parseQrRaw("whatever", null, null), {});
  assert.deepEqual(
    parseQrRaw("SOME-RANDOM-STRING", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)", "koa_zeros"),
    {}
  );
  assert.deepEqual(parseQrRaw(":RK73H1JTTD4702F::11", "(?<itemId>[", null), {});
  // plain integer qty encoding (no koa_zeros)
  assert.equal(parseQrRaw(":RK73H1JTTD4702F::11", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)$", null).qty, 11);
});

// --- scan --------------------------------------------------------------------

test("scan: happy path — partial receipt, provisional_received, ledger row", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002"); // pending KOA order
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 600

  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 200,
    dateCode: "2610",
    lotCode: "L-A",
  });
  assert.equal(item.id, itemId);
  assert.equal(item.receivedQty, 200);

  const order = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "provisional_received");

  const logs = await queryAll<{ fromState: string; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState, l.actorId]),
    [["pending", "provisional_received", actorId]]
  );

  // (SO-DEMO-0002 has open demand for this part, so allocation RESERVE
  // rows also reference the item — filter to the receipt rows.
  // SO-DEMO-0001's 181G×300 demand is fully covered by the A0102 shelf
  // lot, so dock receipts here only ever allocate to SO-DEMO-0002.)
  const txns = await queryAll<{
    txnType: string;
    qtyType: string;
    qtyDelta: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    referenceType: string;
    referenceId: string;
    receivingInvoiceItemId: string;
    actorId: string;
  }>(
    client.db,
    sql`SELECT txn_type AS "txnType", qty_type AS "qtyType", qty_delta AS "qtyDelta",
               date_code AS "dateCode", lot_code AS "lotCode", coo,
               reference_type AS "referenceType", reference_id AS "referenceId",
               receiving_invoice_item_id AS "receivingInvoiceItemId", actor_id AS "actorId"
        FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${itemId} AND txn_type = 'RECEIVE_TO_DOCK'`
  );
  assert.equal(txns.length, 1);
  assert.deepEqual(
    [txns[0].txnType, txns[0].qtyType, txns[0].qtyDelta, txns[0].dateCode, txns[0].lotCode, txns[0].coo],
    ["RECEIVE_TO_DOCK", "dock", 200, "2610", "L-A", "JP"] // coo falls back to the item
  );
  assert.equal(txns[0].referenceType, "receiving_order");
  assert.equal(txns[0].referenceId, orderId);
  assert.equal(txns[0].actorId, actorId);

  // second scan: stays provisional_received, no extra transition log
  const again = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "rk73b1jttd181g ", qty: 200 });
  assert.equal(again.receivedQty, 400);
  const logCount = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.equal(logCount!.c, 1);
});

test("scan: raw QR template parse applies receipt (KOA order)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100001"); // KOA order

  // status guard: clear orders cannot be scanned
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'clear' WHERE id = ${orderId}`);
  const err = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD1002F", qty: 1 }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_scan_in_status_clear");

  // reopen the order for the scan-parse flow (received_qty is already 0)
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'pending' WHERE id = ${orderId}`);

  // raw only: template parses part + koa_zeros qty (152 → 1500)
  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });
  assert.equal(item.partNo, "RK73H1JTTD1002F");
  assert.equal(item.receivedQty, 1500);

  const txn = await queryGet<{ qtyDelta: number; lotCode: string | null; dateCode: string | null }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta", lot_code AS "lotCode", date_code AS "dateCode"
        FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${item.id} AND txn_type = 'RECEIVE_TO_DOCK'`
  );
  // the KOA template's segment 5 is preserved as the lot code ("L2601A" wins
  // over the seeded item's lot_code); it has no leading digits so no date code
  // decodes, and dateCode falls back to the item's
  assert.deepEqual([txn!.qtyDelta, txn!.lotCode, txn!.dateCode], [1500, "L2601A", "2605"]);

  // explicit fields override parsed ones (part + qty from the body win; an
  // explicit serialNo also overrides the parsed one — the raw's 602 was
  // already scanned above and would be rejected as label_already_scanned)
  const other = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
    partNo: "RK73H1JTTD2202F",
    qty: 100,
    serialNo: "602-B",
  });
  assert.equal(other.partNo, "RK73H1JTTD2202F");
  assert.equal(other.receivedQty, 100);
  assert.equal(other.serialNo, "602-B");
});

test("scan: ABLIC raw QR matches via the derived brand-prefixed wcl_item_no", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");

  // parts.part_no is NOT unique: the same MPN sits under two WCL item
  // numbers. The ABLIC $-reel QR carries only the bare MPN, so the
  // single-brand profile derivation (ABLIC/<mpn>) must land the scan on the
  // ABLIC line — the bare partNo alone would hit both lines (multiple_matches).
  await client.db.execute(
    sql`INSERT INTO suppliers (id, code, name) VALUES (${randomUUID()}, '84915', 'ABLIC HONG KONG LTD.') ON CONFLICT (code) DO NOTHING`
  );
  // the demo/test world seeds only the KOA profiles — attach the built-in
  // ABLIC profile (template + brands) to the supplier.
  const ablicProfile = builtinSupplierProfiles.find((p) => p.supplierCode === "84915")!;
  await client.db.execute(
    sql`INSERT INTO supplier_profiles (id, supplier_code, qr_template, date_code_encoding, brands)
        VALUES (${randomUUID()}, '84915', ${ablicProfile.qrTemplate}, ${ablicProfile.dateCodeEncoding ?? null}, ${`{${(ablicProfile.brands ?? []).join(",")}}`}::text[])
        ON CONFLICT (supplier_code) DO NOTHING`
  );
  await client.db.execute(
    sql`INSERT INTO parts (id, brand, part_no, wcl_item_no) VALUES
        (${randomUUID()}, 'ABLIC', 'S-812C33AMC-C2NT2U', 'ABLIC/S-812C33AMC-C2NT2U'),
        (${randomUUID()}, 'OTHER', 'S-812C33AMC-C2NT2U', 'OTHER/S-812C33AMC-C2NT2U')
        ON CONFLICT (wcl_item_no) DO NOTHING`
  );
  const orderId = await insertReceivingOrder(client.db, "ABLIC-SCAN-1", {
    order: { supplierCode: "84915" },
    invoices: [
      {
        invoiceNo: "INV-ABLIC-1",
        items: [
          { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "ABLIC/S-812C33AMC-C2NT2U", lineQty: 3000 },
          { partNo: "S-812C33AMC-C2NT2U", wclItemNo: "OTHER/S-812C33AMC-C2NT2U", lineQty: 1000 },
        ],
      },
    ],
  });

  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007",
  });
  assert.equal(item.wclItemNo, "ABLIC/S-812C33AMC-C2NT2U");
  assert.equal(item.receivedQty, 3000);
  assert.equal(item.serialNo, "66VM1953007");

  // the YYYYMM month date code is decoded to the week code (anchored on the
  // 15th): "202606" → 2026-06-15 → ISO week 25 → WWYY "2526"
  const txn = await queryGet<{ dateCode: string | null }>(
    client.db,
    sql`SELECT date_code AS "dateCode" FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${item.id} AND txn_type = 'RECEIVE_TO_DOCK'`
  );
  assert.equal(txn!.dateCode, "2526");

  // the other same-part line stays untouched
  const other = await queryGet<{ receivedQty: number }>(
    client.db,
    sql`SELECT received_qty AS "receivedQty" FROM receiving_invoice_items WHERE wcl_item_no = 'OTHER/S-812C33AMC-C2NT2U'`
  );
  assert.equal(other!.receivedQty, 0);
});

test("scan: 409 when qty exceeds the remaining qty", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 601 })
  );
  assert.equal(err.status, 409);
  assert.equal(err.message, "scanned_qty_exceeds_remaining");
});

test("scan: no match → 409 JSON with all order items as candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "NOPE-123", qty: 10 })
  );
  assert.equal(err.status, 409);
  const body = await err.getResponse().json();
  assert.equal(body.message, "no_match");
  assert.equal(body.candidates.length, 5);
  assert.deepEqual(
    body.candidates.map((c: { partNo: string }) => c.partNo).sort(),
    ["RK73B1JTTD181G", "RK73H1JTTD1002F", "RK73H1JTTD2202F", "RK73H1JTTD4702F", "RK73H2ATTD1372F"]
  );
  assert.deepEqual(Object.keys(body.candidates[0]).sort(), ["id", "lineQty", "partNo", "receivedQty", "wclItemNo"].sort());
});

test("scan: multiple matches → 409 JSON with the matching candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  // make the RK73H1JTTD4702F item also match the scanned part number via its wcl_item_no
  const rk4702ItemId = await itemIdOf(orderId, "RK73H1JTTD4702F");
  await client.db.execute(
    sql`UPDATE receiving_invoice_items SET wcl_item_no = 'RK73B1JTTD181G' WHERE id = ${rk4702ItemId}`
  );

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 10 })
  );
  assert.equal(err.status, 409);
  const body = await err.getResponse().json();
  assert.equal(body.message, "multiple_matches");
  assert.equal(body.candidates.length, 2);
});

test("scan: validations — actorId, actor_not_found, order 404, qty", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const notFound = await catchHttp(
    scanReceivingOrder(client.db, "00000000-0000-4000-8000-000000000099", { actorId, partNo: "RK73H1JTTD4702F", qty: 1 })
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "receiving_order_not_found");

  const badActor = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId: "00000000-0000-4000-8000-000000000099", partNo: "RK73H1JTTD4702F", qty: 1 })
  );
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  const badQty = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 0 }));
  assert.equal(badQty.status, 400);
  assert.equal(badQty.message, "qty_must_be_positive_integer");
});

// --- S-key scan dedup (receiving_scan_labels) -----------------------------------

test("scan: serial dedup — repeat serial on the same order → 409 label_already_scanned", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100001"); // KOA order (has a serialNo template)
  const itemId = await itemIdOf(orderId, "RK73H1JTTD1002F");

  // first scan of the label: applies, records the serial (602), echoes it back
  const raw = ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F";
  const item = await scanReceivingOrder(client.db, orderId, { actorId, raw });
  assert.equal(item.receivedQty, 1500);
  assert.equal(item.serialNo, "602");

  const label = await queryGet<{ receivingOrderId: string; receivingInvoiceItemId: string; serialNo: string; qty: number; scannedBy: string }>(
    client.db,
    sql`SELECT receiving_order_id AS "receivingOrderId", receiving_invoice_item_id AS "receivingInvoiceItemId",
               serial_no AS "serialNo", qty, scanned_by AS "scannedBy"
        FROM receiving_scan_labels WHERE receiving_order_id = ${orderId}`
  );
  assert.deepEqual(label, { receivingOrderId: orderId, receivingInvoiceItemId: itemId, serialNo: "602", qty: 1500, scannedBy: actorId });

  // repeat scan of the same label: rejected even though it would also exceed
  // the remaining qty — the dedup error wins (pre-check before the qty guard)
  const dup = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, raw }));
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");

  // no extra receipt was applied
  const after = await queryGet<{ receivedQty: number }>(
    client.db,
    sql`SELECT received_qty AS "receivedQty" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(after!.receivedQty, 1500);
});

test("scan: same serial on a DIFFERENT part of the same order is allowed", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100001"); // KOA order (has a serialNo template)

  // first label: RK73H1JTTD1002F with serial 602
  await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });

  // a different part carrying the same serial value is a different physical
  // label (KOA reel labels reuse segment-6 values across parts of one
  // delivery) — allowed, and both dedup rows are recorded
  const other = await scanReceivingOrder(client.db, orderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 100,
    serialNo: "602",
  });
  assert.equal(other.receivedQty, 100);
  assert.equal(other.serialNo, "602");

  const count = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM receiving_scan_labels WHERE receiving_order_id = ${orderId} AND serial_no = '602'`
  );
  assert.equal(count!.c, 2);

  // ...but repeating the serial on the same part is still rejected
  const dup = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 100, serialNo: "602" })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");
});

test("scan: same serial on a DIFFERENT order is allowed", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const koaOrderId = await orderIdOf("100001");
  const secondOrderId = await orderIdOf("100002"); // also KOA — serial dedup is per order

  // KOA order: serial from the raw template parse
  await scanReceivingOrder(client.db, koaOrderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });

  // second order: same serial value via the explicit body field — allowed
  // (uniqueness is per receiving order)
  const other = await scanReceivingOrder(client.db, secondOrderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 100,
    serialNo: "602",
  });
  assert.equal(other.receivedQty, 100);
  assert.equal(other.serialNo, "602");

  const count = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM receiving_scan_labels WHERE serial_no = '602'`
  );
  assert.equal(count!.c, 2);

  // ...but the repeat on the second order is still rejected
  const dup = await catchHttp(
    scanReceivingOrder(client.db, secondOrderId, { actorId, partNo: "RK73B1JTTD181G", qty: 100, serialNo: "602" })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");
});

test("scan: no serial → no dedup row, repeat scans still apply", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002"); // explicit fields, no raw template parse

  const first = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 100 });
  assert.equal(first.serialNo, null);
  const second = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 100 });
  assert.equal(second.receivedQty, 200);
  assert.equal(second.serialNo, null);

  const count = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM receiving_scan_labels WHERE receiving_order_id = ${orderId}`
  );
  assert.equal(count!.c, 0);
});

// --- mismatch lifecycle --------------------------------------------------------

test("mismatch: report → edit → confirm → cancel (+ logs, no qty effect)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const otherItemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  assert.equal(await getReceivingItemMismatch(client.db, itemId), null);

  const reported = await reportReceivingItemMismatch(client.db, itemId, {
    actorId,
    reason: "qty_mismatch",
    mismatchQty: 100,
    note: " short ",
  });
  assert.deepEqual(reported, { reason: "qty_mismatch", mismatchQty: 100, wrongPartNo: null, note: "short" });

  const dup = await catchHttp(
    reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "damaged", mismatchQty: 1 })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "mismatch_already_reported");

  assert.deepEqual(await getReceivingItemMismatch(client.db, itemId), {
    reason: "qty_mismatch",
    mismatchQty: 100,
    wrongPartNo: null,
    note: "short",
  });

  // edit: absent fields unchanged, present fields replaced
  const edited = await editReceivingItemMismatch(client.db, itemId, { actorId, mismatchQty: 200, wrongPartNo: "X-1" });
  assert.deepEqual(edited, { reason: "qty_mismatch", mismatchQty: 200, wrongPartNo: "X-1", note: "short" });

  // confirm: stays flagged, writes the transition log
  const confirmed = await confirmReceivingItemMismatch(client.db, itemId, actorId);
  assert.deepEqual(confirmed, edited);
  assert.notEqual(await getReceivingItemMismatch(client.db, itemId), null);

  // cancel: clears flag + fields
  assert.equal(await cancelReceivingItemMismatch(client.db, itemId, actorId), null);
  assert.equal(await getReceivingItemMismatch(client.db, itemId), null);
  const stored = await queryGet<{ reportedMismatch: boolean; mismatchReason: string | null; mismatchQty: number | null }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_qty AS "mismatchQty"
        FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.deepEqual(stored, { reportedMismatch: false, mismatchReason: null, mismatchQty: null });

  // logs: reported → updated → confirmed → cancelled on the item
  const states = await queryAll<{ fromState: string | null; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'receiving_invoice_item' AND entity_id = ${itemId}
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    states.map((l) => [l.fromState, l.toState, l.actorId]),
    [
      [null, "mismatch_reported", actorId],
      ["mismatch_reported", "mismatch_updated", actorId],
      ["mismatch_reported", "mismatch_confirmed", actorId],
      ["mismatch_reported", "mismatch_cancelled", actorId],
    ]
  );

  // error paths
  const editNone = await catchHttp(editReceivingItemMismatch(client.db, otherItemId, { actorId, mismatchQty: 5 }));
  assert.equal(editNone.status, 404);
  assert.equal(editNone.message, "mismatch_not_found");

  const confirmNone = await catchHttp(confirmReceivingItemMismatch(client.db, otherItemId, actorId));
  assert.equal(confirmNone.status, 404);
  assert.equal(confirmNone.message, "mismatch_not_found");

  const cancelNone = await catchHttp(cancelReceivingItemMismatch(client.db, otherItemId, actorId));
  assert.equal(cancelNone.status, 404);
  assert.equal(cancelNone.message, "mismatch_not_found");

  const missing = await catchHttp(getReceivingItemMismatch(client.db, "00000000-0000-4000-8000-000000000099"));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_invoice_item_not_found");

  // mismatch reporting never touches received_qty (pending order stays at 0)
  const qtyRow = await queryGet<{ receivedQty: number }>(
    client.db,
    sql`SELECT received_qty AS "receivedQty" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(qtyRow!.receivedQty, 0);
});

test("mismatch list: items across two orders returned with order/invoice joins", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const secondOrderId = await orderIdOf("100002");
  const koaOrderId = await orderIdOf("100001");
  const secondItemId = await itemIdOf(secondOrderId, "RK73B1JTTD181G");
  const koaItemId = await itemIdOf(koaOrderId, "RK73H1JTTD1002F");
  const invoiceIdOf = async (invoiceNo: string) =>
    (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_invoices WHERE invoice_no = ${invoiceNo}`))!.id;

  assert.deepEqual(await listReceivingMismatches(client.db), []);

  await reportReceivingItemMismatch(client.db, secondItemId, {
    actorId,
    reason: "qty_mismatch",
    mismatchQty: 100,
    note: "short",
  });
  await reportReceivingItemMismatch(client.db, koaItemId, {
    actorId,
    reason: "wrong_part",
    wrongPartNo: "RK73H1JTTD9999F",
  });

  const rows = await listReceivingMismatches(client.db);
  assert.equal(rows.length, 2);
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  assert.deepEqual(byItem.get(secondItemId), {
    itemId: secondItemId,
    receivingOrderId: secondOrderId,
    batchNo: "100002",
    invoiceId: await invoiceIdOf("INV-100002-01"),
    invoiceNo: "INV-100002-01",
    partNo: "RK73B1JTTD181G",
    wclItemNo: "RK73B1JTTD181G",
    supplierCode: "KOA",
    reason: "qty_mismatch",
    mismatchQty: 100,
    wrongPartNo: null,
    note: "short",
  });
  assert.deepEqual(byItem.get(koaItemId), {
    itemId: koaItemId,
    receivingOrderId: koaOrderId,
    batchNo: "100001",
    invoiceId: await invoiceIdOf("INV-100001-01"),
    invoiceNo: "INV-100001-01",
    partNo: "RK73H1JTTD1002F",
    wclItemNo: "RK73H1JTTD1002F",
    supplierCode: "KOA",
    reason: "wrong_part",
    mismatchQty: null,
    wrongPartNo: "RK73H1JTTD9999F",
    note: null,
  });

  // cancelling drops the item from the open list
  await cancelReceivingItemMismatch(client.db, secondItemId, actorId);
  const after = await listReceivingMismatches(client.db);
  assert.deepEqual(after.map((r) => r.itemId), [koaItemId]);
});

// --- confirm-arrival from provisional_received ---------------------------------

test("confirm-arrival: provisional_received completes the remaining receipt", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  // seed insert order (also the id order): RK73H1JTTD4702F, RK73B1JTTD181G, RK73H2ATTD1372F, RK73H1JTTD1002F, RK73H1JTTD2202F
  const rk4702ItemId = await itemIdOf(orderId, "RK73H1JTTD4702F"); // qty 1200
  const scannedItemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 600
  const h2aItemId = await itemIdOf(orderId, "RK73H2ATTD1372F"); // qty 900
  const h1002ItemId = await itemIdOf(orderId, "RK73H1JTTD1002F"); // qty 400
  const h2202ItemId = await itemIdOf(orderId, "RK73H1JTTD2202F"); // qty 300

  await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 200 });

  const result = await confirmReceivingArrival(client.db, orderId, actorId);
  assert.equal(result.status, "in_hand");

  const items = await queryAll<{ id: string; receivedQty: number; lineQty: number }>(
    client.db,
    sql`SELECT rii.id, rii.received_qty AS "receivedQty", rii.line_qty AS "lineQty"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} ORDER BY rii.id`
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.receivedQty, i.lineQty]),
    [
      [rk4702ItemId, 1200, 1200],
      [scannedItemId, 600, 600],
      [h2aItemId, 900, 900],
      [h1002ItemId, 400, 400],
      [h2202ItemId, 300, 300],
    ]
  );

  // ledger: confirm-arrival tops up only the remaining deltas per item
  const deltas = await queryAll<{ itemId: string; delta: number }>(
    client.db,
    sql`SELECT receiving_invoice_item_id AS "itemId", SUM(qty_delta)::int AS delta
        FROM inventory_transactions WHERE txn_type = 'RECEIVE_TO_DOCK' AND reference_id = ${orderId}
        GROUP BY receiving_invoice_item_id ORDER BY receiving_invoice_item_id`
  );
  assert.deepEqual(
    deltas.map((d) => [d.itemId, d.delta]),
    [
      [rk4702ItemId, 1200],
      [scannedItemId, 600], // 200 scanned + 400 confirmed
      [h2aItemId, 900],
      [h1002ItemId, 400],
      [h2202ItemId, 300],
    ]
  );

  const logs = await queryAll<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState]),
    [
      ["pending", "provisional_received"],
      ["provisional_received", "in_hand"],
    ]
  );

  const again = await catchHttp(confirmReceivingArrival(client.db, orderId, actorId));
  assert.equal(again.status, 409);
  assert.equal(again.message, "cannot_confirm_arrival_from_in_hand");
});

// --- confirm-arrival sub-inventory defaulting (spec 2026-09-02) --------------

test("poNoGlobTest: glob semantics — prefix, suffix, both, catch-all, literals", () => {
  assert.equal(poNoGlobTest("319*", "319/ABC"), true); // prefix
  assert.equal(poNoGlobTest("319*", "0319"), false);
  assert.equal(poNoGlobTest("*W", "11AB/W"), true); // suffix
  assert.equal(poNoGlobTest("*W", "W123"), false);
  assert.equal(poNoGlobTest("11*W", "11AB/W"), true); // prefix + suffix
  assert.equal(poNoGlobTest("11*W", "11W"), true); // * matches the empty run
  assert.equal(poNoGlobTest("11*W", "11AB/X"), false);
  assert.equal(poNoGlobTest("*", ""), true); // catch-all, matches empty/NULL
  assert.equal(poNoGlobTest("A.B", "AXB"), false); // regex chars are literal
  assert.equal(poNoGlobTest("A.B", "A.B"), true);
});

test("confirm-arrival: receivingSubInventoryRules stamp sub_inventory_code (glob, group default, org filter)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  // Controlled (org_id, po_no, sub_inventory_code) per item — codes must be
  // org_info pairs that exist in the seed (composite FK).
  const org140Prefix = await itemIdOf(orderId, "RK73H1JTTD4702F");
  const org143Suffix = await itemIdOf(orderId, "RK73H1JTTD2202F");
  const org143CatchAll = await itemIdOf(orderId, "RK73B1JTTD181G");
  const org2Unmatched = await itemIdOf(orderId, "RK73H2ATTD1372F");
  const org140NullPo = await itemIdOf(orderId, "RK73H1JTTD1002F");
  await client.db.execute(sql`UPDATE receiving_invoice_items SET org_id = 140, po_no = '319/ABC', sub_inventory_code = NULL WHERE id = ${org140Prefix}`);
  await client.db.execute(sql`UPDATE receiving_invoice_items SET org_id = 143, po_no = '11AB/W', sub_inventory_code = NULL WHERE id = ${org143Suffix}`);
  await client.db.execute(sql`UPDATE receiving_invoice_items SET org_id = 143, po_no = '999/XYZ', sub_inventory_code = 'STAGING' WHERE id = ${org143CatchAll}`);
  await client.db.execute(sql`UPDATE receiving_invoice_items SET org_id = 2, po_no = '319/ABC', sub_inventory_code = 'WSTORE1' WHERE id = ${org2Unmatched}`);
  await client.db.execute(sql`UPDATE receiving_invoice_items SET org_id = 140, po_no = NULL, sub_inventory_code = NULL WHERE id = ${org140NullPo}`);

  _setReceivingSubInventoryRulesForTests([
    {
      orgIds: [140, 143, 120],
      patterns: [
        { poNoPattern: "319*", subInventoryCode: "SZHK1" },
        { poNoPattern: "11*W", subInventoryCode: "STAGING" },
      ],
      default: "STORE1",
    },
  ]);
  try {
    await confirmReceivingArrival(client.db, orderId, actorId);
  } finally {
    _setReceivingSubInventoryRulesForTests([]);
  }

  const rows = await queryAll<{ id: string; subInventoryCode: string | null }>(
    client.db,
    sql`SELECT id, sub_inventory_code AS "subInventoryCode" FROM receiving_invoice_items
        WHERE ${inArray(sql`id`, [org140Prefix, org143Suffix, org143CatchAll, org2Unmatched, org140NullPo])}`
  );
  const byId = new Map(rows.map((r) => [r.id, r.subInventoryCode]));
  assert.equal(byId.get(org140Prefix), "SZHK1"); // prefix glob
  assert.equal(byId.get(org143Suffix), "STAGING"); // prefix+suffix glob
  assert.equal(byId.get(org143CatchAll), "STORE1"); // group default overwrites upstream value
  assert.equal(byId.get(org2Unmatched), "WSTORE1"); // org in no group → untouched
  assert.equal(byId.get(org140NullPo), "STORE1"); // NULL po_no falls to the group default
});

// --- admin audit logs + item removal (2026-07-27 design) ---------------------

test("receiving order logs: order + item rows with actor name, newest first; 404 unknown order", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");

  assert.deepEqual(await listReceivingOrderLogs(client.db, orderId), []);

  await reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "damaged", note: "wet carton" });
  await confirmReceivingArrival(client.db, orderId, actorId);
  // rows logged against another order must not leak in
  const otherItemId = await itemIdOf(await orderIdOf("100001"), "RK73H1JTTD1002F");
  await reportReceivingItemMismatch(client.db, otherItemId, { actorId, reason: "not_found" });

  // both logs can share a millisecond — make the order deterministic
  await client.db.execute(
    sql`UPDATE transaction_logs SET created_date = created_date - interval '1 minute' WHERE to_state = 'mismatch_reported'`
  );

  const logs = await listReceivingOrderLogs(client.db, orderId);
  assert.equal(logs.length, 2);

  const [orderLog, itemLog] = logs;
  assert.equal(orderLog!.entityType, "receiving_order");
  assert.equal(orderLog!.entityId, orderId);
  assert.equal(orderLog!.fromState, "pending");
  assert.equal(orderLog!.toState, "in_hand");
  assert.equal(orderLog!.actorId, actorId);
  assert.equal(orderLog!.actorName, "Demo Operator");
  assert.ok(orderLog!.createdDate > itemLog!.createdDate);

  assert.equal(itemLog!.entityType, "receiving_invoice_item");
  assert.equal(itemLog!.entityId, itemId);
  assert.equal(itemLog!.fromState, null);
  assert.equal(itemLog!.toState, "mismatch_reported");
  assert.equal(itemLog!.actorId, actorId);
  assert.equal(itemLog!.actorName, "Demo Operator");
  assert.equal(itemLog!.metadata.reason, "damaged");
  assert.equal(itemLog!.metadata.note, "wet carton");
  assert.equal(itemLog!.metadata.partNo, "RK73B1JTTD181G");

  // paged variant: { rows, total } with LIMIT/OFFSET over the same WHERE
  const page1 = await listReceivingOrderLogs(client.db, orderId, { page: 1, pageSize: 1 });
  assert.ok(!Array.isArray(page1));
  assert.equal(page1.total, 2);
  assert.equal(page1.rows.length, 1);
  assert.equal(page1.rows[0]!.toState, "in_hand");
  const page2 = await listReceivingOrderLogs(client.db, orderId, { page: 2, pageSize: 1 });
  assert.ok(!Array.isArray(page2));
  assert.equal(page2.total, 2);
  assert.equal(page2.rows[0]!.toState, "mismatch_reported");

  // q searches actor name and metadata::text (partNo lands there via itemMeta)
  const byActor = await listReceivingOrderLogs(client.db, orderId, { page: 1, q: "Demo Operator" });
  assert.ok(!Array.isArray(byActor));
  assert.equal(byActor.total, 2);
  const byPart = await listReceivingOrderLogs(client.db, orderId, { page: 1, q: "RK73B1JTTD181G" });
  assert.ok(!Array.isArray(byPart));
  assert.equal(byPart.total, 1);
  assert.equal(byPart.rows[0]!.entityType, "receiving_invoice_item");

  // sort whitelist: toState asc puts in_hand before mismatch_reported
  const sorted = await listReceivingOrderLogs(client.db, orderId, { page: 1, sort: "toState", dir: "asc" });
  assert.ok(!Array.isArray(sorted));
  assert.deepEqual(sorted.rows.map((l) => l.toState), ["in_hand", "mismatch_reported"]);

  const missing = await catchHttp(listReceivingOrderLogs(client.db, randomUUID()));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_order_not_found");
});

test("delete receiving item: row gone, order log row + event written", async () => {
  await reseed(client);
  const actorId = await actorIdOf("admin");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  await reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "over_shipment" });
  const before = await queryGet<{ invoiceId: string }>(
    client.db,
    sql`SELECT receiving_invoice_id AS "invoiceId" FROM receiving_invoice_items WHERE id = ${itemId}`
  );

  const result = await deleteReceivingInvoiceItem(client.db, { itemId, actorId });
  assert.deepEqual(result, { id: itemId, receivingOrderId: orderId });

  // row gone
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM receiving_invoice_items WHERE id = ${itemId}`),
    undefined
  );

  // audit trail survives on the order
  const log = await queryGet<{
    fromState: string | null;
    toState: string;
    actorId: string;
    metadata: Record<string, unknown>;
  }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId", metadata
        FROM transaction_logs
        WHERE entity_type = 'receiving_order' AND entity_id = ${orderId} AND to_state = 'item_removed'`
  );
  assert.equal(log!.fromState, null);
  assert.equal(log!.actorId, actorId);
  assert.deepEqual(log!.metadata, {
    itemId,
    invoiceId: before!.invoiceId,
    partNo: "RK73H1JTTD4702F",
    poNo: "PO-DAI-201",
    poLine: "1",
    hadMismatch: true,
  });

  // SSE event for open pages
  const evt = await queryGet<{ topics: string[]; data: Record<string, unknown> }>(
    client.db,
    sql`SELECT topics, data FROM app_events WHERE type = 'receiving_order.item_removed'`
  );
  assert.deepEqual(evt!.topics, ["/receiving-orders"]);
  assert.equal(evt!.data.orderId, orderId);
  assert.equal(evt!.data.itemId, itemId);

  // the removed item no longer appears in the order's audit-log item ids
  const logs = await listReceivingOrderLogs(client.db, orderId);
  assert.deepEqual(logs.map((l) => l.toState), ["item_removed"]);
});

test("delete receiving item: 409 item_work_started for each guard; 404 unknown", async () => {
  await reseed(client);
  const actorId = await actorIdOf("admin");
  const orderId = await orderIdOf("100002");
  const scannedItemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const itemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  const missing = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId: randomUUID(), actorId }));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_invoice_item_not_found");

  const expectBlocked = async () => {
    const err = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId, actorId }));
    assert.equal(err.status, 409);
    assert.equal(err.message, "item_work_started");
  };

  // received_qty > 0 (a real scan on the other line)
  await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 10 });
  const scanBlocked = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId: scannedItemId, actorId }));
  assert.equal(scanBlocked.status, 409);
  assert.equal(scanBlocked.message, "item_work_started");

  // picked_qty > 0
  await client.db.execute(sql`UPDATE receiving_invoice_items SET picked_qty = 1 WHERE id = ${itemId}`);
  await expectBlocked();
  await client.db.execute(sql`UPDATE receiving_invoice_items SET picked_qty = 0 WHERE id = ${itemId}`);

  // put_away_qty > 0
  await client.db.execute(sql`UPDATE receiving_invoice_items SET put_away_qty = 1 WHERE id = ${itemId}`);
  await expectBlocked();
  await client.db.execute(sql`UPDATE receiving_invoice_items SET put_away_qty = 0 WHERE id = ${itemId}`);

  // allocations reference the item
  const pickingItem = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no = 'SO-DEMO-0001' LIMIT 1`
  );
  const allocId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, receiving_invoice_item_id, qty, created_date, last_update_date)
        VALUES (${allocId}, ${pickingItem!.id}, ${itemId}, 1, now(), now())`
  );
  await expectBlocked();
  await client.db.execute(sql`DELETE FROM allocations WHERE id = ${allocId}`);

  // shelf_box_items reference the item (use a throwaway box, not a seeded one)
  await client.db.execute(
    sql`INSERT INTO shelf_boxes (id, status, created_date) VALUES ('BOX-H-TEST-0001', 'open', now())`
  );
  const sbiId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_no, qty)
        VALUES (${sbiId}, 'BOX-H-TEST-0001', ${itemId}, 'RK73H1JTTD4702F', 1)`
  );
  await expectBlocked();
  await client.db.execute(sql`DELETE FROM shelf_box_items WHERE id = ${sbiId}`);

  // all guards clear → delete succeeds
  const result = await deleteReceivingInvoiceItem(client.db, { itemId, actorId });
  assert.deepEqual(result, { id: itemId, receivingOrderId: orderId });
});
