// Pure template-loop tests ported from apps/pda/utils/parseOcrScan.test.ts
// (parseQrCapture block) at the 2026-11-03 PDA cutover — the loop, priority
// ordering, targets gate and per-supplier decodings are now covered here,
// in-process against decodeWithTemplates (no DB, no HTTP). The heuristic
// fallback those cases ended in now lives in the PDA (utils/labelDecode.ts,
// tested there); codec-level decoding (decodeKoaDateCode et al.) is covered
// by src/db/receiving.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KOA_PERIODS } from "./codecs.js";
import { decodeWithTemplates, type ScanDecodeInput } from "./template.js";
import type { ScanTemplateRow } from "../db/scantemplates.js";

function row(p: Partial<ScanTemplateRow> & { supplierCode: string; qrTemplate: string }): ScanTemplateRow {
  return {
    qtyEncoding: null,
    dateCodeEncoding: null,
    barcodeTypes: null,
    brands: null,
    ...p,
  };
}

function decode(input: ScanDecodeInput, templates: ScanTemplateRow[], dateCodeFormat: "wwyy" | "yyww" = "wwyy") {
  return decodeWithTemplates(input, templates, DEFAULT_KOA_PERIODS, dateCodeFormat);
}

const koaTemplate = row({
  supplierCode: "KOA",
  qrTemplate: "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$",
  qtyEncoding: "koa_zeros",
});

