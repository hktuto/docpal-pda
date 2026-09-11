// Route-level tests for GET /admin/customer-accounts (spec
// 2026-09-10-customer-profiles-accounts-design.md): the upstream-synced
// customer account master is exposed read-only — list ordered by party name,
// ?q= ilike search on party_name / account_number, exact ?partyName= filter,
// and no mutations. Dynamic app import so DATABASE_URL points at the test DB
// first (same pattern as receivingPickingList.test.ts).

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
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

async function insertAccounts() {
  await client.db.execute(sql`
    INSERT INTO customer_accounts (cust_account_id, party_id, party_name, party_type, account_number, account_status)
    VALUES (1001, 5001, 'ACME Electronics (HK)', 'ORGANIZATION', 'CUST-1001', 'A'),
           (1002, 5002, 'Beta Industries', 'ORGANIZATION', 'CUST-1002', 'I'),
           (1003, 5003, 'Gamma Trading', 'ORGANIZATION', 'CUST-1003', 'A')
  `);
}

test("GET customer-accounts: full list ordered by party name", async () => {
  await reseed(client);
  await insertAccounts();
  const res = await req("/admin/customer-accounts");
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r: any) => r.partyName),
    ["ACME Electronics (HK)", "Beta Industries", "Gamma Trading"]
  );
  assert.deepEqual(rows[0], {
    custAccountId: 1001,
    partyId: 5001,
    partyName: "ACME Electronics (HK)",
    partyType: "ORGANIZATION",
    accountNumber: "CUST-1001",
    accountStatus: "A",
    lastUpdateDate: rows[0].lastUpdateDate,
  });
});

test("GET customer-accounts: ?partyName= exact filter", async () => {
  await reseed(client);
  await insertAccounts();
  const res = await req(`/admin/customer-accounts?partyName=${encodeURIComponent("Beta Industries")}`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].custAccountId, 1002);
  assert.equal(rows[0].accountStatus, "I");
});

test("GET customer-accounts: ?q= searches party name and account number", async () => {
  await reseed(client);
  await insertAccounts();
  const byName = await req("/admin/customer-accounts?q=gamma");
  assert.equal(byName.status, 200);
  assert.deepEqual(
    (await byName.json()).map((r: any) => r.accountNumber),
    ["CUST-1003"]
  );
  const byNumber = await req("/admin/customer-accounts?q=1002");
  assert.equal(byNumber.status, 200);
  assert.deepEqual(
    (await byNumber.json()).map((r: any) => r.partyName),
    ["Beta Industries"]
  );
});

test("customer-accounts is read-only: POST is not routed", async () => {
  await reseed(client);
  const res = await req("/admin/customer-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partyName: "Nope" }),
  });
  assert.equal(res.status, 404);
});
