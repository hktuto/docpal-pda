// Route-level auth tests: real login (scrypt), JWT middleware enforcement,
// /events?token=, change-password, admin users hashing, actor-from-token.
// The app routers use the module-level db (src/db.ts), so DATABASE_URL must
// point at the test database before src/index.ts is imported — hence the
// dynamic import inside before().

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryGet } from "../db/query.js";
import { verifyPassword } from "./password.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

// --- helpers ---------------------------------------------------------------

async function login(username: string, password: string) {
  return app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

async function operatorToken(): Promise<string> {
  const res = await login("operator", "DocPal2026!");
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function userIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

// --- login -----------------------------------------------------------------

test("login: ok → {user, token} with group codes", async () => {
  await reseed(client);
  const res = await login("operator", "DocPal2026!");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.username, "operator");
  assert.equal(body.user.displayName, "Demo Operator");
  assert.deepEqual(body.user.groupCodes, ["operator"]);
  assert.equal(typeof body.token, "string");
  assert.ok(!("passwordHash" in body.user) && !("password" in body.user));

  const adminRes = await login("admin", "DocPalAdmin2026!");
  assert.equal(adminRes.status, 200);
  const adminBody = await adminRes.json();
  assert.deepEqual(adminBody.user.groupCodes, ["admin", "operator"]);
});

test("login: wrong password and unknown user → 401", async () => {
  await reseed(client);
  assert.equal((await login("operator", "wrong")).status, 401);
  assert.equal((await login("nobody", "DocPal2026!")).status, 401);
});

test("login: legacy plain-text row is upgraded to scrypt on success", async () => {
  await reseed(client);
  const id = crypto.randomUUID();
  await client.db.execute(
    sql`INSERT INTO users (id, username, password_hash, display_name, created_at)
        VALUES (${id}, 'legacy', ${"plain-pass"}, 'Legacy User', now())`
  );
  const res = await login("legacy", "plain-pass");
  assert.equal(res.status, 200);
  const row = await queryGet<{ passwordHash: string }>(
    client.db,
    sql`SELECT password_hash AS "passwordHash" FROM users WHERE id = ${id}`
  );
  assert.ok(row!.passwordHash.startsWith("scrypt:"), `expected scrypt hash, got ${row!.passwordHash}`);
  assert.ok(await verifyPassword("plain-pass", row!.passwordHash));
});

// --- middleware --------------------------------------------------------------

test("middleware: 401 without token and with a bad token; 200 with a token", async () => {
  await reseed(client);
  assert.equal((await app.request("/receiving-orders")).status, 401);
  assert.equal(
    (await app.request("/receiving-orders", { headers: { Authorization: "Bearer not-a-token" } })).status,
    401
  );
  const token = await operatorToken();
  const res = await app.request("/receiving-orders", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test("middleware: /health and POST /auth/login stay open", async () => {
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await login("operator", "DocPal2026!")).status, 200);
});

test("GET /events: 401 without token, 401 bad query token, 200 with ?token=", async () => {
  assert.equal((await app.request("/events")).status, 401);
  assert.equal((await app.request("/events?token=not-a-token")).status, 401);
  const token = await operatorToken();
  const res = await app.request(`/events?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  await res.body?.cancel();
});

test("?token= is only accepted for GET /events, not other routes", async () => {
  const token = await operatorToken();
  assert.equal((await app.request(`/receiving-orders?token=${encodeURIComponent(token)}`)).status, 401);
});

// --- /auth/me + change-password --------------------------------------------

test("GET /auth/me returns the token user; 401 without a token", async () => {
  await reseed(client);
  assert.equal((await app.request("/auth/me")).status, 401);
  const token = await operatorToken();
  const res = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.username, "operator");
  assert.deepEqual(body.groupCodes, ["operator"]);
});

test("change-password: wrong old → 401; success → new password logs in, old does not", async () => {
  await reseed(client);
  const token = await operatorToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const wrong = await app.request("/auth/change-password", {
    method: "POST",
    headers,
    body: JSON.stringify({ oldPassword: "nope", newPassword: "NewPass2026!" }),
  });
  assert.equal(wrong.status, 401);

  const ok = await app.request("/auth/change-password", {
    method: "POST",
    headers,
    body: JSON.stringify({ oldPassword: "DocPal2026!", newPassword: "NewPass2026!" }),
  });
  assert.equal(ok.status, 200);

  assert.equal((await login("operator", "NewPass2026!")).status, 200);
  assert.equal((await login("operator", "DocPal2026!")).status, 401);
});

// --- admin users + groups ----------------------------------------------------

test("admin users: create hashes the password; responses never expose the hash", async () => {
  await reseed(client);
  const token = await operatorToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  assert.equal((await app.request("/admin/users")).status, 401);

  const created = await app.request("/admin/users", {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "newguy", password: "secret123", displayName: "New Guy" }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.username, "newguy");
  assert.ok(!("passwordHash" in createdBody) && !("password_hash" in createdBody) && !("password" in createdBody));

  const row = await queryGet<{ passwordHash: string }>(
    client.db,
    sql`SELECT password_hash AS "passwordHash" FROM users WHERE username = 'newguy'`
  );
  assert.ok(row!.passwordHash.startsWith("scrypt:"));
  assert.equal((await login("newguy", "secret123")).status, 200);

  const list = await app.request("/admin/users", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(list.status, 200);
  for (const u of await list.json()) {
    assert.ok(!("passwordHash" in u) && !("password_hash" in u));
  }

  // Edit without password keeps the current one.
  const patch = await app.request(`/admin/users/${createdBody.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ displayName: "Renamed Guy" }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await login("newguy", "secret123")).status, 200);
});

test("admin user-groups + user-group-members CRUD (id = userId:groupCode)", async () => {
  await reseed(client);
  const token = await operatorToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const groups = await app.request("/admin/user-groups", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(groups.status, 200);
  assert.deepEqual(
    (await groups.json()).map((g: { code: string }) => g.code).sort(),
    ["admin", "operator"]
  );

  const operatorId = await userIdOf("operator");
  const created = await app.request("/admin/user-group-members", {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: operatorId, groupCode: "admin" }),
  });
  assert.equal(created.status, 201);

  const one = await app.request(`/admin/user-group-members/${operatorId}:admin`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(one.status, 200);

  const del = await app.request(`/admin/user-group-members/${operatorId}:admin`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(del.status, 200);
  assert.equal((await app.request(`/admin/user-group-members/${operatorId}:admin`, {
    headers: { Authorization: `Bearer ${token}` },
  })).status, 404);
});

// --- actor from token ---------------------------------------------------------

test("mutations take the actor from the token, not the body", async () => {
  await reseed(client);
  const res = await login("admin", "DocPalAdmin2026!");
  const token = (await res.json()).token as string;
  const adminId = await userIdOf("admin");
  const order = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_orders WHERE batch_no = '04958210'`
  );
  // Empty body — previously 400 actorId_required; now the token is the actor.
  const confirm = await app.request(`/receiving-orders/${order!.id}/confirm-arrival`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(confirm.status, 200);
  const arrived = await queryGet<{ arrivedBy: string }>(
    client.db,
    sql`SELECT arrived_by AS "arrivedBy" FROM receiving_orders WHERE id = ${order!.id}`
  );
  assert.equal(arrived!.arrivedBy, adminId);
});
