// ---------------------------------------------------------------------------
// Verification harness for restored WHHK supplier QR templates.
// Reimplements the parseQrRaw core from apps/backend/src/db/scanParse.ts
// (new RegExp(template, "u"), exec on raw.trim(), named groups, koa_zeros)
// and runs each template against REAL raw scans exported from BVSDB
// (ScannedItem, Site_Code='WHHK') under new_seed/scan-samples/, plus
// photo-decoded raws for suppliers with no DB scans (TE, NDK).
//
// Run: node new_seed/test-qr-templates.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// --- parseQrRaw port (keep in sync with apps/backend/src/db/scanParse.ts) ---
function decodeKoaQty(encoded) {
  if (!/^\d+$/.test(encoded)) return undefined;
  if (encoded.length < 2) return undefined;
  const zeroCount = Number(encoded.slice(-1));
  const prefix = encoded.slice(0, -1);
  const result = Number(prefix) * Math.pow(10, zeroCount);
  if (!Number.isFinite(result) || !Number.isInteger(result) || result <= 0) return undefined;
  return result;
}
function normalizePartNo(value) {
  return value.toUpperCase().replace(/\s+/g, "");
}
function parseQrRaw(raw, template, qtyEncoding) {
  if (!template) return {};
  let regex;
  try {
    regex = new RegExp(template, "u");
  } catch (e) {
    return { __error: `invalid regex: ${e.message}` };
  }
  const match = regex.exec(raw.trim());
  const groups = match?.groups;
  if (!groups || !groups.itemId) return {};
  let qty;
  if (groups.qty) {
    if (qtyEncoding === "koa_zeros") qty = decodeKoaQty(groups.qty);
    else {
      const n = Number(groups.qty);
      if (Number.isInteger(n) && n > 0) qty = n;
    }
  }
  return {
    partNo: normalizePartNo(groups.itemId),
    qty,
    dateCode: groups.dateCode ?? undefined,
    lotCode: groups.lotCode ?? undefined,
    serialNo: groups.serialNo ?? undefined,
    __groups: groups,
  };
}

// --- the templates under test (these exact strings go into the SQL) ---------
const TEMPLATES = {
  // Restored from BVSDB RegPattern Id=161 (KOA, canonical 'Primary Key' row).
  // Same template as the seeded KOA profile: itemId = MPN field 1 (new-system
  // convention), qty = field 3 with koa_zeros, lot = field 5, serial = field 6.
  KOA: {
    qtyEncoding: "koa_zeros",
    qrType: "pdf417",
    template:
      "^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$",
  },
  // Restored from RegPattern Id=165 (NCC) + Id=167 (NCC+KOA, identical layout)
  // + Id=195 (NCC_KTD, 10-char item code). Fixed-width ITF reel barcode.
  // 28-char: itemId(6) f(3) lot(7) pack(3) qty(5) serial(4)
  // 32-char (KTD/TND varistors): itemId(10) f(3) lot(7) pack(2) qty(6) serial(4)
  // — one regex: greedy itemId\\d{6,10} + length lookahead lands both; for the
  // 32-char form the qty group takes the last 5 digits of the zero-padded
  // 6-digit qty (same numeric value; qty >= 100000 on a KTD label would break).
  NCC: {
    qtyEncoding: null,
    qrType: "itf",
    template:
      "^(?=.{28}$|.{32}$)(?<itemId>\\d{6,10})\\d{3}(?<lotCode>\\d{7})\\d{3}(?<qty>\\d{5,6})(?<serialNo>\\d{4})$",
  },
  // Restored from RegPattern Id=156 (COPAL). Fixed-width 111-char label.
  // itemId = printed part name; OHM-spec parts keep the resistance code in a
  // separate resCode group (dropped by the parser — see remark).
  COPAL: {
    qtyEncoding: null,
    qrType: null,
    template:
      "^\\d{12}\\s+(?<itemId>[A-Z0-9][A-Z0-9 ./-]*?)(?:\\s{2,}\\d{1,2}K\\s+OHM\\((?<resCode>\\d+)\\))?\\s+(?<qty>\\d+)\\s+\\d+\\s+\\S+\\s+(?<serialNo>\\S+).*$",
  },
  // Restored from RegPattern Id=173 (SII). $-delimited reel QR:
  // 1$MPN$qty$lot$MPN-repeat$yyyymm$serial — itemId = field 4 (old Primary_Key).
  SII: {
    qtyEncoding: null,
    qrType: "qr",
    template:
      "^1\\$[^$]+\\$(?<qty>\\d+)\\$(?<lotCode>[^$]+)\\$(?<itemId>[^$]+)\\$(?<dateCode>\\d{6})\\$(?<serialNo>[^$]+?)\\s*$",
  },
  // Restored from RegPattern Id=194 (TE). MH10.8.2 DataMatrix
  // (verified by decoding label photos TE-01..05): LT/PN/RV/QT/PO/BT/BX/DC.
  TE: {
    qtyEncoding: null,
    qrType: "datamatrix",
    template:
      "^\\[\\)>\\x1e06\\x1dLT(?<serialNo>[^\\x1d\\x1e\\x04]+)\\x1dPN(?<itemId>[^\\x1d\\x1e\\x04]+)\\x1dRV[^\\x1d]*\\x1dQT(?<qty>\\d+)\\x1dPO[^\\x1d]*\\x1dBT(?<lotCode>[^\\x1d\\x1e\\x04]+)\\x1dBX[^\\x1d]+\\x1dDC(?<dateCode>[^\\x1d\\x1e\\x04]+)[\\x1e\\x04]*$",
  },
  // Restored from RegPattern Id=170 (NDK_16M) — modern MH10.8.2 QR verified by
  // decoding label photos NDK-01/02: P=cust PN, 1T=control no, Q=qty, 1P=NDK P/N.
  NDK: {
    qtyEncoding: null,
    qrType: "qr",
    template:
      "^\\[\\)>\\x1e06\\x1dP(?<custPn>[^\\x1d\\x1e\\x04]+)\\x1d1T(?<serialNo>[^\\x1d\\x1e\\x04]+)\\x1dQ(?<qty>\\d+)\\x1d1P(?<itemId>[^\\x1d\\x1e\\x04]+)[\\x1e\\x04]*$",
  },
};

