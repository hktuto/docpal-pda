import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import {
  applyReceipt, applyPick, applyPutAway,
  createAllocation, linkAllocation, deleteAllocation,
  scanToPackage, assignPackageToBox,
} from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

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

test(`randomized primitive sequence preserves invariants (seed=${SEED})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES
      ('p0','A','A','0','0'),('p1','B','B','0','0'),('p2','C','C','0','0');
  `);
  for (let i = 0; i < 3; i++) {
    sqlite.exec(`
      INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro${i}','er${i}','RR${i}','in_hand','0','0');
      INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${i}','ro${i}','INV${i}','0','0');
      INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at) VALUES ('rii${i}','ri${i}','p${i}',50,20,20,'0','0');
      INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po${i}','ep${i}','RP${i}','picking','0','0');
      INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${i}','po${i}','p${i}',15,'0','0');
      INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot${i}','p${i}',10,'0','0');
      INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box${i}','po${i}','open','0','0');
    `);
  }

  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);
  const pick = <T>(a: T[]) => a[ri(a.length)]!;
  const num = (sqlite: any, q: string) => (sqlite.prepare(q).get() as any)?.v ?? 0;

  const liveAlloc: string[] = [];
  const unboxed: { id: string; box: string }[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;

  for (let step = 0; step < 300; step++) {
    const op = ri(8);
    try {
      if (op === 0) {
        applyReceipt(db, pick(["rii0", "rii1", "rii2"]), ri(5) + 1);
      } else if (op === 1) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='${id}'`);
        if (av > 0) applyPick(db, id, ri(Math.min(3, av)) + 1);
      } else if (op === 2) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='${id}'`);
        if (av > 0) applyPutAway(db, id, ri(Math.min(3, av)) + 1, null);
      } else if (op === 3) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        const lav = num(sqlite, `SELECT available_qty AS v FROM inventory_lots WHERE id='lot${i}'`);
        const q = Math.min(prem, lav, 3);
        if (q > 0) { const id = nextId("a"); createAllocation(db, { id, pickingItemId: `pi${i}`, qty: ri(q) + 1, inventoryLotId: `lot${i}` }); liveAlloc.push(id); }
      } else if (op === 4) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        const rav = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='rii${i}'`);
        const q = Math.min(prem, rav, 3);
        if (q > 0) {
          const id = nextId("a"); const qty = ri(q) + 1;
          createAllocation(db, { id, pickingItemId: `pi${i}`, qty, receivingOrderId: `ro${i}` });
          linkAllocation(db, { id: nextId("l"), allocationId: id, receivingInvoiceItemId: `rii${i}`, qty });
          liveAlloc.push(id);
        }
      } else if (op === 5) {
        if (liveAlloc.length > 0) { const id = liveAlloc.splice(ri(liveAlloc.length), 1)[0]!; deleteAllocation(db, id); }
      } else if (op === 6) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        if (prem > 0) { const id = nextId("pp"); scanToPackage(db, { id, pickingItemId: `pi${i}`, qty: ri(Math.min(2, prem)) + 1, sourceType: "inventory_lot", sourceId: `lot${i}` }); unboxed.push({ id, box: `box${i}` }); }
      } else {
        if (unboxed.length > 0) { const p = unboxed.splice(ri(unboxed.length), 1)[0]!; assignPackageToBox(db, { packageId: p.id, shippingBoxId: p.box }); }
      }
      assertInvariantsHold(db);
    } catch (e) {
      sqlite.close();
      throw new Error(`failed at step ${step} op=${op} (seed=${SEED}): ${(e as Error).message}`);
    }
  }
  assertInvariantsHold(db);
  sqlite.close();
});
