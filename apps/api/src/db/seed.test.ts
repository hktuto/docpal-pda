import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb } from "./test-helper.js";
import { seedIfEmpty, resetAndReseed } from "./seed.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql, db } = await setupTestDb();

test("seedIfEmpty seeds demo data; allocations derived; invariants hold; idempotent", async () => {
  assert.equal(await seedIfEmpty(sql, db), true);
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM users`))[0].c, 2);
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM receiving_invoice_items`))[0].c, 264);
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM picking_orders`))[0].c, 23);
  const allocs = (await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM allocations`))[0].c;
  assert.ok(allocs >= 73, `expected >= 73 allocations, got ${allocs}`);
  assert.ok((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM allocation_receiving_items`))[0].c > 0);
  await assertInvariantsHold(db);
  assert.equal(await seedIfEmpty(sql, db), false);
});

test("resetAndReseed wipes and re-seeds", async () => {
  await seedIfEmpty(sql, db);
  await db.execute(`DELETE FROM transition_logs`);
  await resetAndReseed(sql, db);
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM receiving_orders`))[0].c, 1);
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM users`))[0].c, 2);
  await assertInvariantsHold(db);
});

test.after(async () => {
  await sql.end();
});
