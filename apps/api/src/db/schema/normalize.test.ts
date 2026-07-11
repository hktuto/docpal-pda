import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCode, normalizePlain, normalizePartNo } from "./normalize.js";

test("normalizeCode collapses whitespace and uppercases", () => {
  assert.equal(normalizeCode("  ab  cd "), "AB CD");
});

test("normalizeCode maps OCR confusables (O→0 I→1 L→1 Z→2 S→5)", () => {
  assert.equal(normalizeCode("OILZS oilzs"), "01125 01125");
});

test("normalizePlain uppercases without mapping confusables", () => {
  assert.equal(normalizePlain("zo"), "ZO");
  assert.equal(normalizePlain("coo us"), "COO US");
});

test("normalizePartNo maps confusables", () => {
  assert.equal(normalizePartNo("PART-OIL"), "PART-011");
});

test("null/undefined pass through as null", () => {
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizePlain(undefined), null);
  assert.equal(normalizePartNo(null), null);
});
