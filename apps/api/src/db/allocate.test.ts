import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb } from "./test-helper.js";
import { allocatePickingItem, allocatePickingOrder, allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql, db } = await setupTestDb();

const T0 = "2024-01-01T00:00:00Z";

async function makeDb() {
  await setupTestDb();
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking','${T0}','${T0}');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'${T0}','${T0}');
  `);
  return { db };
}

test("Phase 1 consumes on-shelf lots in date_code (FEFO) order", async () => {
  const { db } = await makeDb();
  // shelf_code IS NOT NULL = on-shelf. available generated = total - allocated (allocated defaults 0).
  // inventory_lots has no created_at anymore: order is date_code ASC NULLS LAST, id ASC.
  await db.execute(`
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1','${T0}','${T0}');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code) VALUES
      ('lotNew','p','S1',4,'202401'),
      ('lotOld','p','S1',3,'202312'),
      ('lotRecv','p',NULL,99,'202001');
  `);
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });

  const allocs = await db.execute<{ lot: string | null; qty: number }>(`
    SELECT inventory_lot_id AS lot, qty FROM allocations WHERE picking_item_id='pi'
  `);
  // need=10; Phase1 order: lotOld (date 202312) qty3, then lotNew (202401) qty4 → 7; lotRecv is shelf_code NULL → excluded.
  const sorted = Array.from(allocs).sort((a, b) => a.qty - b.qty);
  assert.deepEqual(sorted, [{ lot: "lotOld", qty: 3 }, { lot: "lotNew", qty: 4 }]);
  await assertInvariantsHold(db);
});

test("Phase 2 consumes receiving orders by delivery_date FIFO, invoice_no, date_code", async () => {
  const { db } = await makeDb();
  // Two in_hand receiving orders for part 'p', no shelf stock. roLate delivered later, roEarly earlier.
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, delivery_date, created_at, updated_at) VALUES
      ('roLate','RL','in_hand','2024-06-01T00:00:00Z','${T0}','${T0}'),
      ('roEarly','RE','in_hand','2024-01-01T00:00:00Z','${T0}','${T0}');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riLate','roLate','INV-L','${T0}','${T0}'),
      ('riEarly','roEarly','INV-E','${T0}','${T0}');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code) VALUES
      ('riiLate','riLate','p',100,100,'202402'),
      ('riiEarly','riEarly','p',4,4,'202401');
  `);
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });

  // need=10; no shelf; Phase2 order: roEarly (delivery 2024-01-01) fills 4 from riiEarly, then roLate fills 6 from riiLate.
  // Single-level allocations: one row per rii source.
  const a = await db.execute<{ rii: string | null; qty: number }>(`
    SELECT receiving_invoice_item_id AS rii, qty FROM allocations WHERE picking_item_id='pi'
  `);
  const sorted = Array.from(a).sort((x, y) => x.qty - y.qty);
  assert.deepEqual(sorted, [{ rii: "riiEarly", qty: 4 }, { rii: "riiLate", qty: 6 }]);
  await assertInvariantsHold(db);
});