test("parses KOA QR payload and expands qty", () => {
  const result = decode(
    { raw: ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", targets: ["RK73H2ATTD2403F"] },
    [koaTemplate]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "RK73H2ATTD2403F");
  assert.equal(result.parsed.qty, 25000);
  assert.equal(result.parsed.lotCode, "63048349");
  assert.equal(result.supplier?.code, "KOA");
});

test("emits decoded KOA date codes in the configured label format", () => {
  const koaCounter = { ...koaTemplate, dateCodeEncoding: "koa_month_counter" };
  const raw = ":RK73H1ETTP4752F::253:M:1907H686:S601:KOA*RK73H1ETTP 4752F";
  // counter 19 → 2026-09, day 07 → ISO week 37 (stable until the next
  // counter-rotation period row is inserted — same fixture as the PDA copy)
  assert.equal(decode({ raw }, [koaCounter], "wwyy").parsed.dateCode, "3726");
  assert.equal(decode({ raw }, [koaCounter], "yyww").parsed.dateCode, "2637");
});

test("returns no match when the QR value fits no template", () => {
  const result = decode({ raw: "SOME-RANDOM-STRING", targets: ["RK73H2ATTD2403F"] }, [koaTemplate]);
  assert.equal(result.matched, false);
  assert.equal(result.parsed.itemId, null);
});

test("captures the WCL item no from the template's wclItemNo group", () => {
  const koaWcl = row({
    supplierCode: "32",
    qrTemplate:
      "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$",
    qtyEncoding: "koa_zeros",
    dateCodeEncoding: "koa_month_counter",
    brands: ["KOA"],
  });
  const result = decode(
    { raw: ":SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01" },
    [koaWcl]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "SR732ERTTDR200F");
  assert.equal(result.parsed.qty, 15000);
  assert.equal(result.parsed.dateCode, "3726");
  assert.equal(result.parsed.lotCode, "19077387");
  assert.equal(result.parsed.wclItemNo, "KOA/SR732ERTTDR200F");
});

test("matches a WCL-keyed target via the template group (2026-11-03 house rule)", () => {
  const koaWcl = row({
    supplierCode: "32",
    qrTemplate:
      "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$",
    qtyEncoding: "koa_zeros",
    dateCodeEncoding: "koa_month_counter",
    brands: ["KOA"],
  });
  // targets carry only the WCL item no (picking allocation pinned via wcl) —
  // the bare supplier PN is NOT among them.
  const result = decode(
    { raw: ":SR732ERTTDR200F::153:K:19077387:S002:KOA/SR732ERTTDR200F:13FSJ564:01", targets: ["KOA/SR732ERTTDR200F"] },
    [koaWcl]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "SR732ERTTDR200F");
});

test("parses COPAL new-layout reels (lowercase ohm, 3-digit K, spec token) and appends resCode to the itemId", () => {
  const copal = row({
    supplierCode: "19915",
    qrTemplate: String.raw`^\d{12}\s+(?<itemId>[A-Z0-9][A-Z0-9 ./()-]*?)(?:\s{2,}\d{1,2})?(?:\s{2,}\d+K\s+[Oo][Hh][Mm]\((?<resCode>\d+)\))?\s+(?<qty>\d+)\s+\d+\s+\S+\s+(?<serialNo>(?<lotCode>\d{5})?\S*).*$`,
    dateCodeEncoding: "ymmdd",
    brands: ["COPAL", "NIDEC"],
  });
  // Switch label (no OHM spec): the "03" spec token must not become the qty;
  // the serial's 5-digit YMMDD prefix is the lot/date code.
  const sw = decode(
    { raw: "254442210031                CFS-0402MC           03                    240   240   C6Y      6101300000 AA        C", targets: ["CFS-0402MC"] },
    [copal]
  );
  assert.equal(sw.matched, true);
  assert.equal(sw.parsed.itemId, "CFS-0402MC");
  assert.equal(sw.parsed.qty, 240);
  assert.equal(sw.parsed.lotCode, "61013");
  assert.equal(sw.parsed.dateCode, "4226"); // 61013 = 2026-10-13 → ISO week 42
  // Trimmer labels: resCode is appended because parts.part_no stores the
  // resistance code ("SM-3TW 104" / "FT-63ES 202").
  const sm3 = decode(
    { raw: "206440005101                SM-3 TW        01   100K ohm(104)       1000  1000  C6H      6081500000 AA        C", targets: ["SM-3TW 104"] },
    [copal]
  );
  assert.equal(sm3.matched, true);
  assert.equal(sm3.parsed.itemId, "SM-3TW104");
  assert.equal(sm3.parsed.qty, 1000);
  assert.equal(sm3.parsed.dateCode, "3326"); // 60815 = 2026-08-15 → ISO week 33
  const ft63 = decode(
    { raw: "202821003211                FT-63 ES      10    2K   ohm(202)        1000  2142  C6J      609090084RR8J05741448C", targets: ["FT-63ES 202"] },
    [copal]
  );
  assert.equal(ft63.matched, true);
  assert.equal(ft63.parsed.itemId, "FT-63ES202");
  assert.equal(ft63.parsed.dateCode, "3726"); // 60909 = 2026-09-09 → ISO week 37
  // BUG-040 (2026-11-06): models printed with parentheses — the itemId class
  // must accept ( ) so "CHS-04TB(34)" matches the parts master. The two-space
  // runs are significant (fixed-width label fields).
  const parens = decode(
    { raw: "236301041541  CHS-04TB(34)  1000  1284  C6J  609080257MMJ805744571C", targets: ["CHS-04TB(34)"] },
    [copal]
  );
  assert.equal(parens.matched, true);
  assert.equal(parens.parsed.itemId, "CHS-04TB(34)");
  assert.equal(parens.parsed.qty, 1000);
  assert.equal(parens.parsed.dateCode, "3726"); // 60908 = 2026-09-08 → ISO week 37
});

test("derives the WCL item no from a single-brand profile when the template has no wclItemNo group (ABLIC $ reel)", () => {
  const ablic = row({
    supplierCode: "84915",
    qrTemplate: String.raw`^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$`,
    dateCodeEncoding: "yyyymm_midmonth",
    brands: ["ABLIC"],
  });
  const result = decode(
    { raw: "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007          " },
    [ablic]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "S-812C33AMC-C2NT2U");
  assert.equal(result.parsed.qty, 3000);
  assert.equal(result.parsed.lotCode, "VM5F6XA0033-0308");
  assert.equal(result.parsed.dateCode, "2526"); // 2026-06-15 → ISO week 25
  assert.equal(result.parsed.serialNo, "66VM1953007");
  assert.equal(result.parsed.wclItemNo, "ABLIC/S-812C33AMC-C2NT2U");
});

test("does not derive a WCL item no for multi-brand or brand-less profiles", () => {
  const template = String.raw`^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$`;
  const raw = "1$S-812C33AMC-C2NT2U$3000$VM5F6XA0033-0308$S-812C33AMC-C2NT2U$202606$66VM1953007";
  const make = (brands?: string[] | null) => row({ supplierCode: "X", qrTemplate: template, brands });
  assert.equal(decode({ raw }, [make(null)]).parsed.wclItemNo, undefined);
  assert.equal(decode({ raw }, [make(["COPAL", "NIDEC"])]).parsed.wclItemNo, undefined);
});

test("matches KOA label with empty lotCode segment", () => {
  const koaWcl = row({
    supplierCode: "32",
    qrTemplate:
      "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]*):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$",
    qtyEncoding: "koa_zeros",
    dateCodeEncoding: "koa_month_counter",
    brands: ["KOA"],
  });
  const result = decode({ raw: ":RK73H1ETTP1001F::54:X::S606:KOA+RK73H1ETTP 1001F" }, [koaWcl]);
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "RK73H1ETTP1001F");
  assert.equal(result.parsed.qty, 50000); // "54" → 5 × 10^4
  assert.equal(result.parsed.lotCode, undefined);
  assert.equal(result.parsed.dateCode, undefined);
  assert.equal(result.parsed.serialNo, "S606");
  assert.equal(result.parsed.wclItemNo, "KOA+RK73H1ETTP 1001F");
});

