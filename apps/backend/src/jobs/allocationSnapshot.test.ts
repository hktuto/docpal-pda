import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAllocationRun } from "./allocationSnapshot.js";

test("allocation recovery schedule uses explicit UTC offsets", () => {
  const beforeSnapshot = new Date("2026-10-26T09:00:00Z");
  assert.equal(nextAllocationRun(beforeSnapshot, "17:45:00+0800").toISOString(), "2026-10-26T09:45:00.000Z");
  assert.equal(nextAllocationRun(new Date("2026-10-26T10:00:00Z"), "17:45:00+0800").toISOString(), "2026-10-27T09:45:00.000Z");
  assert.equal(nextAllocationRun(new Date("2026-10-26T09:45:00Z"), "17:45:00+0800").toISOString(), "2026-10-27T09:45:00.000Z");
  assert.equal(nextAllocationRun(new Date("2026-10-25T23:30:00Z"), "08:00:00+0800").toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(nextAllocationRun(new Date("2026-10-26T00:01:00Z"), "08:00:00+0800").toISOString(), "2026-10-27T00:00:00.000Z");
  assert.equal(nextAllocationRun(new Date("2026-10-26T12:00:00Z"), "08:30:15-0530").toISOString(), "2026-10-26T14:00:15.000Z");
  assert.throws(() => nextAllocationRun(beforeSnapshot, "17:45"), /Invalid allocation schedule/);
});
