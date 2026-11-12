// Route-level tests for POST /admin/cust-item-lookup (Custom Print Label CSV
// enrichment): (單號, 物料號) → picking_orders.customer_code →
// customer_accounts.account_number → mtl_cross_references.cross_reference,
// plus parts.description. mtl_cross_references is externally-managed (not in
// the Drizzle schema) so the test creates it itself. Dynamic app import so
// DATABASE_URL points at the test DB first (same pattern as
// customerAccounts.test.ts).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";

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
  await client.db.execute(sql`
    CREATE TABLE IF NOT EXISTS mtl_cross_references (
      description text,
      inv_item_concat_segs text,
      cross_reference bigint
    )
  `);
});

function post(body: unknown) {
  return app.request("/admin/cust-item-lookup", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedChain() {
  await client.db.execute(sql`DELETE FROM mtl_cross_references`);
  await client.db.execute(sql`
    INSERT INTO customer_accounts (cust_account_id, party_id, party_name, party_type, account_number, account_status)
    VALUES (9001, 9001, 'LWXY Customer', 'ORGANIZATION', '22058', 'A')
  `);
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, delivery_date)
    VALUES ('test-cl-1', 'HK2610-0450', 'LWXY Customer', '2026-10-30')
  `);
  await client.db.execute(sql`
    INSERT INTO parts (id, brand, part_no, wcl_item_no, description)
    VALUES ('test-cl-p1', 'KOA', 'SG73P2ATTD4701F', 'KOA+SG73P2ATTD 4701F', 'CHIP.RES 0402 100K OHM 1% MOQ=10000')
  `);
  await client.db.execute(sql`
    INSERT INTO mtl_cross_references (description, inv_item_concat_segs, cross_reference)
    VALUES ('22058', 'KOA+SG73P2ATTD 4701F', 28895)
  `);
}

test("cust-item-lookup: full chain resolves custItemNumber + description", async () => {
  await reseed(client);
  await seedChain();
  const res = await post({ lines: [{ orderNo: "HK2610-0450", wclItemNo: "KOA+SG73P2ATTD 4701F" }] });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(results, [
    {
      orderNo: "HK2610-0450",
      wclItemNo: "KOA+SG73P2ATTD 4701F",
      custItemNumber: "28895",
      partNo: "SG73P2ATTD4701F",
      itemDescription: "CHIP.RES 0402 100K OHM 1% MOQ=10000",
      moq: 10000,
      deliveryDate: "2026-10-30",
    },
  ]);
});

test("cust-item-lookup: chain misses resolve to null; description is independent", async () => {
  await reseed(client);
  await seedChain();
  const res = await post({
    lines: [
      { orderNo: "NO-SUCH-ORDER", wclItemNo: "KOA+SG73P2ATTD 4701F" }, // order miss → null cust item, part fields still found
      { orderNo: "HK2610-0450", wclItemNo: "NO-SUCH-PART" }, // cross-ref + part miss → all null
    ],
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(results, [
    {
      orderNo: "NO-SUCH-ORDER",
      wclItemNo: "KOA+SG73P2ATTD 4701F",
      custItemNumber: null,
      partNo: "SG73P2ATTD4701F",
      itemDescription: "CHIP.RES 0402 100K OHM 1% MOQ=10000",
      moq: 10000,
      deliveryDate: null,
    },
    {
      orderNo: "HK2610-0450",
      wclItemNo: "NO-SUCH-PART",
      custItemNumber: null,
      partNo: null,
      itemDescription: null,
      moq: null,
      deliveryDate: "2026-10-30",
    },
  ]);
});

test("cust-item-lookup: rejects invalid payloads", async () => {
  await reseed(client);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ lines: [] })).status, 400);
  assert.equal((await post({ lines: [{ orderNo: "X" }] })).status, 400);
  assert.equal((await post({ lines: [{ orderNo: 1, wclItemNo: "Y" }] })).status, 400);
});
