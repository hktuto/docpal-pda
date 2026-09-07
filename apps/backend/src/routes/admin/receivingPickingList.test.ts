// Route-level tests for GET /admin/receiving-orders/:id/picking-list (spec
// 2026-09-07-admin-receiving-picking-list-design.md): shipper-style xlsx —
// part groups, one column per picking order, order-level (no ctn) rows,
// Total/Balance. Dynamic app import so DATABASE_URL points at the test DB
// first (same pattern as src/routes/admin-flow-config.test.ts).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryGet } from "../../db/query.js";
import { confirmReceivingArrival } from "../../db/receiving.js";
import { upsertReceivingOrder, upsertPickingOrder } from "../../db/ingest.js";
import { allocateAll } from "../../db/allocate.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await res.json()).token;
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

/** Sheet rows as a plain array-of-arrays (blank cells → ""). */
function sheetRows(buf: ArrayBuffer): (string | number)[][] {
  const wb = XLSX.read(Buffer.from(buf));
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

// Scenario: RK73H2ATTD1372F arrives in two cartons (item-level allocation), RK73H1JTTD3302F
// without a carton (whole-order allocation). Two picking orders draw on them:
//   SO-PL-001 (ACME): RK73H2ATTD1372F ×1500, RK73H1JTTD3302F ×200
//   SO-PL-002:        RK73H2ATTD1372F ×1000
async function seedScenario(): Promise<string> {
  // Keep the scenario hermetic: the demo seed's picking orders would also
  // draw on this stock (allocate.ts FIFO spans every open demand).
  await client.db.execute(sql`DELETE FROM picking_orders`);
  await upsertReceivingOrder(client.db, "PL-TEST-01", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-07" },
    invoices: [
      {
        invoiceNo: "INV-PL-01",
        totalCtn: 2,
        items: [
          { partNo: "RK73H2ATTD1372F", poNo: "PO-1", poLine: "1", lineQty: 1000, ctnNo: "7001", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "RK73H2ATTD1372F", poNo: "PO-2", poLine: "1", lineQty: 2000, ctnNo: "7002", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "RK73H1JTTD3302F", poNo: "PO-3", poLine: "1", lineQty: 500, orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const orderId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = 'PL-TEST-01'`)
  )!.id;
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, orderId, actorId);

  await upsertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-001", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [
      { partNo: "RK73H2ATTD1372F", qty: 1500 },
      { partNo: "RK73H1JTTD3302F", qty: 200 },
    ],
  });
  await upsertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-002", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "RK73H2ATTD1372F", qty: 1000 }],
  });
  await allocateAll(client.db);
  return orderId;
}

test("GET picking-list: 404 for an unknown receiving order", async () => {
  await reseed(client);
  const res = await req(`/admin/receiving-orders/${randomUUID()}/picking-list`);
  assert.equal(res.status, 404);
});

test("GET picking-list: shipper 3-row blocks with per-row order slots and balance", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const res = await req(`/admin/receiving-orders/${orderId}/picking-list`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.match(res.headers.get("Content-Disposition") ?? "", /picking-list-PL-TEST-01\.xlsx/);

  const rows = await sheetRows(await res.arrayBuffer());

  // Title block
  assert.match(String(rows[0]![0]), /^Picking List — PL-TEST-01 \(DAITO\)/);
  assert.equal(rows[1]![0], "Date: 2026-09-07");
  assert.equal(rows[2]![0], "Total Ctn: 2");

  // Generic slot headers (the widest row has 2 allocations): the actual
  // customer / order_no values ride on each item's own 3-row block.
  assert.deepEqual(rows[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Customer", "Balance"]);
  assert.deepEqual(rows[5], ["", "Shelf", "", "", "Order No", "Order No", ""]);

  // RK73H1JTTD3302F group first (alphabetical): the receipt has no item-level
  // allocations; order-level covers 200 of 500, so the shelf suggestion still
  // shows (seed fallback shelf for STORE1 = A-04-05). The whole-order block
  // closes the group carrying Total/Balance.
  assert.deepEqual(rows[6], ["", "", "", "", "", "", ""]); // customer names (none)
  assert.deepEqual(rows[7], ["", "A-04-05", "", "", "", "", ""]); // shelf + order refs
  assert.deepEqual(rows[8], ["INV-PL-01", "RK73H1JTTD3302F", 500, "", "", "", ""]);
  assert.deepEqual(rows[9], ["", "", "", "", "ACME Electronics (HK)", "", ""]);
  assert.deepEqual(rows[10], ["", "", "", "", "SO-PL-001", "", ""]);
  assert.deepEqual(rows[11], ["(order-level)", "RK73H1JTTD3302F", "", 500, 200, "", 300]);
  assert.deepEqual(rows[12], ["", "", "", "", "", "", ""]); // group separator

  // RK73H2ATTD1372F group: FIFO gives SO-PL-001 1000 from ctn 7001 + 500 from
  // ctn 7002; SO-PL-002 takes 1000 from ctn 7002. Col A = invoice_no + ctn_no;
  // ctn 7001 is fully allocated → its shelf cell stays blank.
  assert.deepEqual(rows[13], ["", "", "", "", "ACME Electronics (HK)", "", ""]);
  assert.deepEqual(rows[14], ["", "", "", "", "SO-PL-001", "", ""]);
  assert.deepEqual(rows[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, "", 1000, "", ""]);
  assert.deepEqual(rows[16], ["", "", "", "", "ACME Electronics (HK)", "SO-PL-002", ""]);
  assert.deepEqual(rows[17], ["", "A-04-05", "", "", "SO-PL-001", "SO-PL-002", ""]);
  assert.deepEqual(rows[18], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 500, 1000, 500]);

  assert.equal(rows.length, 19);
});
