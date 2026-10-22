// Route-level tests for GET /receiving-orders server paging/filtering/sorting
// (the admin list pages through it). Same harness as auth.test.ts: the app
// routers use the module-level db (src/db.ts), so DATABASE_URL must point at
// the test database before src/index.ts is imported — hence the dynamic
// import inside before(). Logins go through the shared fake DocPal.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

interface ListRow {
  id: string;
  batchNo: string;
  status: string;
  supplierCode: string | null;
  invoiceCount: number;
}

async function operatorToken(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function list(token: string, qs = ""): Promise<{ rows: ListRow[]; total: number }> {
  const res = await app.request(`/receiving-orders${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

/** Bare receiving order with no invoices (upstream placeholder shape). */
async function insertOrderlessReceivingOrder(batchNo: string): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO receiving_orders (id, batch_no, status, org_id, created_date, last_update_date)
        VALUES (${id}, ${batchNo}, 'pending', 2, now(), now())`
  );
  return id;
}

test("list: limit/offset page the ordered window; total counts all matches", async () => {
  await reseed(client);
  const token = await operatorToken();

  const all = await list(token);
  assert.ok(all.total >= 2);
  assert.equal(all.rows.length, all.total);

  const page1 = await list(token, "?limit=1");
  assert.equal(page1.rows.length, 1);
  assert.equal(page1.total, all.total);
  assert.equal(page1.rows[0]!.id, all.rows[0]!.id);

  const page2 = await list(token, "?limit=1&offset=1");
  assert.equal(page2.total, all.total);
  assert.equal(page2.rows[0]!.id, all.rows[1]!.id);
});

test("list: hasInvoices=1 hides orders with no invoices", async () => {
  await reseed(client);
  const token = await operatorToken();
  const bareId = await insertOrderlessReceivingOrder("TEST-NO-INVOICE");

  const all = await list(token);
  assert.ok(all.rows.some((r) => r.id === bareId));

  const filtered = await list(token, "?hasInvoices=1");
  assert.equal(filtered.total, all.total - 1);
  assert.ok(filtered.rows.every((r) => r.invoiceCount > 0));
  assert.ok(!filtered.rows.some((r) => r.id === bareId));
});

test("list: status filter accepts comma-separated values (any-of)", async () => {
  await reseed(client);
  const token = await operatorToken();
  await insertOrderlessReceivingOrder("TEST-ST-PENDING"); // status pending
  for (const [batchNo, status] of [
    ["TEST-ST-CLEAR", "clear"],
    ["TEST-ST-INHAND", "in_hand"],
  ] as const) {
    await client.db.execute(
      sql`INSERT INTO receiving_orders (id, batch_no, status, org_id, created_date, last_update_date)
          VALUES (${randomUUID()}, ${batchNo}, ${status}, 2, now(), now())`
    );
  }

  const single = await list(token, "?status=clear");
  assert.ok(single.total >= 1);
  assert.ok(single.rows.every((r) => r.status === "clear"));
  assert.ok(single.rows.some((r) => r.batchNo === "TEST-ST-CLEAR"));
  assert.ok(!single.rows.some((r) => r.batchNo === "TEST-ST-PENDING"));

  const multi = await list(token, "?status=pending,clear");
  assert.ok(multi.rows.some((r) => r.batchNo === "TEST-ST-PENDING"));
  assert.ok(multi.rows.some((r) => r.batchNo === "TEST-ST-CLEAR"));
  assert.ok(!multi.rows.some((r) => r.batchNo === "TEST-ST-INHAND"));

  // Whitespace around the comma is tolerated; empty = no filter.
  const spaced = await list(token, "?status=pending, clear");
  assert.deepEqual(
    spaced.rows.map((r) => r.id).sort(),
    multi.rows.map((r) => r.id).sort()
  );
  const all = await list(token);
  assert.ok(all.rows.some((r) => r.batchNo === "TEST-ST-INHAND"));
});

test("list: search matches supplier code (plus batch no / supplier name / invoice no)", async () => {
  await reseed(client);
  const token = await operatorToken();

  const all = await list(token);
  const withSupplier = all.rows.find((r) => r.supplierCode);
  assert.ok(withSupplier, "seeded receiving order with a supplier");

  const byCode = await list(token, `?search=${encodeURIComponent(withSupplier.supplierCode!.toLowerCase())}`);
  assert.ok(byCode.total >= 1);
  assert.ok(byCode.rows.some((r) => r.supplierCode === withSupplier.supplierCode));
});

test("list: sort whitelist orders the window; unknown key falls back to the default order", async () => {
  await reseed(client);
  const token = await operatorToken();

  const asc = await list(token, "?sort=batchNo&dir=asc");
  const batchNos = asc.rows.map((r) => r.batchNo);
  assert.deepEqual(batchNos, [...batchNos].sort((a, b) => a.localeCompare(b)));

  const desc = await list(token, "?sort=batchNo&dir=desc");
  assert.deepEqual(desc.rows.map((r) => r.batchNo), [...batchNos].reverse());

  const fallback = await list(token, "?sort=no-such-column");
  const def = await list(token);
  assert.deepEqual(fallback.rows.map((r) => r.id), def.rows.map((r) => r.id));
});
