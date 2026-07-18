import { test } from "node:test";
import { createTestDb } from "./test-helper.js";
import { allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

type TestSql = Awaited<ReturnType<typeof createTestDb>>["sql"];

let testSql: TestSql | undefined;

const SEED = 987654321;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test(`allocateAll preserves invariants over randomized stock (seed=${SEED})`, async () => {
  const { sql, db } = await createTestDb();
  testSql = sql;
  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);

  const T0 = "2024-01-01T00:00:00Z";
  // 3 parts, a few shelf lots + receiving orders with mixed boxed/unboxed, several picking items.
  await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p0','A'),('p1','B'),('p2','C');`);
  await db.execute(`INSERT INTO shelves (code, created_at, updated_at) VALUES ('S0','${T0}','${T0}'),('S1','${T0}','${T0}');`);
  for (let p = 0; p < 3; p++) {
    for (let l = 0; l < 2; l++) {
      const tot = ri(8) + 1;
      await db.execute(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code) VALUES ('lot${p}_${l}','p${p}','S${l}',${tot},'20240${ri(9)}');`);
    }
    for (let r = 0; r < 2; r++) {
      await db.execute(`INSERT INTO receiving_orders (id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro${p}_${r}','R${p}${r}','in_hand','2024-0${r + 1}-15T00:00:00Z','${T0}','${T0}');`);
      await db.execute(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${p}_${r}','ro${p}_${r}','INV${p}${r}','${T0}','${T0}');`);
      const qty = ri(10) + 5;
      const boxed = ri(2) === 0;
      await db.execute(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, box_id, date_code) VALUES ('rii${p}_${r}','ri${p}_${r}','p${p}',${qty},${qty},${boxed ? `'B${p}${r}'` : "NULL"},'202401');`);
    }
    for (let k = 0; k < 2; k++) {
      await db.execute(`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po${p}_${k}','RP${p}${k}','picking','${T0}','${T0}');`);
      await db.execute(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${p}_${k}','po${p}_${k}','p${p}',${ri(12) + 1},'2024-0${k + 1}-0${p + 1}T00:00:00Z','${T0}');`);
    }
  }

  try {
    for (let step = 0; step < 50; step++) {
      await allocateAll(db);
      await assertInvariantsHold(db);
    }
  } catch (e) {
    throw new Error(`failed at step (seed=${SEED}): ${(e as Error).message}`);
  }
});

test.after(async () => {
  if (testSql) await testSql.end();
});
