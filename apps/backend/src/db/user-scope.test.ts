// Per-user sub-inventory scope (spec
// 2026-09-11-user-subinventory-scope-design.md). Db-level tests for
// getUserScope / userScopeCondition semantics, then route-level tests for
// the picking/receiving list+detail filtering and the profile PUTs.
// Route tests follow auth.test.ts: DATABASE_URL points at the test database
// before src/index.ts is imported; logins go through the shared fake DocPal.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "./test-helper.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { getUserScope, upsertUserScope, userScopeFilter } from "./user-scope.js";
import { listPickingOrders, getPickingOrderDetail } from "./picking.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

// --- helpers ---------------------------------------------------------------

async function operatorToken(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

function authed(token: string, path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
}

async function putMyScope(token: string, scope: unknown) {
  return authed(token, "/auth/me/profile", {
    method: "PUT",
    body: JSON.stringify({ subInventoryScopes: scope }),
  });
}

const STORE1 = [{ orgId: 2, code: "STORE1" }];
const WSTORE1 = [{ orgId: 2, code: "WSTORE1" }];

async function pickingOrderId(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`
  );
  return row!.id;
}

async function receivingOrderId(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`
  );
  return row!.id;
}

// --- getUserScope ------------------------------------------------------------

test("getUserScope: no row / empty / malformed → null; round-trip after upsert", async () => {
  await reseed(client);
  assert.equal(await getUserScope(client.db, "operator"), null); // no row

  await upsertUserScope(client.db, "operator", []);
  assert.equal(await getUserScope(client.db, "operator"), null); // [] = unrestricted

  const scope = [...STORE1, { orgId: 220, code: "THHK2" }];
  await upsertUserScope(client.db, "operator", scope);
  assert.deepEqual(await getUserScope(client.db, "operator"), scope);

  // Malformed jsonb is tolerated as unrestricted.
  await queryRun(
    client.db,
    sql`INSERT INTO user_profiles (id, username, sub_inventory_scopes)
        VALUES (app_uuid_v7()::text, 'weird', '{"not":"array"}'::jsonb)`
  );
  assert.equal(await getUserScope(client.db, "weird"), null);
});

// --- userScopeCondition SQL semantics ----------------------------------------

test("userScopeFilter: NULL stays visible, pairs match (org_id, code) exactly", async () => {
  await reseed(client);
  const orderId = await pickingOrderId("SO-DEMO-0001");
  // One NULL-sub order (freshly synced shape).
  await queryRun(client.db, sql`UPDATE picking_orders SET sub_inventory_code = NULL WHERE id = ${orderId}`);

  const visible = async (scope: Parameters<typeof userScopeFilter>[2]) =>
    (
      await queryGet<{ n: number }>(
        client.db,
        sql`SELECT COUNT(*)::int AS n FROM picking_orders po
            WHERE TRUE ${userScopeFilter(sql`po.org_id`, sql`po.sub_inventory_code`, scope)}`
      )
    )!.n;

  const total = await visible(null);
  assert.ok(total > 1);
  assert.equal(await visible(STORE1), total); // in-scope + NULL row
  assert.equal(await visible(WSTORE1), 1); // only the NULL-sub order
  assert.equal(await visible([]), total); // empty = unrestricted

  // Same through the db module reads.
  assert.equal((await listPickingOrders(client.db, { scope: WSTORE1 })).rows.length, 1);
  const detail = await getPickingOrderDetail(client.db, orderId, WSTORE1);
  assert.equal(detail.id, orderId);
  const outOfScope = await pickingOrderId("SO-DEMO-0002");
  await assert.rejects(getPickingOrderDetail(client.db, outOfScope, WSTORE1), /picking_order_not_found/);
});

// --- picking routes ------------------------------------------------------------

test("GET /picking-orders + /:id are scoped by the actor's profile", async () => {
  await reseed(client);
  const token = await operatorToken();

  const baseline = (await (await authed(token, "/picking-orders")).json()).rows.length;
  assert.ok(baseline > 1);

  assert.equal((await putMyScope(token, WSTORE1)).status, 200);
  const scoped = await authed(token, "/picking-orders");
  assert.equal((await scoped.json()).rows.length, 0);
  const orderId = await pickingOrderId("SO-DEMO-0001");
  assert.equal((await authed(token, `/picking-orders/${orderId}`)).status, 404);

  // NULL-sub orders stay visible.
  await queryRun(client.db, sql`UPDATE picking_orders SET sub_inventory_code = NULL WHERE id = ${orderId}`);
  const withNull = (await (await authed(token, "/picking-orders")).json()).rows;
  assert.equal(withNull.length, 1);
  assert.equal(withNull[0].id, orderId);
  assert.equal((await authed(token, `/picking-orders/${orderId}`)).status, 200);

  // Clearing the scope restores the full list.
  assert.equal((await putMyScope(token, [])).status, 200);
  assert.equal((await (await authed(token, "/picking-orders")).json()).rows.length, baseline);
});

