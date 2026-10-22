import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateCodeRank,
  dateToDateCode,
  swapDateCode,
  toCanonicalDateCode,
  toLabelDateCode,
  outdatedThresholdRank,
  outdatedThresholdRankMonths,
  isOutdatedRank,
} from "./dateCode.js";

// Canonical YYWW date codes (spec 2026-10-22-datecode-format-config-design.md).
// Pure unit tests — no database.

const REF = new Date(Date.UTC(2026, 9, 22)); // 2026-10-22, ISO week 43

test("dateCodeRank: canonical YYWW orientation (year = first pair)", () => {
  assert.equal(dateCodeRank("2637", REF), 202637);
  assert.equal(dateCodeRank("2701", REF), 202701);
  assert.equal(dateCodeRank("2652", REF), 202652);
  // wk52/2026 is chronologically BEFORE wk01/2027 — rank AND lexicographic order agree
  assert.ok(dateCodeRank("2652", REF)! < dateCodeRank("2701", REF)!);
  assert.ok("2652" < "2701");
});

test("dateCodeRank: 2-digit-year window (a YY > ref+1 is a century earlier)", () => {
  assert.equal(dateCodeRank("9637", REF), 199637);
  assert.equal(dateCodeRank("2537", REF), 202537);
  assert.equal(dateCodeRank("2737", REF), 202737); // ref+1 is not windowed
  assert.equal(dateCodeRank("2837", REF), 192837); // ref+2 windows to the past
});

test("dateCodeRank: invalid codes → null", () => {
  assert.equal(dateCodeRank(null), null);
  assert.equal(dateCodeRank(undefined), null);
  assert.equal(dateCodeRank(""), null);
  assert.equal(dateCodeRank("123"), null);
  assert.equal(dateCodeRank("12345"), null);
  assert.equal(dateCodeRank("abcd"), null);
  assert.equal(dateCodeRank("2600", REF), null); // week 00 invalid
  assert.equal(dateCodeRank("2654", REF), null); // week 54 invalid
});

test("dateToDateCode: emits canonical YYWW", () => {
  // 2026-10-22 is a Thursday of ISO week 43 of 2026
  assert.equal(dateToDateCode(new Date(Date.UTC(2026, 9, 22))), "2643");
  // year boundary: Monday 2026-12-28 is ISO week 53 of 2026
  assert.equal(dateToDateCode(new Date(Date.UTC(2026, 11, 28))), "2653");
  // Sunday 2027-01-03 still belongs to ISO week 53 of 2026
  assert.equal(dateToDateCode(new Date(Date.UTC(2027, 0, 3))), "2653");
  // Monday 2027-01-04 is ISO week 1 of 2027
  assert.equal(dateToDateCode(new Date(Date.UTC(2027, 0, 4))), "2701");
});

test("swapDateCode: WWYY↔YYWW pair swap, guarded", () => {
  assert.equal(swapDateCode("3726"), "2637");
  assert.equal(swapDateCode("2637"), "3726");
  assert.equal(swapDateCode("2652"), "5226");
  // swap is an involution
  assert.equal(swapDateCode(swapDateCode("3726")), "3726");
});

test("swapDateCode: non-4-digit input passes through unchanged, null-safe", () => {
  assert.equal(swapDateCode("123"), "123");
  assert.equal(swapDateCode("12345"), "12345");
  assert.equal(swapDateCode("abcd"), "abcd");
  assert.equal(swapDateCode(""), "");
  assert.equal(swapDateCode(null), null);
  assert.equal(swapDateCode(undefined), null);
});

test("toCanonicalDateCode: wwyy swaps, yyww is identity", () => {
  assert.equal(toCanonicalDateCode("3726", "wwyy"), "2637");
  assert.equal(toCanonicalDateCode("2637", "yyww"), "2637");
  assert.equal(toCanonicalDateCode("123", "wwyy"), "123");
  assert.equal(toCanonicalDateCode(null, "wwyy"), null);
  assert.equal(toCanonicalDateCode(null, "yyww"), null);
});

test("toLabelDateCode: inverse of toCanonicalDateCode", () => {
  assert.equal(toLabelDateCode("2637", "wwyy"), "3726");
  assert.equal(toLabelDateCode("2637", "yyww"), "2637");
  // round-trip both ways
  for (const fmt of ["wwyy", "yyww"] as const) {
    assert.equal(toLabelDateCode(toCanonicalDateCode("3726", fmt), fmt), "3726");
    assert.equal(toCanonicalDateCode(toLabelDateCode("2637", fmt), fmt), "2637");
  }
});

test("outdated thresholds rank below recent codes", () => {
  const threshold = outdatedThresholdRank(2, REF)!;
  assert.ok(dateCodeRank("2643", REF)! > threshold);
  // 2 years before 2026-10 → ~2024-10 (week ~43): "2443" is the boundary area
  const thresholdMonths = outdatedThresholdRankMonths(12, REF)!;
  assert.ok(dateCodeRank("2544", REF)! > thresholdMonths);
  assert.ok(isOutdatedRank(dateCodeRank("2440", REF), threshold));
  assert.ok(!isOutdatedRank(null, threshold));
});
