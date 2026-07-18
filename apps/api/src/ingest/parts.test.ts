import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";
import { resolveOrCreatePart } from "./parts.js";
import { resolveSupplierId } from "./suppliers.js";

const { sql, db } = await createTestDb();

test.beforeEach(async () => {
  await db.execute(`TRUNCATE TABLE parts, suppliers CASCADE`);
});

test("resolveOrCreatePart creates a part with computed part_no_norm (O->0, I/L->1, Z->2, S->5)", async () => {
  const id = await db.transaction(async (tx) => resolveOrCreatePart(tx, "ABO-ILZ S", "Widget"));
  const row = (
    await db.execute<{ part_no: string; part_no_norm: string; description: string }>(
      `SELECT part_no, part_no_norm, description FROM parts WHERE id='${id}'`
    )
  )[0];
  assert.equal(row.part_no, "ABO-ILZ S");
  assert.equal(row.part_no_norm, "AB0-112 5");
  assert.equal(row.description, "Widget");
});

test("resolveOrCreatePart is idempotent on part_no_norm and backfills description", async () => {
  const a = await db.transaction(async (tx) => resolveOrCreatePart(tx, "X1", null));
  const b = await db.transaction(async (tx) => resolveOrCreatePart(tx, "XI", "Desc"));
  assert.equal(a, b);
  const count = (
    await db.execute<{ c: number }>(`SELECT COUNT(*)::int AS c FROM parts`)
  )[0].c;
  assert.equal(count, 1);
  const desc = (
    await db.execute<{ description: string | null }>(
      `SELECT description FROM parts WHERE id='${a}'`
    )
  )[0].description;
  assert.equal(desc, "Desc");
});

test("resolveOrCreatePart stores supplier_id on create and backfills it when null", async () => {
  await db.execute(
    `INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`
  );
  const a = await db.transaction(async (tx) => resolveOrCreatePart(tx, "P1", null));
  assert.equal(
    (
      await db.execute<{ supplier_id: string | null }>(
        `SELECT supplier_id FROM parts WHERE id='${a}'`
      )
    )[0].supplier_id,
    null
  );
  const b = await db.transaction(async (tx) => resolveOrCreatePart(tx, "P1", null, "s"));
  assert.equal(a, b);
  assert.equal(
    (
      await db.execute<{ supplier_id: string | null }>(
        `SELECT supplier_id FROM parts WHERE id='${a}'`
      )
    )[0].supplier_id,
    "s"
  );
  // a later call with a different supplier does NOT overwrite an existing one
  await db.execute(
    `INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s2','SUP2','S2','0','0')`
  );
  await db.transaction(async (tx) => resolveOrCreatePart(tx, "P1", null, "s2"));
  assert.equal(
    (
      await db.execute<{ supplier_id: string | null }>(
        `SELECT supplier_id FROM parts WHERE id='${a}'`
      )
    )[0].supplier_id,
    "s"
  );
  const c = await db.transaction(async (tx) => resolveOrCreatePart(tx, "P2", null, "s2"));
  assert.equal(
    (
      await db.execute<{ supplier_id: string | null }>(
        `SELECT supplier_id FROM parts WHERE id='${c}'`
      )
    )[0].supplier_id,
    "s2"
  );
});

test("resolveSupplierId returns id for known code, null for omitted, 400 for unknown code", async () => {
  await db.execute(
    `INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`
  );
  assert.equal(await db.transaction(async (tx) => resolveSupplierId(tx, "SUP")), "s");
  assert.equal(await db.transaction(async (tx) => resolveSupplierId(tx, null)), null);
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => resolveSupplierId(tx, "NOPE"));
    },
    (e: any) => e.status === 400
  );
});

test.after(async () => {
  await sql.end();
});
