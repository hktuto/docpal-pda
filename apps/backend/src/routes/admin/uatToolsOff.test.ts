// UAT_TOOLS unset (default): POST /admin/uat/inventory-wipe must not be
// registered at all (spec 2026-11-13-uat-inventory-tools-design.md) and
// GET /config must omit the uatTools key. Runs in its own process — the
// route registers at module load, so the flag must be unset before the
// app import (uatInventoryTools.test.ts sets it to 1).

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
delete process.env.UAT_TOOLS;

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
  token = (await res.json()).token as string;
});

beforeEach(async () => {
  await reseed(client);
});

test("inventory-wipe route is not registered when UAT_TOOLS is unset", async () => {
  const res = await app.request("/admin/uat/inventory-wipe", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
});

test("config omits uatTools when UAT_TOOLS is unset", async () => {
  const res = await app.request("/config", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal("uatTools" in body, false);
});
