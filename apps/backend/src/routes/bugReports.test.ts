// Bug report inbox (spec 2026-11-05-in-app-bug-report-design.md): any
// authenticated user POSTs /bug-reports (reporter from the JWT, never body);
// the /admin/bug-reports queue lists light columns, shows the full trail in
// detail, patches status/uat_ref, and deletes. Admin-group gate applies.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryGet } from "../db/query.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

let operatorToken = "";
let adminToken = "";

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
  operatorToken = await login("operator", "DocPal2026!");
  adminToken = await login("admin", "DocPalAdmin2026!");
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function call(token: string, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

after(async () => {
  await client.db.execute(sql`DELETE FROM bug_reports`);
});

const base = {
  app: "pda",
  route: "/put-away/PO-1",
  category: "scan_failed",
  note: "scanner did not respond",
  context: { userAgent: "test", sessionId: "s1" },
  trail: [{ t: Date.now(), k: "route", m: "/put-away/PO-1", r: "/put-away/PO-1" }],
};

test("operator can file a report; reporter comes from the token, not the body", async () => {
  const res = await call(operatorToken, "POST", "/bug-reports", { ...base, reporter: "mallory" });
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const row = await queryGet<{ reporter: string; status: string; category: string; note: string }>(
    client.db,
    sql`SELECT reporter, note, status, category FROM bug_reports WHERE id = ${id}`
  );
  assert.equal(row?.reporter, "operator");
  assert.equal(row?.status, "open");
  assert.equal(row?.category, "scan_failed");
});

test("validation: empty note 400, bad category 400, bad app 400", async () => {
  assert.equal((await call(operatorToken, "POST", "/bug-reports", { ...base, note: "  " })).status, 400);
  assert.equal((await call(operatorToken, "POST", "/bug-reports", { ...base, category: "nope" })).status, 400);
  assert.equal((await call(operatorToken, "POST", "/bug-reports", { ...base, app: "ios" })).status, 400);
});

test("size caps: oversized trail and photo 413", async () => {
  const fat = "x".repeat(300_000);
  assert.equal((await call(operatorToken, "POST", "/bug-reports", { ...base, trail: [{ m: fat }] })).status, 413);
  // ~7 MB of base64 ≈ 5.25 MB decoded → over the 5 MB cap
  const bigPhoto = "A".repeat(7_000_000);
  assert.equal((await call(operatorToken, "POST", "/bug-reports", { ...base, photo: bigPhoto })).status, 413);
});

test("anonymous reports are rejected (global JWT middleware)", async () => {
  const res = await app.request("/bug-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base),
  });
  assert.equal(res.status, 401);
});

test("admin queue: light list, detail with trail, patch, delete; operator is 403", async () => {
  const created = await call(operatorToken, "POST", "/bug-reports", base);
  assert.equal(created.status, 201);
  const { id } = await created.json();

  assert.equal((await call(operatorToken, "GET", "/admin/bug-reports")).status, 403);

  const list = await call(adminToken, "GET", "/admin/bug-reports");
  assert.equal(list.status, 200);
  const rows = await list.json();
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].trail, undefined, "list must not carry the trail");
  assert.ok("hasPhoto" in rows[0]);

  const detail = await (await call(adminToken, "GET", `/admin/bug-reports/${id}`)).json();
  assert.ok(Array.isArray(detail.trail) && detail.trail.length === 1);

  const patched = await call(adminToken, "PATCH", `/admin/bug-reports/${id}`, {
    status: "triaged",
    uatRef: "BUG-040",
  });
  assert.equal(patched.status, 200);
  const p = await patched.json();
  assert.equal(p.status, "triaged");
  assert.equal(p.uatRef, "BUG-040");

  assert.equal((await call(adminToken, "PATCH", `/admin/bug-reports/${id}`, { status: "bogus" })).status, 400);
  assert.equal((await call(adminToken, "PATCH", `/admin/bug-reports/nonexistent`, { status: "closed" })).status, 404);

  assert.equal((await call(adminToken, "DELETE", `/admin/bug-reports/${id}`)).status, 200);
  assert.equal((await call(adminToken, "GET", `/admin/bug-reports/${id}`)).status, 404);
});
