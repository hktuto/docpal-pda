// Pure round-trip test for the dev-lab builders: every builder's output must
// parse back through the REAL decoder (decode/codecs.ts parseQrRaw) against
// its seeded template into the fields we put in. No DB needed.

import test from "node:test";
import assert from "node:assert/strict";

import { builtinSupplierProfiles } from "../db/seed-supplier-profiles.js";
import { parseQrRaw, DEFAULT_KOA_PERIODS } from "../decode/codecs.js";
import { dateToDateCode, toLabelDateCode } from "../db/dateCode.js";
import { buildLabLabelRaw } from "./labelBuilders.js";

const profiles = new Map(builtinSupplierProfiles.map((p) => [p.supplierCode, p]));
const ctx = { dateCodePeriods: DEFAULT_KOA_PERIODS };

// Date in the recent past — NCC/COPAL 1-digit years resolve to the latest
// matching year <= now, so future dates would decode to a year behind.
const DATE = "2026-10-15";
const labelDate = toLabelDateCode(dateToDateCode(new Date(`${DATE}T00:00:00`)), "wwyy")!;

function decode(supplierCode: string, raw: string) {
  const p = profiles.get(supplierCode)!;
  return parseQrRaw(
    raw,
    p.qrTemplate,
    p.qtyEncoding,
    p.dateCodeEncoding,
    DEFAULT_KOA_PERIODS,
    "wwyy",
    p.brands
  );
}

test("KOA round-trip: part, koa_zeros qty, month-counter date, wcl item, serial", () => {
  const raw = buildLabLabelRaw(
    "32",
    { partNo: "RK73H1ETTP1001F", qty: 25000, date: DATE, serialNo: "S606", wclItemNo: "KOA/RK73H1ETTP 1001F" },
    ctx
  );
  const d = decode("32", raw);
  assert.equal(d.partNo, "RK73H1ETTP1001F");
  assert.equal(d.qty, 25000);
  assert.equal(d.dateCode, labelDate);
  assert.equal(d.serialNo, "S606");
  assert.equal(d.wclItemNo, "KOA/RK73H1ETTP 1001F");
});

test("NCC 28-char round-trip: drawing code, qty, YMMDD lot date", () => {
  const raw = buildLabLabelRaw("23", { partNo: "612345", qty: 5000, date: DATE, serialNo: "0002" }, ctx);
  assert.match(raw, /^\d{28}$/);
  const d = decode("23", raw);
  assert.equal(d.partNo, "612345");
  assert.equal(d.qty, 5000);
  assert.equal(d.dateCode, labelDate);
  assert.equal(d.serialNo, "0002");
});

test("NCC 32-char round-trip (10-digit drawing code)", () => {
  const raw = buildLabLabelRaw("23", { partNo: "6123456789", qty: 120000, date: DATE }, ctx);
  assert.match(raw, /^\d{32}$/);
  const d = decode("23", raw);
  assert.equal(d.partNo, "6123456789");
  assert.equal(d.qty, 120000);
  // no dateCode: decodeNccDateCode needs the 13-digit lot — the 32-char
  // KTD layout's 7-digit lot carries no decodable date (real-label behavior).
  assert.equal(d.dateCode, undefined);
});

test("NCC rejects a non-6/10-digit drawing code", () => {
  assert.throws(
    () => buildLabLabelRaw("23", { partNo: "12345", date: DATE }, ctx),
    /drawing code/
  );
});

test("COPAL round-trip: model + qty + YMMDD-led serial", () => {
  const raw = buildLabLabelRaw("19915", { partNo: "CJS-1200TB1", qty: 2000, date: DATE, serialNo: "AB12" }, ctx);
  const d = decode("19915", raw);
  assert.equal(d.partNo, "CJS-1200TB1");
  assert.equal(d.qty, 2000);
  assert.equal(d.dateCode, labelDate);
  assert.equal(d.serialNo, "61015AB12"); // YMMDD prefix (2026-10-15) + serial
});

test("SII round-trip: $-reel fields + single-brand wcl derivation", () => {
  const raw = buildLabLabelRaw("70915", { partNo: "S-5743NBH1A-M3T4U", qty: 3000, date: DATE, lotCode: "VM3F6XA1761", serialNo: "67352039027" }, ctx);
  const d = decode("70915", raw);
  assert.equal(d.partNo, "S-5743NBH1A-M3T4U");
  assert.equal(d.qty, 3000);
  assert.equal(d.lotCode, "VM3F6XA1761");
  assert.equal(d.serialNo, "67352039027");
  assert.equal(d.wclItemNo, "SII/S-5743NBH1A-M3T4U");
  // mid-month anchor: "202610" is decoded as 2026-10-15 — same label date
  // code the input date maps to (test date is the 15th on purpose).
  assert.equal(d.dateCode, labelDate);
});

test("TE round-trip: GS-separated MH10.8.2 markers, YYWWD date", () => {
  const raw = buildLabLabelRaw("15915", { partNo: "5172070-1", qty: 1584, date: DATE, lotCode: "3SILJP00C4QSKH", serialNo: "LT0001" }, ctx);
  const d = decode("15915", raw);
  assert.equal(d.partNo, "5172070-1");
  assert.equal(d.qty, 1584);
  assert.equal(d.lotCode, "3SILJP00C4QSKH");
  assert.equal(d.serialNo, "LT0001");
  assert.equal(d.dateCode, labelDate);
});

test("NDK round-trip: PW/1T/Q/1P markers", () => {
  const raw = buildLabLabelRaw("69915", { partNo: "EL-EXS00A-CS16279", qty: 9000, serialNo: "5101564" }, ctx);
  const d = decode("69915", raw);
  assert.equal(d.partNo, "EL-EXS00A-CS16279");
  assert.equal(d.qty, 9000);
  assert.equal(d.serialNo, "5101564");
});

test("iC-Haus round-trip: JSON Versandetikett incl. COO", () => {
  const raw = buildLabLabelRaw("20", { partNo: "iC-RZ4248 oQFN38-7x5", qty: 10, date: DATE, lotCode: "IRZ4248_6", coo: "DE", serialNo: "LTS-1" }, ctx);
  const d = decode("20", raw);
  assert.equal(d.partNo, "IC-RZ4248OQFN38-7X5");
  assert.equal(d.qty, 10);
  assert.equal(d.dateCode, labelDate);
  assert.equal(d.coo, "DE");
  assert.equal(d.lotCode, "IRZ4248_6");
  assert.equal(d.serialNo, "LTS-1");
  assert.equal(d.wclItemNo, "ICHAUS/iC-RZ4248 oQFN38-7x5");
});

test("unknown supplier code is rejected with the raw-text hint", () => {
  assert.throws(() => buildLabLabelRaw("999", { partNo: "X" }, ctx), /raw-text mode/);
});
