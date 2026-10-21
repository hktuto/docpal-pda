// Route-level tests for the allocation outdated flag on GET
// /receiving-orders/:id invoice-item allocations (spec
// docs/superpowers/specs/2026-10-20-allocation-outdated-stock-warning-design.md).
// Pattern follows user-scope.test.ts: DATABASE_URL points at the test database
// before src/index.js is imported; logins go through the shared fake DocPal.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryGet, queryRun } from "../db/query.js";
import { insertReceivingOrder, insertPickingOrder } from "../db/test-fixtures.js";
import { newId } from "../db/id.js";
import { dateToDateCode } from "../db/dateCode.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

async function operatorToken(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function receivingItemIdOf(receivingOrderId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${receivingOrderId}`
  );
  return row!.id;
}

/** Pending receiving order (one KOA part line) + a picking order holding a
 *  dock allocation of 50 against that line. Returns the receiving order id. */
async function worldWithDockAllocation(dateCode: string | null): Promise<string> {
  const roId = await insertReceivingOrder(client.db, "RO-OUTDATED-1", {
    order: { supplierCode: "KOA", orgId: 2 },
    invoices: [
      {
        invoiceNo: "INV-OUTDATED-1",
        items: [{ partNo: "RK73H1JTTD1002F", wclItemNo: "RK73H1JTTD1002F", lineQty: 100, dateCode }],
      },
    ],
  });
  const itemId = await receivingItemIdOf(roId);
  const poId = randomUUID();
  await insertPickingOrder(client.db, poId, {
    order: { orderNo: "SO-OUTDATED-1" },
    items: [{ partNo: "RK73H1JTTD1002F", qty: 50 }],
  });
  const piRow = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${poId}`
  );
  await queryRun(
    client.db,
    sql`INSERT INTO allocations (id, picking_item_id, receiving_invoice_item_id, qty, created_date, last_update_date)
        VALUES (${newId()}, ${piRow!.id}, ${itemId}, 50, now(), now())`
  );
  return roId;
}

async function allocOutdatedFlag(roId: string): Promise<boolean> {
  const token = await operatorToken();
  const res = await app.request(`/receiving-orders/${roId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const allocations = body.invoices[0].items[0].allocations;
  assert.equal(allocations.length, 1);
  return allocations[0].outdated as boolean;
}

test("receiving detail: allocation outdated flag — old/fresh/invalid item date codes", async () => {
  await reseed(client);

  // "2607" = week 26 of 2007 → over 2y old at the default threshold
  const old = await worldWithDockAllocation("2607");
  assert.equal(await allocOutdatedFlag(old), true);

  // fresh WWYY → not outdated
  const fresh = await worldWithDockAllocation(dateToDateCode(new Date()));
  assert.equal(await allocOutdatedFlag(fresh), false);

  // invalid code → never flagged
  const invalid = await worldWithDockAllocation("ABCD");
  assert.equal(await allocOutdatedFlag(invalid), false);

  // NULL code → never flagged
  const none = await worldWithDockAllocation(null);
  assert.equal(await allocOutdatedFlag(none), false);
});
