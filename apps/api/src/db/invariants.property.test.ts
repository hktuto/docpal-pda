import { test } from "node:test";
import { createTestDb } from "./test-helper.js";
import {
  applyReceipt, applyPick, applyPutAway,
  createAllocation, deleteAllocation,
  scanToPackage, assignPackageToBox,
} from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
type TestSql = TestDb["sql"];

let testSql: TestSql | undefined;

const SEED = 123456789;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function num(db: TestDb["db"], q: string) {
  return (await db.execute<{ v: number }>(q))[0]?.v ?? 0;
}

// computed on the fly now: rii availability and picking remaining qty.
const RII_AVAIL = (id: string) => `
  SELECT received_qty - picked_qty - put_away_qty
    - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS v
  FROM receiving_invoice_items rii WHERE id='${id}'`;
const PI_REMAINING = (id: string) => `
  SELECT qty - COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS v
  FROM picking_items pi WHERE id='${id}'`;

test(`randomized primitive sequence preserves invariants (seed=${SEED})`, async () => {
  const { sql, db } = await createTestDb();
  testSql = sql;

  const T0 = "2024-01-01T00:00:00Z";
  await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p0','A'),('p1','B'),('p2','C')`);
  for (let i = 0; i < 3; i++) {
    await db.execute(`INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro${i}','RR${i}','in_hand','${T0}','${T0}')`);
    await db.execute(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${i}','ro${i}','INV${i}','${T0}','${T0}')`);
    await db.execute(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty) VALUES ('rii${i}','ri${i}','p${i}',50,20)`);
    await db.execute(`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po${i}','RP${i}','picking','${T0}','${T0}')`);
    await db.execute(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${i}','po${i}','p${i}',15,'${T0}','${T0}')`);
    await db.execute(`INSERT INTO inventory_lots (id, part_id, total_qty) VALUES ('lot${i}','p${i}',10)`);
    await db.execute(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box${i}','po${i}','open','${T0}','${T0}')`);
  }

  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);
  const pick = <T>(a: T[]) => a[ri(a.length)]!;

  const liveAlloc: string[] = [];
  const unboxed: { id: string; box: string }[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;

  for (let step = 0; step < 300; step++) {
    const op = ri(8);
    try {
      if (op === 0) {
        await applyReceipt(db, pick(["rii0", "rii1", "rii2"]), ri(5) + 1);
      } else if (op === 1) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = await num(db, RII_AVAIL(id));
        if (av > 0) await applyPick(db, id, ri(Math.min(3, av)) + 1);
      } else if (op === 2) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = await num(db, RII_AVAIL(id));
        if (av > 0) await applyPutAway(db, id, ri(Math.min(3, av)) + 1);
      } else if (op === 3) {
        const i = ri(3);
        const prem = await num(db, PI_REMAINING(`pi${i}`));
        const lav = await num(db, `SELECT available_qty AS v FROM inventory_lots WHERE id='lot${i}'`);
        const q = Math.min(prem, lav, 3);
        if (q > 0) { const id = nextId("a"); await createAllocation(db, { id, pickingItemId: `pi${i}`, qty: ri(q) + 1, inventoryLotId: `lot${i}` }); liveAlloc.push(id); }
      } else if (op === 4) {
        const i = ri(3);
        const prem = await num(db, PI_REMAINING(`pi${i}`));
        const rav = await num(db, RII_AVAIL(`rii${i}`));
        const q = Math.min(prem, rav, 3);
        if (q > 0) {
          const id = nextId("a");
          await createAllocation(db, { id, pickingItemId: `pi${i}`, qty: ri(q) + 1, receivingInvoiceItemId: `rii${i}` });
          liveAlloc.push(id);
        }
      } else if (op === 5) {
        if (liveAlloc.length > 0) { const id = liveAlloc.splice(ri(liveAlloc.length), 1)[0]!; await deleteAllocation(db, id); }
      } else if (op === 6) {
        const i = ri(3);
        const prem = await num(db, PI_REMAINING(`pi${i}`));
        if (prem > 0) { const id = nextId("pp"); await scanToPackage(db, { id, pickingItemId: `pi${i}`, qty: ri(Math.min(2, prem)) + 1, sourceType: "inventory_lot", sourceId: `lot${i}` }); unboxed.push({ id, box: `box${i}` }); }
      } else {
        if (unboxed.length > 0) { const p = unboxed.splice(ri(unboxed.length), 1)[0]!; await assignPackageToBox(db, { packageId: p.id, shippingBoxId: p.box }); }
      }
      await assertInvariantsHold(db);
    } catch (e) {
      throw new Error(`failed at step ${step} op=${op} (seed=${SEED}): ${(e as Error).message}`);
    }
  }
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (testSql) await testSql.end();
});