test("parses the NCC drawing, full lot, and YMMDD date code without backtracking", () => {
  const ncc = row({
    supplierCode: "23",
    qrTemplate: "^(?=.{28}$|.{32}$)(?<itemId>\\d{6}(?=.{22}$)|\\d{10}(?=.{22}$))(?:(?<=^.{10})\\d{3})?(?<lotCode>\\d{13}(?=.{9}$)|\\d{7}(?=.{12}$))(?:\\d{2}(?=.{10}$))?(?<qty>\\d{5,6})(?<serialNo>\\d{4})$",
    dateCodeEncoding: "ncc_lot_ymmdd",
    brands: ["NCC"],
  });
  const raw = "5928846030912801026002000460";
  const result = decode({ raw, brands: ["NCC"] }, [ncc], "yyww");
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "592884");
  assert.equal(result.parsed.qty, 200);
  assert.equal(result.parsed.lotCode, "60309-0128010-26");
  assert.equal(result.parsed.dateCode, "2611"); // 2026-03-09 → ISO week 11
  assert.equal(result.parsed.serialNo, "0460");
  assert.equal(decode({ raw }, [ncc], "wwyy").parsed.dateCode, "1126");
});

test("parses an iC-Haus JSON Versandetikett QR (key-order independent)", () => {
  const ichaus = row({
    supplierCode: "20",
    qrTemplate:
      '^\\{(?=.*"CANR"\\s*:\\s*"(?<wclItemNo>[^"]+)")(?=.*"IANR"\\s*:\\s*"(?<itemId>[^"]+)")(?=.*"Q"\\s*:\\s*"(?<qty>\\d+)")(?=.*"DC"\\s*:\\s*"(?<dateCode>\\d{4})")(?=.*"COO"\\s*:\\s*"(?<coo>[^"]+)")(?=.*"LTS"\\s*:\\s*"(?<serialNo>[^"]+)")(?=.*"AC"\\s*:\\s*"(?<lotCode>[^"]+)").*\\}$',
    dateCodeEncoding: "yyww",
    brands: ["ICHAUS"],
  });
  const result = decode(
    { raw: '{"type":"Versandetikett","version":"1","AC":"IRZ4248_6","VI":"<keine>","DC":"2337","Q":"10","ID":"50788","VID":"1","C":"WELTM","CANR":"ICHAUS/IC-RZ4248 OQFN38-7X5","IANR":"iC-RZ4248 oQFN38-7x5","CONR":"339084940.3","COO":"DE","LTS":"20260929-4"}' },
    [ichaus]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "IC-RZ4248OQFN38-7X5");
  assert.equal(result.parsed.qty, 10);
  assert.equal(result.parsed.dateCode, "3723"); // DC "2337" YYWW → WWYY
  assert.equal(result.parsed.coo, "DE");
  assert.equal(result.parsed.wclItemNo, "ICHAUS/IC-RZ4248 OQFN38-7X5");
  assert.equal(result.parsed.serialNo, "20260929-4");
  assert.equal(result.parsed.lotCode, "IRZ4248_6");
});