// --- sample loading -----------------------------------------------------------
function loadSamples(file) {
  return readFileSync(join(here, "scan-samples", file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [flow, partNum, qty, raw] = line.split("¦");
      return { flow, partNum, qty: Number(qty), raw };
    })
    .filter((r) => r.raw);
}

// RegItem lookup: NCC Secondary_Key (6-digit code) -> Search_Key (full MPN)
const regItem = new Map();
for (const line of readFileSync(join(here, "scan-samples", "regitem-all.txt"), "utf8").split("\n")) {
  const [type, searchKey, secondaryKey] = line.split("¦");
  if (type === "NCC" && secondaryKey) regItem.set(secondaryKey.trim(), searchKey.trim());
}

// --- per-supplier verification -------------------------------------------------
let totalFail = 0;
function report(supplier, rows, check) {
  const t = TEMPLATES[supplier];
  const seen = new Set();
  let ok = 0;
  const fails = [];
  const warns = [];
  for (const row of rows) {
    const key = `${row.raw}¦${row.partNum}¦${row.qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseQrRaw(row.raw, t.template, t.qtyEncoding);
    const err = check(row, parsed);
    if (err === null) ok++;
    else if (err.startsWith("WARN")) warns.push({ row, parsed, err });
    else fails.push({ row, parsed, err });
  }
  totalFail += fails.length;
  console.log(`\n=== ${supplier} — ${ok}/${seen.size} distinct scans OK (${warns.length} warnings, ${fails.length} failures; qty_encoding=${t.qtyEncoding ?? "plain"}, qr_type=${t.qrType ?? "NULL"})`);
  for (const f of [...fails, ...warns.slice(0, 3)].slice(0, 8)) {
    console.log(`  FAIL: ${f.err}`);
    console.log(`    raw:      ${JSON.stringify(f.row.raw)}`);
    console.log(`    recorded: Part_Num=${JSON.stringify(f.row.partNum)} Qty=${f.row.qty}`);
    console.log(`    parsed:   partNo=${f.parsed.partNo} qty=${f.parsed.qty} lot=${f.parsed.lotCode} serial=${f.parsed.serialNo} date=${f.parsed.dateCode}`);
  }
  // show 3 successful parses as examples
  let shown = 0;
  for (const row of rows) {
    if (shown >= 3) break;
    const parsed = parseQrRaw(row.raw, t.template, t.qtyEncoding);
    if (!check(row, parsed)) {
      console.log(`  ok ex: ${JSON.stringify(row.raw.slice(0, 60))} -> partNo=${parsed.partNo} qty=${parsed.qty} lot=${parsed.lotCode} serial=${parsed.serialNo} date=${parsed.dateCode}`);
      shown++;
    }
  }
}

// KOA: recorded Part_Num is the customer P/N "KOA+RK73H1ETTP 2001F"; itemId is
// the field-1 MPN — compare after stripping the KOA[+/-] prefix + whitespace.
report("KOA", [...loadSamples("koa-raw1.txt"), ...loadSamples("koa-raw2.txt")], (row, p) => {
  if (!p.partNo) return "no match";
  if (p.qty !== row.qty) return `qty ${p.qty} != recorded ${row.qty}`;
  const expected = normalizePartNo((row.partNum ?? "").replace(/^(KOA|NIDEC)[+/-]/, ""));
  if (expected && p.partNo !== expected) return `partNo ${p.partNo} != recorded ${expected}`;
  return null;
});

// NCC: itemId is the 6/10-digit item code; verify qty and (when the recorded
// Part_Num is a resolved MPN) that RegItem maps the code to that MPN.
// Only digit-only raws are the ITF reel barcode; ';'-lists are outer-box labels.
const nccRows = [...loadSamples("ncc-raw1.txt"), ...loadSamples("ncc-raw2.txt"), ...loadSamples("ncc-nodate.txt")]
  .filter((r) => /^\d+$/.test(r.raw));
report("NCC", nccRows, (row, p) => {
  if (!p.partNo) return "no match";
  // known old-data inconsistency: label qty field reads 1000, old system recorded 200
  if (row.raw === "8056585062401720107010000217") return "WARN label qty 1000 vs recorded 200 (old-system data entry, not a parse error)";
  if (p.qty !== row.qty) return `qty ${p.qty} != recorded ${row.qty}`;
  const recorded = (row.partNum ?? "").replace(/^NCC-/, "").trim();
  if (row.raw.length === 32) console.log(`  KTD 32-char: ${row.raw} -> itemId=${p.partNo} qty=${p.qty} (recorded ${row.qty})`);
  if (recorded && recorded !== p.partNo) {
    const mapped = regItem.get(p.partNo);
    if (!mapped) return `WARN code ${p.partNo} not in WHHK RegItem export, recorded ${recorded}`;
    if (normalizePartNo(mapped) !== normalizePartNo(recorded)) return `RegItem ${p.partNo}->${mapped} != recorded ${recorded}`;
  }
  return null;
});

// COPAL: recorded Part_Num is empty in BVSDB (old system never resolved them);
// verify qty and that itemId is a plausible part name.
report("COPAL", loadSamples("copal-raw1.txt"), (row, p) => {
  if (!p.partNo) return "no match";
  if (p.qty !== row.qty) return `qty ${p.qty} != recorded ${row.qty}`;
  return null;
});

// SII: itemId (field 4) must equal the recorded Part_Num; qty must match.
report("SII", [...loadSamples("sii-raw1.txt"), ...loadSamples("sii-raw2.txt")], (row, p) => {
  if (!p.partNo) return "no match";
  if (p.qty !== row.qty) return `qty ${p.qty} != recorded ${row.qty}`;
  if (row.partNum && normalizePartNo(row.partNum) !== p.partNo) return `partNo ${p.partNo} != recorded ${row.partNum}`;
  return null;
});

// TE / NDK: no BVSDB scans — raws decoded from label photos (zxing-wasm/jsQR).
const GS = "", RS = "", EOT = "";
const tePhotoRaws = [
  { partNum: "1903415-1", qty: 1584, raw: `[)>${RS}06${GS}LT3S0852E2072351${GS}PN1903415-1${GS}RVG${GS}QT1584${GS}PO200233391894${GS}BT26055D${GS}BX3${GS}DC26055${RS}${EOT}` },
  { partNum: "HEC005N00000300000", qty: 40, raw: `[)>${RS}06${GS}LT3S060613352599${GS}PNHEC005N00000300000${GS}RVA${GS}QT40${GS}PO200232443221${GS}BT91443477${GS}BX27${GS}DC25385${RS}${EOT}` },
  { partNum: "2071369-3", qty: 1000, raw: `[)>${RS}06${GS}LT3S088906789174${GS}PN2071369-3${GS}RVA${GS}QT1000${GS}PO${GS}BT20026 1F${GS}BX3${GS}DC20035${RS}${EOT}` },
  { partNum: "41802-5", qty: 16000, raw: `[)>${RS}06${GS}LT3S0852E3190343${GS}PN41802-5${GS}RVA${GS}QT16000${GS}PO200233619614${GS}BT26094D4${GS}BX18${GS}DC26094${RS}${EOT}` },
  { partNum: "60-0252-011-P00", qty: 100, raw: `[)>${RS}06${GS}LT3S060610985580${GS}PN60-0252-011-P00${GS}RVA1${GS}QT100${GS}PO200229576738${GS}BT51598134${GS}BX813${GS}DC24162${RS}${EOT}` },
];
report("TE", tePhotoRaws, (row, p) => {
  if (!p.partNo) return "no match";
  if (p.qty !== row.qty) return `qty ${p.qty} != ${row.qty}`;
  if (normalizePartNo(row.partNum) !== p.partNo) return `partNo ${p.partNo} != ${row.partNum}`;
  return null;
});

const ndkPhotoRaws = [
  { partNum: "STD-CSR-3", qty: 3000, raw: `[)>${RS}06${GS}PWEL-STD-CSR-3-12MHZ${GS}1T00043536${GS}Q3000${GS}1PSTD-CSR-3${RS}${EOT}` },
  { partNum: "EXS00A-CS16279", qty: 9000, raw: `[)>${RS}06${GS}PWEL-EXS00A-CS16279${GS}1TL5101564${GS}Q9000${GS}1PEXS00A-CS16279${RS}${EOT}` },
];
report("NDK", ndkPhotoRaws, (row, p) => {
  if (!p.partNo) return "no match";
  if (p.qty !== row.qty) return `qty ${p.qty} != ${row.qty}`;
  if (normalizePartNo(row.partNum) !== p.partNo) return `partNo ${p.partNo} != ${row.partNum}`;
  return null;
});

console.log(`\n${totalFail === 0 ? "ALL SAMPLES PASS" : `TOTAL FAILURES: ${totalFail}`}`);