test("within one receiving order: boxed rows allocate first, then unboxed row-by-row", async () => {
  const { db } = await makeDb();
  // One in_hand order with part 'p' spread across two invoices: one boxed item (box 'B1' qty 3) and two unboxed items (qty 2 + 2).
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','R','in_hand','2024-01-01T00:00:00Z','${T0}','${T0}');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riA','ro','A','${T0}','${T0}'),('riB','ro','B','${T0}','${T0}');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, box_id, date_code) VALUES
      ('riiBox','riA','p',3,3,'B1','202401'),
      ('riiU1','riA','p',2,2,NULL,'202401'),
      ('riiU2','riB','p',2,2,NULL,'202401');
  `);
  // Cap demand at 6 so take order is observable: boxed riiBox (3) first, then unboxed riiU1 (2, invoice A), then riiU2 (1 of 2, invoice B).
  await db.execute(`UPDATE picking_items SET qty = 6 WHERE id = 'pi'`);
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });

  const allocs = await db.execute<{ rii: string | null; qty: number }>(`
    SELECT receiving_invoice_item_id AS rii, qty FROM allocations WHERE picking_item_id='pi'
  `);
  const sorted = Array.from(allocs).sort((a, b) => (a.rii ?? "").localeCompare(b.rii ?? ""));
  assert.deepEqual(sorted, [
    { rii: "riiBox", qty: 3 },
    { rii: "riiU1", qty: 2 },
    { rii: "riiU2", qty: 1 },
  ]);
  await assertInvariantsHold(db);
});

test("re-running allocatePickingItem releases and re-plans to the same result", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1','${T0}','${T0}');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty) VALUES ('lot','p','S1',6);
    INSERT INTO receiving_orders (id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','R','in_hand','2024-01-01T00:00:00Z','${T0}','${T0}');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','${T0}','${T0}');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty) VALUES ('rii','ri','p',10,10);
  `);
  const plan = () =>
    db.execute<{ lot: string | null; rii: string | null; qty: number }>(`
      SELECT inventory_lot_id AS lot, receiving_invoice_item_id AS rii, qty FROM allocations WHERE picking_item_id='pi'
    `).then((rows) => Array.from(rows).sort((a, b) => (a.lot ?? a.rii ?? "").localeCompare(b.lot ?? b.rii ?? "")));
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });
  const first = await plan();
  // Run again — must release prior allocations and produce an identical plan (no double-allocate).
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });
  const second = await plan();
  assert.deepEqual(second, first);
  // need=10: shelf lot 6 + receiving 4.
  assert.deepEqual(second, [{ lot: "lot", rii: null, qty: 6 }, { lot: null, rii: "rii", qty: 4 }]);
  const pi = (await db.execute<{ allocated_qty: number }>(`SELECT allocated_qty FROM picking_items WHERE id='pi'`))[0];
  assert.equal(pi.allocated_qty, 10);
  await assertInvariantsHold(db);
});

test("allocatePickingItem with no remaining demand releases allocations and plans nothing", async () => {
  const { db } = await makeDb();
  // Pre-allocate fully via a first run, then drop the remaining demand to 0 by boxing a full package.
  await db.execute(`
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1','${T0}','${T0}');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty) VALUES ('lot','p','S1',10);
  `);
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });
  assert.equal((await db.execute<{ c: number }>(`SELECT count(*)::int c FROM allocations WHERE picking_item_id='pi'`))[0].c, 1);
  // Fully boxed package: need = qty - Σ ALL packages = 0 → allocations are released.
  await db.execute(`
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','${T0}','${T0}');
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pkg','pi','po','inventory_lot','lot',10,'box','${T0}','${T0}');
  `);
  await db.transaction(async (tx) => {
    await allocatePickingItem(tx, "pi");
  });
  assert.equal((await db.execute<{ c: number }>(`SELECT count(*)::int c FROM allocations WHERE picking_item_id='pi'`))[0].c, 0);
  await assertInvariantsHold(db);
});

test("allocatePickingOrder plans every item of the order; allocateAll plans all remaining demand oldest-first", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p2','Y');
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1','${T0}','${T0}');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po2','R2','picking','${T0}','${T0}');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('piOld','po','p',5,'2024-02-01T00:00:00Z','${T0}'),
      ('piNew','po2','p2',4,'2024-02-01T00:00:00Z','${T0}');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty) VALUES
      ('lotP','p','S1',3),
      ('lotP2','p2','S1',10);
  `);
  // po has two items now: 'pi' (qty10 from makeDb, part p, created 2024-01-01) and 'piOld' (qty5, part p, created 2024-02-01). allocatePickingOrder plans both of po's items only.
  await allocatePickingOrder(db, "po");
  // Order is by picking_items.created_at: 'pi' (2024-01-01) < 'piOld' (2024-02-01), so 'pi' consumes lotP(3) first.
  const piAlloc = (await db.execute<{ allocated_qty: number }>(`SELECT allocated_qty FROM picking_items WHERE id='pi'`))[0];
  assert.equal(piAlloc.allocated_qty, 3);
  const piOldAlloc = (await db.execute<{ allocated_qty: number }>(`SELECT allocated_qty FROM picking_items WHERE id='piOld'`))[0];
  assert.equal(piOldAlloc.allocated_qty, 0);
  // po2 / piNew untouched by allocatePickingOrder('po'):
  assert.equal((await db.execute<{ c: number }>(`SELECT count(*)::int c FROM allocations WHERE picking_item_id='piNew'`))[0].c, 0);

  // Now global replan across all remaining demand.
  await allocateAll(db);
  await assertInvariantsHold(db);
  // piNew (part p2) now allocated from lotP2.
  assert.equal((await db.execute<{ allocated_qty: number }>(`SELECT allocated_qty FROM picking_items WHERE id='piNew'`))[0].allocated_qty, 4);
});

test.after(async () => {
  await sql.end();
});
