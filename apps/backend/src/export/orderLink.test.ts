// Unit tests for the order-link QR payload (spec
// docs/superpowers/specs/2026-10-02-excel-order-barcode-scan-to-open-design.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { orderLink, orderLinkQrPng } from "./orderLink.js";

test("orderLink builds the warehouse:// payload for both kinds", () => {
  assert.equal(orderLink("receiving", "abc-123"), "warehouse://receiving/abc-123");
  assert.equal(orderLink("picking", "def-456"), "warehouse://picking/def-456");
});

test("orderLinkQrPng returns a PNG buffer", async () => {
  const buf = await orderLinkQrPng(orderLink("picking", "abc-123"));
  assert.ok(Buffer.isBuffer(buf));
  // PNG magic bytes.
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
