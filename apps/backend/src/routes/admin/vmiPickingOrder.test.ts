// Route-level tests for POST /admin/picking-orders/vmi-create (spec
// 2026-11-09-vmi-picking-excel-upload-design.md): batch-create one picking
// order per VMI Ref.No — type 'vmi', pending/unallocated, PO Line →
// line_number, Customer Item → additional_data, batch duplicate-order_no 409,
// invalid org+sub-inventory pair 400. Same auth/fixture pattern as
// pickingStatusOverride.test.ts.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await login.json()).token as string;
});

beforeEach(async () => {
  await reseed(client);
});

function create(orders: unknown[]) {
  return app.request("/admin/picking-orders/vmi-create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ orders }),
  });
}

const vmiOrder = (orderNo: string, extra: Record<string, unknown> = {}) => ({
  orderNo,
  customerCode: "SZ-HUAWEI-02",
  orgId: 2,
  subInventoryCode: "STORE1",
  shipTo: "Huawei Technologies Co.,Ltd.",
  poNo: "VHWH00022045",
  items: [
    { partNo: "VMI-TEST-PART", qty: 2000, lineNumber: 1, customerItem: "07092612" },
    { partNo: "VMI-TEST-PART", qty: 4000, lineNumber: 2 },
  ],
  ...extra,
});

test("creates one order per VMI group with type vmi and item passthrough", async () => {
  const res = await create([vmiOrder("VMI-58051"), vmiOrder("VMI-58052")]);
  assert.equal(res.status, 200);
  const body = await res.json<{ created: { id: string; orderNo: string }[] }>();
  assert.deepEqual(body.created.map((o) => o.orderNo), ["VMI-58051", "VMI-58052"]);

  const row = await queryGet<{ type: string; status: string; alloc: string }>(
    client.db,
    sql`SELECT picking_order_type AS type, status, allocation_status AS alloc FROM picking_orders WHERE order_no = 'VMI-58051'`
  );
  assert.equal(row!.type, "vmi");
  assert.equal(row!.status, "pending");

  const items = await queryAll<{ line: number | null; qty: number; extra: { customerItem?: string } | null }>(
    client.db,
    sql`SELECT pi.line_number AS line, pi.qty, pi.additional_data AS extra
        FROM picking_items pi JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no = 'VMI-58051' ORDER BY pi.line_number`
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]!.line, 1);
  assert.equal(items[0]!.qty, 2000);
  assert.equal(items[0]!.extra?.customerItem, "07092612");
  assert.equal(items[1]!.extra, null);
});

test("rejects a batch whose refs already exist (409) without creating anything", async () => {
  const first = await create([vmiOrder("VMI-58051")]);
  assert.equal(first.status, 200);

  const dup = await create([vmiOrder("VMI-58053"), vmiOrder("VMI-58051")]);
  assert.equal(dup.status, 409);
  const n = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM picking_orders WHERE order_no = 'VMI-58053'`
  );
  assert.equal(n!.n, 0);
});

test("rejects an invalid org + sub-inventory pair (400)", async () => {
  const res = await create([vmiOrder("VMI-58054", { orgId: 999 })]);
  assert.equal(res.status, 400);
});

test("validates shape: empty items and bad qty (400)", async () => {
  assert.equal((await create([vmiOrder("VMI-58055", { items: [] })])).status, 400);
  assert.equal(
    (await create([vmiOrder("VMI-58056", { items: [{ partNo: "P", qty: 0 }] })])).status,
    400
  );
});
