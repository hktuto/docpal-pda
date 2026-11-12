// periodStartFor boundary math (plan
// docs/superpowers/plans/2026-11-12-seq-counters.md) — pure function, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { periodStartFor } from "./sequences.js";

// 2026-11-09 is a Monday, 2026-11-12 a Thursday.

test("weekly: most recent occurrence of the weekday, today included", () => {
  assert.equal(periodStartFor("weekly", 1, new Date(2026, 10, 11), null), "2026-11-09"); // Wed → Mon
  assert.equal(periodStartFor("weekly", 1, new Date(2026, 10, 9), null), "2026-11-09"); // Mon → same day
  assert.equal(periodStartFor("weekly", 1, new Date(2026, 10, 8), null), "2026-11-02"); // Sun → previous Mon
  assert.equal(periodStartFor("weekly", 7, new Date(2026, 10, 12), null), "2026-11-08"); // Thu → previous Sun
  assert.equal(periodStartFor("weekly", 7, new Date(2026, 10, 8), null), "2026-11-08"); // Sun → same day
});

test("monthly: this month's day, or last month's when it hasn't arrived", () => {
  assert.equal(periodStartFor("monthly", 15, new Date(2026, 10, 12), null), "2026-10-15");
  assert.equal(periodStartFor("monthly", 15, new Date(2026, 10, 15), null), "2026-11-15");
  assert.equal(periodStartFor("monthly", 1, new Date(2026, 0, 10), null), "2026-01-01");
  assert.equal(periodStartFor("monthly", 15, new Date(2026, 0, 10), null), "2025-12-15"); // year rollover
});

test("days: every N days anchored at last_reset_on; null without an anchor", () => {
  assert.equal(periodStartFor("days", 3, new Date(2026, 10, 12), "2026-11-01"), "2026-11-10"); // elapsed 11 → k=3
  assert.equal(periodStartFor("days", 3, new Date(2026, 10, 3), "2026-11-01"), "2026-11-01"); // elapsed 2 < 3
  assert.equal(periodStartFor("days", 3, new Date(2026, 10, 4), "2026-11-01"), "2026-11-04"); // exact multiple
  assert.equal(periodStartFor("days", 3, new Date(2026, 10, 12), null), null);
});

test("never and misconfigured rows never reset", () => {
  assert.equal(periodStartFor("never", null, new Date(2026, 10, 12), null), null);
  assert.equal(periodStartFor("weekly", 8, new Date(2026, 10, 12), null), null); // interval out of range
  assert.equal(periodStartFor("monthly", 29, new Date(2026, 10, 12), null), null);
  assert.equal(periodStartFor("days", 0, new Date(2026, 10, 12), "2026-11-01"), null);
});
