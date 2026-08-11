import { test, before, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./db/test-helper.js";
import { queryGet } from "./db/query.js";
import {
  allowDockStock,
  isStepEnabled,
  loadFlowConfig,
  putAwayConfig,
  _resetFlowConfigForTests,
} from "./config.js";

// DB-backed flow config (spec 2026-08-10-flow-config-design.md):
// warehouse_config row "flow" is the per-warehouse source, FLOW_CONFIG env
// overrides it, missing row is created with defaults.

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

afterEach(async () => {
  delete process.env.FLOW_CONFIG;
  _resetFlowConfigForTests();
  await reseed(client);
});

after(() => {
  _resetFlowConfigForTests();
});

test("seed creates the flow row with defaults ({})", async () => {
  const row = await queryGet<{ value: unknown }>(client.db, sql`SELECT value FROM warehouse_config WHERE key = 'flow'`);
  assert.deepEqual(row?.value, {});
  await loadFlowConfig(client.db);
  assert.equal(isStepEnabled("put-away"), true);
  assert.equal(allowDockStock(), true);
  assert.deepEqual(putAwayConfig(), { autoCreateTasks: false, suggestShelf: "existing-stock" });
});

test("DB row drives the active config", async () => {
  await client.db.execute(sql`
    UPDATE warehouse_config SET value = '{"steps":{"put-away":{"autoCreateTasks":true},"picking":{"allocation":{"allowDockStock":false}}}}'
    WHERE key = 'flow'`);
  await loadFlowConfig(client.db);
  assert.equal(allowDockStock(), false);
  assert.equal(putAwayConfig().autoCreateTasks, true);
  assert.equal(isStepEnabled("picking"), true); // unset keys keep defaults
});

test("FLOW_CONFIG env wins over the DB row", async () => {
  await client.db.execute(sql`
    UPDATE warehouse_config SET value = '{"steps":{"picking":{"allocation":{"allowDockStock":false}}}}'
    WHERE key = 'flow'`);
  process.env.FLOW_CONFIG = '{"steps":{"picking":{"allocation":{"allowDockStock":true}}}}';
  await loadFlowConfig(client.db);
  assert.equal(allowDockStock(), true); // env value, not the DB value
});

test("missing row is created with defaults on load", async () => {
  await client.db.execute(sql`DELETE FROM warehouse_config WHERE key = 'flow'`);
  await loadFlowConfig(client.db);
  assert.equal(allowDockStock(), true);
  const row = await queryGet<{ value: unknown }>(client.db, sql`SELECT value FROM warehouse_config WHERE key = 'flow'`);
  assert.deepEqual(row?.value, {});
});

test("invalid DB row fails the load (fail-fast at boot)", async () => {
  await client.db.execute(sql`
    UPDATE warehouse_config SET value = '{"steps":{"put-away":{"enabled":false},"picking":{"allocation":{"allowDockStock":false}}}}'
    WHERE key = 'flow'`);
  await assert.rejects(loadFlowConfig(client.db), /could never become allocatable/);
});

test("legacy FLOW_STEPS_DISABLED disables steps on top of the DB row", async () => {
  process.env.FLOW_STEPS_DISABLED = "measuring,verify";
  try {
    await loadFlowConfig(client.db); // DB row is {} from the seed
    assert.equal(isStepEnabled("measuring"), false);
    assert.equal(isStepEnabled("verify"), false);
    assert.equal(isStepEnabled("picking"), true);
  } finally {
    delete process.env.FLOW_STEPS_DISABLED;
  }
});
