import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WAREHOUSE_SEED = "off";
const { app } = await import("./index.js");

test("GET /health returns ok with the database reachable", async () => {
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; db: string };
  assert.equal(body.ok, true);
  assert.equal(body.db, "ok");
});
