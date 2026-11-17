// Unit tests for export/warehouse.ts — WAREHOUSE_CODE env wiring.

import assert from "node:assert/strict";
import test from "node:test";
import { exportWarehouseCode } from "./warehouse.js";

test("exportWarehouseCode defaults to hk when WAREHOUSE_CODE is unset", () => {
  const saved = process.env.WAREHOUSE_CODE;
  delete process.env.WAREHOUSE_CODE;
  try {
    assert.equal(exportWarehouseCode(), "hk");
  } finally {
    if (saved !== undefined) process.env.WAREHOUSE_CODE = saved;
  }
});

test("exportWarehouseCode lowercases the env value", () => {
  const saved = process.env.WAREHOUSE_CODE;
  process.env.WAREHOUSE_CODE = "SZ";
  try {
    assert.equal(exportWarehouseCode(), "sz");
  } finally {
    if (saved !== undefined) process.env.WAREHOUSE_CODE = saved;
    else delete process.env.WAREHOUSE_CODE;
  }
});
