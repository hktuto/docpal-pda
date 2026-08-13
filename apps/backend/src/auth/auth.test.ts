// Route-level auth tests: real login (scrypt), JWT middleware enforcement,
// /events?token=, actor-from-token, DocPal-delegated login.
// The app routers use the module-level db (src/db.ts), so DATABASE_URL must
// point at the test database before src/index.ts is imported — hence the
// dynamic import inside before().

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryAll, queryGet } from "../db/query.js";
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
    sql`INSERT INTO users (id, username, password_hash, display_name, created_date)
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

// --- /auth/me ------------------------------------------------------------------

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

// --- actor from token ---------------------------------------------------------

test("mutations take the actor from the token, not the body", async () => {
  await reseed(client);
  const res = await login("admin", "DocPalAdmin2026!");
  const token = (await res.json()).token as string;
  const adminId = await userIdOf("admin");
  const order = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_orders WHERE batch_no = '100001'`
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

// --- DocPal-delegated login (spec 2026-08-13-docpal-auth-design) ------------
// A node:http fake stands in for the DocPal API. DOCPAL_URL is toggled only
// inside this block (test files run in separate processes), so the local-path
// tests above are unaffected.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const fakeState = {
  password: "good-pass",
  lastName: "Pal",
  groups: [
    { groupId: "WMS_Admin_Group_(HK)", groupName: "WMS Admin Group (HK)" },
    { groupId: "WMS_Dashboard_Group_(HK)", groupName: "WMS Dashboard Group (HK)" },
  ] as { groupId: string; groupName: string }[],
};

function startFakeDocpal(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/auth/login") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (body.password !== fakeState.password) return json(401, { message: "bad credentials" });
        json(200, { access_token: `tok-${body.username}`, refresh_token: "r1" });
      });
      return;
    }
    if (req.method === "GET" && req.url === "/dms/user/getApplication") {
      const username = (req.headers.authorization ?? "").replace("Bearer tok-", "");
      if (!req.headers.authorization?.startsWith("Bearer tok-")) return json(401, { message: "unauthorized" });
      return json(200, {
        code: 200,
        result: true,
        message: "success",
        data: {
          username,
          firstName: "Doc",
          lastName: fakeState.lastName,
          aclUserDetail: { groups: fakeState.groups },
        },
      });
    }
    json(404, { message: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("docpal login: happy path provisions the local user and maps groups to local codes", async (t) => {
  const { server, url } = await startFakeDocpal();
  t.after(() => server.close());
  process.env.DOCPAL_URL = url;
  t.after(() => delete process.env.DOCPAL_URL);
  await reseed(client);

  const res = await login("chris", "good-pass");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.username, "chris");
  assert.equal(body.user.displayName, "Doc Pal");
  // WMS_Admin_Group_(HK) → admin + operator; the dashboard group maps to nothing.
  assert.deepEqual(body.user.groupCodes, ["admin", "operator"]);

  const row = await queryGet<{ passwordHash: string }>(
    client.db,
    sql`SELECT password_hash AS "passwordHash" FROM users WHERE username = 'chris'`
  );
  assert.equal(row!.passwordHash, "");

  const memberships = await queryAll<{ groupCode: string }>(
    client.db,
    sql`SELECT group_code AS "groupCode" FROM user_group_members WHERE user_id = ${body.user.id} ORDER BY group_code`
  );
  assert.deepEqual(memberships, [{ groupCode: "admin" }, { groupCode: "operator" }]);

  // /auth/me works off the provisioned row.
  const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, "chris");
});

test("docpal login: second login keeps the id, refreshes name, replaces groups", async (t) => {
  const { server, url } = await startFakeDocpal();
  t.after(() => server.close());
  process.env.DOCPAL_URL = url;
  t.after(() => delete process.env.DOCPAL_URL);
  await reseed(client);

  const first = (await (await login("chris", "good-pass")).json()).user;
  fakeState.lastName = "Lu";
  fakeState.groups = [{ groupId: "WMS_PDA_Group_(HK)", groupName: "WMS PDA Group (HK)" }];
  const secondRes = await login("chris", "good-pass");
  const second = (await secondRes.json()).user;
  assert.equal(second.id, first.id);
  assert.equal(second.displayName, "Doc Lu");
  assert.deepEqual(second.groupCodes, ["operator"]);

  const memberships = await queryAll<{ groupCode: string }>(
    client.db,
    sql`SELECT group_code AS "groupCode" FROM user_group_members WHERE user_id = ${first.id}`
  );
  assert.deepEqual(memberships, [{ groupCode: "operator" }]);
});

test("docpal login: user with no mapped group gets 403", async (t) => {
  const { server, url } = await startFakeDocpal();
  t.after(() => server.close());
  process.env.DOCPAL_URL = url;
  t.after(() => delete process.env.DOCPAL_URL);
  await reseed(client);

  fakeState.groups = [
    { groupId: "WMS_Dashboard_Group_(HK)", groupName: "WMS Dashboard Group (HK)" },
    { groupId: "HK_TH_Group_(HK)", groupName: "HK TH Group (HK)" },
  ];
  const res = await login("yoyo", "good-pass");
  assert.equal(res.status, 403);
  // No local row is provisioned for a rejected user.
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM users WHERE username = 'yoyo'`),
    undefined
  );
});

test("docpal login: wrong password → 401; provider down → 502", async (t) => {
  const { server, url } = await startFakeDocpal();
  t.after(() => server.close());
  process.env.DOCPAL_URL = url;
  await reseed(client);
  fakeState.groups = [{ groupId: "WMS_Admin_Group_(HK)", groupName: "WMS Admin Group (HK)" }];

  assert.equal((await login("chris", "wrong")).status, 401);

  // Provider unreachable: nothing listens on this port.
  process.env.DOCPAL_URL = "http://127.0.0.1:1";
  assert.equal((await login("chris", "good-pass")).status, 502);

  // Unsetting DOCPAL_URL restores the local login path.
  delete process.env.DOCPAL_URL;
  assert.equal((await login("operator", "DocPal2026!")).status, 200);
});