test("parses a TE datamatrix with yywwd encoding (5-digit DC, day dropped)", () => {
  const te = row({
    supplierCode: "15915",
    qrTemplate:
      "^\\[\\)>[\\x1d\\x1e\\xA0]?06[\\x1d\\xA0]LT(?<serialNo>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]PN(?<itemId>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]RV[^\\x1d\\xA0]*[\\x1d\\xA0]QT(?<qty>\\d+)[\\x1d\\xA0]PO[^\\x1d\\xA0]*[\\x1d\\xA0]BT(?<lotCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1d\\xA0]BX[^\\x1d\\xA0]+[\\x1d\\xA0]DC(?<dateCode>[^\\x1d\\xA0\\x1e\\x04]+)[\\x1e\\x04]*$",
    dateCodeEncoding: "yywwd",
    brands: ["TE"],
  });
  const raw = "[)>\x1e06\x1dLT3S550200578934\x1dPN1376348-1\x1dRVF\x1dQT5000\x1dPO200234935045\x1dBT26374N\x1dBX1\x1dDC26374\x1e\x04";
  const result = decode({ raw, brands: ["TE"] }, [te]);
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "1376348-1");
  assert.equal(result.parsed.qty, 5000);
  assert.equal(result.parsed.dateCode, "3726"); // "26374" → wk 37/2026 WWYY
  assert.equal(result.parsed.lotCode, "26374N");
  assert.equal(result.parsed.serialNo, "3S550200578934");
  assert.equal(decode({ raw, brands: ["TE"] }, [te], "yyww").parsed.dateCode, "2637");
});

test("prefers brand-matching templates when brands context is given", () => {
  const generic = row({ supplierCode: "GENERIC", qrTemplate: "^(?<itemId>.+)$" });
  const brand = row({ supplierCode: "32", qrTemplate: "^ID:(?<itemId>[A-Z0-9]+)$", brands: ["KOA"] });
  // generic is listed first and would win without brand context
  assert.equal(decode({ raw: "ID:RK73B1JTTD181G" }, [generic, brand]).parsed.itemId, "ID:RK73B1JTTD181G");
  assert.equal(decode({ raw: "ID:RK73B1JTTD181G", brands: ["KOA"] }, [generic, brand]).parsed.itemId, "RK73B1JTTD181G");
});

test("prefers the context supplier's template when templates overlap", () => {
  const generic = row({ supplierCode: "GENERIC", qrTemplate: "^(?<itemId>.+)$" });
  const specific = row({ supplierCode: "SPECIFIC", qrTemplate: "^ID:(?<itemId>[A-Z0-9]+)$" });
  const targets = ["ID:RK73B1JTTD181G", "RK73B1JTTD181G"];
  assert.equal(decode({ raw: "ID:RK73B1JTTD181G", targets }, [generic, specific]).parsed.itemId, "ID:RK73B1JTTD181G");
  assert.equal(decode({ raw: "ID:RK73B1JTTD181G", targets, supplierCode: "SPECIFIC" }, [generic, specific]).parsed.itemId, "RK73B1JTTD181G");
});

test("does not throw on an invalid regex template and continues to the next", () => {
  const invalid = row({ supplierCode: "INVALID", qrTemplate: "(?<itemId>[" });
  const result = decode(
    { raw: ":RK73B1JTTD181G::253:M:63048349:S613:X", targets: ["RK73B1JTTD181G"] },
    [invalid, koaTemplate]
  );
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "RK73B1JTTD181G");
});

test("returns matched=false when the parsed part is not in targets", () => {
  const result = decode(
    { raw: ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", targets: ["OTHER-PART"] },
    [koaTemplate]
  );
  assert.equal(result.matched, false);
});

test("matches any parsed itemId when no targets are provided", () => {
  const result = decode({ raw: ":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F" }, [koaTemplate]);
  assert.equal(result.matched, true);
  assert.equal(result.parsed.itemId, "RK73H2ATTD2403F");
  assert.equal(result.parsed.qty, 25000);
});
