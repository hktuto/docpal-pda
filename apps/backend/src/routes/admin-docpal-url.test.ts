// Route-level test for GET /admin/docpal-url: returns the configured
// DOCPAL_URL (null when unset). Dynamic app import so DATABASE_URL points at
// the test DB first (same pattern as admin-flow-config.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, TEST_DATABASE_URL, FAKE_DOCPAL_URL } from "../db/test-helper.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let app: (typeof import("../index.js"))["app"];
let token: string;

before(async () => {
  await setupTestDb();
  ({ app } = await import("../index.js"));
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await res.json()).token;
});

after(() => {
  process.env.DOCPAL_URL = FAKE_DOCPAL_URL;
});

function req(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

test("GET /admin/docpal-url: returns the configured DOCPAL_URL", async () => {
  const res = await req("/admin/docpal-url");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: FAKE_DOCPAL_URL });
});

test("GET /admin/docpal-url: null when DOCPAL_URL is unset", async (t) => {
  const saved = process.env.DOCPAL_URL;
  delete process.env.DOCPAL_URL;
  t.after(() => {
    process.env.DOCPAL_URL = saved ?? FAKE_DOCPAL_URL;
  });
  const res = await req("/admin/docpal-url");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: null });
});
