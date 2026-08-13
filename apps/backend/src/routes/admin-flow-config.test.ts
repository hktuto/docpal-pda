// Route-level tests for /admin/flow-config (spec
// 2026-08-12-admin-flow-config-design.md): GET shape, PUT validation,
// persistence to the warehouse_config row, and runtime apply (no restart).
// Dynamic app import so DATABASE_URL points at the test DB first (same
// pattern as src/auth/auth.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { queryGet } from "../db/query.js";
import { _resetFlowConfigForTests } from "../config.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];
let token: string;

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
  delete process.env.FLOW_CONFIG; // dotenv may re-load it at app import; this suite tests the DB-row path
  _resetFlowConfigForTests();
  await (await import("../config.js")).loadFlowConfig(client.db);
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await res.json()).token;
});

after(() => {
  _resetFlowConfigForTests();
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
}

test("GET /admin/flow-config: effective config + stored row + envOverride", async () => {
  await reseed(client);
  const res = await req("/admin/flow-config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.envOverride, false);
  assert.deepEqual(body.stored, {});
  assert.equal(body.config.putAway.autoCreateTasks, false); // default
  assert.equal(body.config.steps.picking.enabled, true);
});

test("GET /admin/flow-config: env override active → form shows the stored row, envOverride=true", async () => {
  await reseed(client);
  process.env.FLOW_CONFIG = '{"steps":{"put-away":{"autoCreateTasks":true}}}';
  try {
    const res = await req("/admin/flow-config");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.envOverride, true);
    // The stored row ({}), not the env value — this is what the form edits.
    assert.equal(body.config.putAway.autoCreateTasks, false);
    assert.deepEqual(body.stored, {});
  } finally {
    delete process.env.FLOW_CONFIG;
  }
});

test("PUT /admin/flow-config: validates, persists, applies at runtime", async () => {
  await reseed(client);
  try {
    const payload = { steps: { "put-away": { autoCreateTasks: true, suggestShelf: "off" }, measuring: { enabled: false } } };
    const res = await req("/admin/flow-config", { method: "PUT", body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.applied, true);
    assert.equal(body.config.putAway.autoCreateTasks, true);
    assert.equal(body.config.putAway.suggestShelf, "off");
    assert.equal(body.config.steps.measuring.enabled, false);
    // persisted to the row
    const row = await queryGet<{ value: unknown }>(
      client.db,
      sql`SELECT value FROM warehouse_config WHERE key = 'flow'`
    );
    assert.deepEqual(row!.value, payload);
    // runtime applied: a follow-up GET reflects it without restart
    const get = await (await req("/admin/flow-config")).json();
    assert.equal(get.config.putAway.autoCreateTasks, true);
  } finally {
    _resetFlowConfigForTests();
  }
});

test("PUT /admin/flow-config: invalid JSON shapes → 400, row untouched", async () => {
  await reseed(client);
  try {
    for (const bad of [
      { steps: { nope: { enabled: true } } }, // unknown step
      { steps: { picking: { enabled: "yes" } } }, // wrong type
      { steps: { "put-away": { suggestShelf: "magic" } } }, // bad enum
      // conflict: put-away disabled + dock stock disallowed — stock could
      // never become allocatable
      { steps: { "put-away": { enabled: false }, picking: { allocation: { allowDockStock: false } } } },
    ]) {
      const res = await req("/admin/flow-config", { method: "PUT", body: JSON.stringify(bad) });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const row = await queryGet<{ value: unknown }>(
      client.db,
      sql`SELECT value FROM warehouse_config WHERE key = 'flow'`
    );
    assert.deepEqual(row!.value, {});
  } finally {
    _resetFlowConfigForTests();
  }
});