// --- receiving routes ----------------------------------------------------------

test("GET /receiving-orders: hidden only when ALL items are stamped out-of-scope", async () => {
  await reseed(client);
  const token = await operatorToken();

  const baseline = (await (await authed(token, "/receiving-orders")).json()).rows.length;
  assert.ok(baseline >= 3);

  // All demo items are stamped (2, STORE1) → all orders hidden under WSTORE1.
  assert.equal((await putMyScope(token, WSTORE1)).status, 200);
  assert.equal((await (await authed(token, "/receiving-orders")).json()).rows.length, 0);

  // An order whose items are unstamped (NULL) is visible again.
  const orderId = await receivingOrderId("100001");
  await queryRun(
    client.db,
    sql`UPDATE receiving_invoice_items SET sub_inventory_code = NULL
        WHERE receiving_invoice_id IN (SELECT id FROM receiving_invoices WHERE receiving_order_id = ${orderId})`
  );
  let rows = (await (await authed(token, "/receiving-orders")).json()).rows;
  assert.deepEqual(rows.map((r: { id: string }) => r.id), [orderId]);

  // An order with no items at all stays visible.
  await queryRun(
    client.db,
    sql`INSERT INTO receiving_orders (id, batch_no, org_id, status)
        VALUES (app_uuid_v7()::text, 'NOITEM-1', 2, 'pending')`
  );
  rows = (await (await authed(token, "/receiving-orders")).json()).rows;
  assert.equal(rows.length, 2);

  assert.equal((await putMyScope(token, [])).status, 200);
  assert.equal((await (await authed(token, "/receiving-orders")).json()).rows.length, baseline + 1);
});

test("GET /receiving-orders/:id: order-level 404 + item-level filtering", async () => {
  await reseed(client);
  const token = await operatorToken();
  const orderId = await receivingOrderId("100002");

  const full = await (await authed(token, `/receiving-orders/${orderId}`)).json();
  const fullItemCount = full.invoices.flatMap((i: { items: unknown[] }) => i.items).length;
  assert.ok(fullItemCount > 1);

  assert.equal((await putMyScope(token, WSTORE1)).status, 200);
  assert.equal((await authed(token, `/receiving-orders/${orderId}`)).status, 404);

  // Stamp one item in scope: order visible again, items list holds only it.
  const item = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices inv ON inv.id = rii.receiving_invoice_id
        WHERE inv.receiving_order_id = ${orderId} ORDER BY rii.id LIMIT 1`
  );
  await queryRun(
    client.db,
    sql`UPDATE receiving_invoice_items SET sub_inventory_code = 'WSTORE1' WHERE id = ${item!.id}`
  );
  const res = await authed(token, `/receiving-orders/${orderId}`);
  assert.equal(res.status, 200);
  const detail = await res.json();
  const items = detail.invoices.flatMap((i: { items: { id: string }[] }) => i.items);
  assert.deepEqual(items.map((i: { id: string }) => i.id), [item!.id]);
});

// --- profile PUTs ----------------------------------------------------------------

test("PUT /auth/me/profile: validation + unknown pairs → 400 unknown_sub_inventory", async () => {
  await reseed(client);
  const token = await operatorToken();

  const unknown = await putMyScope(token, [{ orgId: 999, code: "NOPE" }]);
  assert.equal(unknown.status, 400);
  const unknownText = await unknown.text();
  assert.match(unknownText, /unknown_sub_inventory/);
  assert.match(unknownText, /999\/NOPE/);

  const badShape = await putMyScope(token, [{ orgId: "2", code: "STORE1" }]);
  assert.equal(badShape.status, 400);

  assert.equal(await getUserScope(client.db, "operator"), null); // nothing stored
});

test("PUT /admin/user-profiles/:username: pre-provisions a profile before login", async () => {
  await reseed(client);
  const token = await operatorToken();

  const res = await authed(token, "/admin/user-profiles/ghost-user", {
    method: "PUT",
    body: JSON.stringify({ subInventoryScopes: STORE1 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { username: "ghost-user", subInventoryScopes: STORE1 });

  // No users row was created — the profile stands alone.
  assert.equal(await queryGet(client.db, sql`SELECT id FROM users WHERE username = 'ghost-user'`), undefined);
  assert.deepEqual(await getUserScope(client.db, "ghost-user"), STORE1);

  // GET lists all users LEFT JOIN profiles ([] = unrestricted).
  const list = await (await authed(token, "/admin/user-profiles")).json();
  const operator = list.find((u: { username: string }) => u.username === "operator");
  assert.ok(operator);
  assert.deepEqual(operator.subInventoryScopes, []);
  assert.deepEqual(operator.groupCodes, ["PDA Group"]);
});
