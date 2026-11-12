// POST /admin/sequences/next (plan
// docs/superpowers/plans/2026-11-12-seq-counters.md): atomic contiguous
// blocks, lazy reset, seeded-keys-only.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { periodStartFor } from "../../db/sequences.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];

async function login(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function next(token: string, body: unknown) {
  return app.request("/admin/sequences/next", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
});

test("first issue starts at 1; later blocks continue contiguously", async () => {
  await reseed(client);
  const token = await login();

  const r1 = await next(token, { key: "custom_label_weekly_serial", count: 178 });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { key: "custom_label_weekly_serial", start: 1, count: 178 });

  const r2 = await next(token, { key: "custom_label_weekly_serial", count: 3 });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { key: "custom_label_weekly_serial", start: 179, count: 3 });
});

test("weekly counter: stale last_reset_on lazily resets to 1 and stamps the period start", async () => {
  await reseed(client);
  // Pretend the counter last ran over a month ago.
  await client.db.execute(
    sql`UPDATE seq_counters SET value = 100, last_reset_on = CURRENT_DATE - 30 WHERE key = 'custom_label_weekly_serial'`
  );
  const token = await login();

  const res = await next(token, { key: "custom_label_weekly_serial", count: 2 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: "custom_label_weekly_serial", start: 1, count: 2 });

  const rows = await client.db.execute(
    sql`SELECT last_reset_on::text AS lro, value FROM seq_counters WHERE key = 'custom_label_weekly_serial'`
  );
  const row = (rows as unknown as { lro: string; value: number }[])[0];
  assert.equal(row.lro, periodStartFor("weekly", 1, new Date(), null));
  assert.equal(row.value, 2);
});

test("first use stamps the anchor without resetting the value", async () => {
  await reseed(client);
  await client.db.execute(sql`UPDATE seq_counters SET value = 50 WHERE key = 'custom_label_weekly_serial'`);
  const token = await login();

  const res = await next(token, { key: "custom_label_weekly_serial", count: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: "custom_label_weekly_serial", start: 51, count: 1 });

  const rows = await client.db.execute(
    sql`SELECT last_reset_on::text AS lro FROM seq_counters WHERE key = 'custom_label_weekly_serial'`
  );
  assert.equal(
    (rows as unknown as { lro: string }[])[0].lro,
    periodStartFor("weekly", 1, new Date(), null)
  );
});

test("never-scheduled counter keeps counting; days-scheduled resets after N days", async () => {
  await reseed(client);
  await client.db.execute(sql`
    INSERT INTO seq_counters (id, key, value, reset_schedule, reset_interval, last_reset_on) VALUES
      ('seq-test-never', 'test_never', 40, 'never', NULL, NULL),
      ('seq-test-days', 'test_days', 7, 'days', 3, CURRENT_DATE - 10)`);
  const token = await login();

  const n1 = await next(token, { key: "test_never", count: 5 });
  assert.deepEqual(await n1.json(), { key: "test_never", start: 41, count: 5 });
  const n2 = await next(token, { key: "test_never", count: 5 });
  assert.deepEqual(await n2.json(), { key: "test_never", start: 46, count: 5 });

  const d1 = await next(token, { key: "test_days", count: 1 });
  assert.deepEqual(await d1.json(), { key: "test_days", start: 1, count: 1 });
});

test("unknown key 404s; bad payloads 400", async () => {
  await reseed(client);
  const token = await login();

  assert.equal((await next(token, { key: "nope", count: 1 })).status, 404);
  assert.equal((await next(token, { key: "custom_label_weekly_serial", count: 0 })).status, 400);
  assert.equal((await next(token, { key: "custom_label_weekly_serial", count: 10001 })).status, 400);
  assert.equal((await next(token, { key: "custom_label_weekly_serial", count: 1.5 })).status, 400);
  assert.equal((await next(token, { count: 1 })).status, 400);
  assert.equal((await next(token, { key: "  ", count: 1 })).status, 400);

  // Failed requests issue nothing.
  const res = await next(token, { key: "custom_label_weekly_serial", count: 1 });
  assert.deepEqual(await res.json(), { key: "custom_label_weekly_serial", start: 1, count: 1 });
});
