// Per-user date format preferences (spec
// 2026-09-16-admin-date-format-setting-design.md). Route-level tests for
// GET/PUT /auth/me/profile dateFormat / dateTimeFormat: defaults, round-trip,
// merge semantics with subInventoryScopes, and token validation.
// Follows user-scope.test.ts: DATABASE_URL points at the test database before
// src/index.ts is imported; logins go through the shared fake DocPal.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "./test-helper.js";
import { getUserDateFormats, DEFAULT_DATE_FORMAT, DEFAULT_DATE_TIME_FORMAT } from "./user-profile.js";

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

function authed(token: string, path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
}

test("GET /auth/me/profile: defaults when no row", async () => {
  await reseed(client);
  const token = await operatorToken();

  const res = await authed(token, "/auth/me/profile");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dateFormat, DEFAULT_DATE_FORMAT);
  assert.equal(body.dateTimeFormat, DEFAULT_DATE_TIME_FORMAT);
  assert.deepEqual(body.subInventoryScopes, []);
});

test("PUT /auth/me/profile: round-trip + merge with scope", async () => {
  await reseed(client);
  const token = await operatorToken();

  // Formats only — scope untouched (still unrestricted).
  const putFormats = await authed(token, "/auth/me/profile", {
    method: "PUT",
    body: JSON.stringify({ dateFormat: "yyyy-MM-dd", dateTimeFormat: "dd/MMM/yyyy hh:mm a" }),
  });
  assert.equal(putFormats.status, 200);
  const formatsBody = await putFormats.json();
  assert.equal(formatsBody.dateFormat, "yyyy-MM-dd");
  assert.equal(formatsBody.dateTimeFormat, "dd/MMM/yyyy hh:mm a");
  assert.deepEqual(formatsBody.subInventoryScopes, []);

  // Scope only — formats survive.
  const STORE1 = [{ orgId: 2, code: "STORE1" }];
  const putScope = await authed(token, "/auth/me/profile", {
    method: "PUT",
    body: JSON.stringify({ subInventoryScopes: STORE1 }),
  });
  assert.equal(putScope.status, 200);
  const scopeBody = await putScope.json();
  assert.deepEqual(scopeBody.subInventoryScopes, STORE1);
  assert.equal(scopeBody.dateFormat, "yyyy-MM-dd");
  assert.equal(scopeBody.dateTimeFormat, "dd/MMM/yyyy hh:mm a");

  assert.deepEqual(await getUserDateFormats(client.db, "operator"), {
    dateFormat: "yyyy-MM-dd",
    dateTimeFormat: "dd/MMM/yyyy hh:mm a",
  });
});

test("PUT /auth/me/profile: invalid format → 400 invalid_date_format", async () => {
  await reseed(client);
  const token = await operatorToken();

  for (const bad of [42, "", "a".repeat(65), "dd/QQQ/yyyy", "dd MMMM yyyy"]) {
    const res = await authed(token, "/auth/me/profile", {
      method: "PUT",
      body: JSON.stringify({ dateFormat: bad }),
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(await res.text(), /invalid_date_format/);
  }

  // Nothing stored.
  assert.deepEqual(await getUserDateFormats(client.db, "operator"), {
    dateFormat: DEFAULT_DATE_FORMAT,
    dateTimeFormat: DEFAULT_DATE_TIME_FORMAT,
  });
});
