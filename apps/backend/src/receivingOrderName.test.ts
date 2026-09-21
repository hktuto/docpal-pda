import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReceivingOrderName } from "./receivingOrderName.js";

// Receiving order name template rendering (spec
// 2026-09-21-receiving-order-name-template-design.md). Pure unit tests.

const FULL = {
  batchNo: "BATCH-1",
  invoiceNo: "INV-1, INV-2",
  supplierCode: "SUP",
  supplierName: "Supplier Ltd",
  deliveryDate: "2026-09-21",
  dateCode: "3626",
};

test("formatReceivingOrderName: default template renders batch_no", () => {
  assert.equal(formatReceivingOrderName(FULL, "[batch_no]"), "BATCH-1");
});

test("formatReceivingOrderName: joins placeholders with literals", () => {
  assert.equal(
    formatReceivingOrderName(FULL, "[batch_no] · [invoice_no]"),
    "BATCH-1 · INV-1, INV-2"
  );
  assert.equal(
    formatReceivingOrderName(FULL, "[supplier_code]: [supplier_name] ([date_code])"),
    "SUP: Supplier Ltd (3626)"
  );
});

test("formatReceivingOrderName: Date delivery_date renders YYYY-MM-DD", () => {
  assert.equal(
    formatReceivingOrderName({ ...FULL, deliveryDate: new Date("2026-09-21T00:00:00Z") }, "[delivery_date]"),
    "2026-09-21"
  );
});

test("formatReceivingOrderName: empty field renders empty (no dangling separator)", () => {
  assert.equal(
    formatReceivingOrderName({ batchNo: "B-1", invoiceNo: null }, "[invoice_no] [batch_no]"),
    " B-1"
  );
  assert.equal(
    formatReceivingOrderName({ batchNo: "B-1", invoiceNo: "INV-9", dateCode: null }, "[invoice_no]/[date_code]"),
    "INV-9/"
  );
});

test("formatReceivingOrderName: all-empty render falls back to batch_no", () => {
  assert.equal(formatReceivingOrderName({ batchNo: "B-1", invoiceNo: null }, "[invoice_no]"), "B-1");
});

test("formatReceivingOrderName: unknown tokens stay literal", () => {
  assert.equal(formatReceivingOrderName(FULL, "[bogus]"), "[bogus]");
});
