import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

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

test(`allocateAll preserves invariants over randomized stock (seed=${SEED})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);

  // 3 parts, a few shelf lots + receiving orders with mixed boxed/unboxed, several picking items.
  sqlite.exec(`INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p0','A','A','0','0'),('p1','B','B','0','0'),('p2','C','C','0','0');`);
  for (let p = 0; p < 3; p++) {
    for (let l = 0; l < 2; l++) {
      const tot = ri(8) + 1;
      sqlite.exec(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code_norm, created_at, updated_at) VALUES ('lot${p}_${l}','p${p}','S${l}',${tot},'20240${ri(9)}','2024-0${l + 1}-0${p + 1}T00:00:00Z','0');`);
    }
    for (let r = 0; r < 2; r++) {
      sqlite.exec(`INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro${p}_${r}','e${p}_${r}','R${p}${r}','in_hand','2024-0${r + 1}-15','0','0');`);
      sqlite.exec(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${p}_${r}','ro${p}_${r}','INV${p}${r}','0','0');`);
      const qty = ri(10) + 5;
      const boxed = ri(2) === 0;
      sqlite.exec(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, box_id, date_code, created_at, updated_at) VALUES ('rii${p}_${r}','ri${p}_${r}','p${p}',${qty},${qty},${qty},${boxed ? `'B${p}${r}'` : "NULL"},'202401','0','0');`);
    }
    for (let k = 0; k < 2; k++) {
      sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po${p}_${k}','ep${p}_${k}','RP${p}${k}','picking','2024-0${k + 1}-0${p + 1}T00:00:00Z','0');`);
      sqlite.exec(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${p}_${k}','po${p}_${k}','p${p}',${ri(12) + 1},'2024-0${k + 1}-0${p + 1}T00:00:00Z','0');`);
    }
  }

  try {
    for (let step = 0; step < 50; step++) {
      allocateAll(db);
      assertInvariantsHold(db);
    }
  } catch (e) {
    sqlite.close();
    throw new Error(`failed at step (seed=${SEED}): ${(e as Error).message}`);
  }
  sqlite.close();
});
