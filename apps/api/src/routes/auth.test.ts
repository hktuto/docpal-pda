import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const { sql, db } = await createTestDb();

await db.execute(`
  INSERT INTO users (id, username, password_hash, role, display_name, created_at)
  VALUES ('u1','operator','DocPal2026!','operator','Operator','2026-01-01T00:00:00.000Z');
`);

test("POST /auth/login returns the user on correct password; 401 on wrong; 401 unknown user", async () => {
  const ok = await app.request("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: "u1", username: "operator", displayName: "Operator", role: "operator" });

  const bad = await app.request("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "nope" }),
  });
  assert.equal(bad.status, 401);

  const missing = await app.request("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ghost", password: "x" }),
  });
  assert.equal(missing.status, 401);

  const malformed = await app.request("/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(malformed.status, 400);
});

test("GET /auth/users/:id returns the user; 404 unknown", async () => {
  const res = await app.request("/auth/users/u1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "u1", username: "operator", displayName: "Operator", role: "operator" });
  assert.equal((await app.request("/auth/users/nope")).status, 404);
});

test.after(async () => {
  await sql.end();
  const { sql: appSql } = await import("../db.js");
  await appSql.end();
});
