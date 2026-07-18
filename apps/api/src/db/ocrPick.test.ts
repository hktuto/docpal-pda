import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import { applyOcrPick } from "./ocrPick.js";
import { allocatePickingItem } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

let lastSql: any;

async function makeDb() {
  if (lastSql) await lastSql.end();
  const { sql, db } = await createTestDb();
  lastSql = sql;
  await db.execute(`
    INSERT INTO users (id, username, password_hash, role, display_name, created_at)
      VALUES ('op8','op8','h','operator','Op8',now());
    INSERT INTO suppliers (id, code, name) VALUES ('sup8','SUP8','Sup 8');
    INSERT INTO parts (id, part_no) VALUES
      ('p8','P8'),
      ('p8other','P8OTHER');
    INSERT INTO receiving_orders (id, ref_no, delivery_date, status, supplier_id, created_at, updated_at) VALUES
      ('ro8','R8','2026-07-01','in_hand','sup8',now(),now()),
      ('ro8b','R8B','2026-07-02','pending','sup8',now(),now()),
      ('ro8c','R8C','2026-07-03','in_hand','sup8',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('inv8a','ro8','INV8A',now(),now()),
      ('inv8b','ro8','INV8B',now(),now()),
      ('inv8p','ro8b','INV8P',now(),now()),
      ('inv8c','ro8c','INV8C',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code) VALUES
      ('rii8a','inv8a','p8',6,6,'D1'),
      ('rii8b','inv8b','p8',6,6,'D2'),
      ('rii8p','inv8p','p8',6,6,'D1'),
      ('rii8c','inv8c','p8',5,5,'D1');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES
      ('po8','PR8','pending',now(),now()),
      ('po8c','PR8C','pending',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('pi8','po8','p8',10,now(),now()),
      ('pi8b','po8','p8other',10,now(),now()),
      ('pi8c','po8c','p8',20,now(),now());
  `);
  return { sql, db };
}

// rii availability is computed on the fly: received − picked − put_away − Σ allocations.
function riiAvailSql(ids: string) {
  return `
    SELECT id, picked_qty,
      received_qty - picked_qty - put_away_qty
        - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS available_qty
    FROM receiving_invoice_items rii WHERE id IN (${ids}) ORDER BY id`;
}

// unboxed (was scanned_not_boxed_qty) and remaining (was remaining_qty) are computed.
async function pickProgress(db: any, itemId: string) {
  const row = (await db.execute<{ picked_qty: number; unboxed: number; remaining: number }>(sql`
    SELECT pi.picked_qty,
      COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL), 0) AS unboxed,
      pi.qty - COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS remaining
    FROM picking_items pi WHERE pi.id = ${itemId}`))[0];
  return row;
}

test("ocr pick allocates FIFO across invoice items, scans one package per allocation, flips order to picking", async () => {
  const { db } = await makeDb();
  const res = await db.transaction(async (tx) =>
    applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 8, actorId: "op8" })
  );
  assert.equal(res.packageIds.length, 2); // 6 from rii8a + 2 from rii8b

  const pkgs = await db.execute<{
    source_type: string;
    source_id: string;
    qty: number;
    date_code: string | null;
    shipping_box_id: string | null;
  }>("SELECT source_type, source_id, qty, date_code, shipping_box_id FROM picking_packages ORDER BY source_id");
  assert.deepEqual(Array.from(pkgs), [
    { source_type: "receiving_invoice_item", source_id: "rii8a", qty: 6, date_code: "D1", shipping_box_id: null },
    { source_type: "receiving_invoice_item", source_id: "rii8b", qty: 2, date_code: "D2", shipping_box_id: null },
  ]);

  // The single-level allocations were created for 8 and fully consumed by the scan.
  const allocs = await db.execute<{
    id: string;
    qty: number;
    inventory_lot_id: string | null;
    receiving_invoice_item_id: string | null;
  }>("SELECT id, qty, inventory_lot_id, receiving_invoice_item_id FROM allocations WHERE picking_item_id='pi8' ORDER BY receiving_invoice_item_id");
  assert.deepEqual(Array.from(allocs.map(({ qty, inventory_lot_id, receiving_invoice_item_id }) => ({ qty, inventory_lot_id, receiving_invoice_item_id }))), [
    { qty: 0, inventory_lot_id: null, receiving_invoice_item_id: "rii8a" },
    { qty: 0, inventory_lot_id: null, receiving_invoice_item_id: "rii8b" },
  ]);

  const riis = await db.execute<{ id: string; picked_qty: number; available_qty: number }>(riiAvailSql("'rii8a','rii8b'"));
  assert.deepEqual(Array.from(riis), [
    { id: "rii8a", picked_qty: 6, available_qty: 0 },
    { id: "rii8b", picked_qty: 2, available_qty: 4 },
  ]);

  assert.deepEqual(await pickProgress(db, "pi8"), { picked_qty: 0, unboxed: 8, remaining: 2 });

  assert.equal(
    (await db.execute<{ status: string }>("SELECT status FROM picking_orders WHERE id='po8'"))[0].status,
    "picking"
  );
  // one "scanned" log per scanned allocation portion + one order flip
  const logs = (
    await db.execute<{
      entity_type: string;
      from_state: string | null;
      to_state: string;
      actor_id: string | null;
    }>("SELECT entity_type, from_state, to_state, actor_id FROM transaction_logs")
  ).sort((a, b) => a.entity_type.localeCompare(b.entity_type));
  assert.deepEqual(Array.from(logs), [
    { entity_type: "picking_item", from_state: "picking", to_state: "scanned", actor_id: "op8" },
    { entity_type: "picking_item", from_state: "picking", to_state: "scanned", actor_id: "op8" },
    { entity_type: "picking_order", from_state: "pending", to_state: "picking", actor_id: "op8" },
  ]);
  await assertInvariantsHold(db);
});

test("second ocr pick tops up the existing allocation row instead of creating a new one", async () => {
  const { db } = await makeDb();
  await db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 8, actorId: "op8" }));
  const before = (await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM allocations"))[0].c;
  const res = await db.transaction(async (tx) =>
    applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 2, actorId: "op8" })
  );
  assert.equal(res.packageIds.length, 1); // 2 from rii8b
  const after = (await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM allocations"))[0].c;
  assert.equal(after, before);

  const pkg = (await db.execute<{ source_id: string; qty: number }>(
    sql`SELECT source_id, qty FROM picking_packages WHERE id = ${res.packageIds[0]}`
  ))[0];
  assert.deepEqual(pkg, { source_id: "rii8b", qty: 2 });
  assert.deepEqual(await pickProgress(db, "pi8"), { picked_qty: 0, unboxed: 10, remaining: 0 });
  const rii = (await db.execute<{ picked_qty: number; available_qty: number }>(riiAvailSql("'rii8b'")))[0];
  assert.deepEqual(rii, { id: "rii8b", picked_qty: 4, available_qty: 2 });
  await assertInvariantsHold(db);
});

test("ocr pick rejects qty beyond the remaining picking need with 409", async () => {
  const { db } = await makeDb();
  await db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 10, actorId: "op8" }));
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
});

test("ocr pick guards: part not on RO 409, qty 0 400, unknown picking item 404, RO not in_hand 409", async () => {
  const { db } = await makeDb();
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8b", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 0, actorId: "op8" })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8", { pickingItemId: "nope", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8b", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "nope", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 404
  );
  // Guards must not mutate state.
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM picking_packages"))[0].c, 0);
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM allocations"))[0].c, 0);
  await assertInvariantsHold(db);
});

test("ocr pick rejects qty beyond the RO's part-level availability with 409", async () => {
  const { db } = await makeDb();
  // ro8c has 5 available of p8; pi8c needs 20, so the remaining check passes but availability fails.
  await assert.rejects(
    async () => db.transaction(async (tx) => applyOcrPick(tx, "ro8c", { pickingItemId: "pi8c", qty: 6, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM picking_packages"))[0].c, 0);
  assert.equal(
    (await db.execute<{ status: string }>("SELECT status FROM picking_orders WHERE id='po8c'"))[0].status,
    "pending"
  );
  await assertInvariantsHold(db);
});

test("ocr pick succeeds when the item's own auto-allocation already drained the rii's computed availability", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p9','P9');
    INSERT INTO receiving_orders (id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
      VALUES ('ro9','R9','2026-07-04','in_hand','sup8',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv9','ro9','INV9',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code)
      VALUES ('rii9','inv9','p9',12,12,'D9');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po9','PR9','pending',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi9','po9','p9',10,now(),now());
  `);
  // The PUT route auto-allocates ingested orders; replicate that with the real allocator.
  await db.transaction(async (tx) => allocatePickingItem(tx, "pi9"));
  const drained = (await db.execute<{ available_qty: number }>(riiAvailSql("'rii9'")))[0];
  assert.deepEqual(drained, { id: "rii9", picked_qty: 0, available_qty: 2 });

  // Old formula (Σ available − staged = 2) would 409 here; the web formula
  // (physical 12 − reserved-by-others 0 − staged 0) must let it through.
  const res = await db.transaction(async (tx) =>
    applyOcrPick(tx, "ro9", { pickingItemId: "pi9", qty: 10, actorId: "op8" })
  );
  assert.equal(res.packageIds.length, 1);
  const pkg = (await db.execute<{
    source_type: string;
    source_id: string;
    qty: number;
    date_code: string | null;
  }>(sql`SELECT source_type, source_id, qty, date_code FROM picking_packages WHERE id = ${res.packageIds[0]}`))[0];
  assert.deepEqual(pkg, { source_type: "receiving_invoice_item", source_id: "rii9", qty: 10, date_code: "D9" });

  const alloc = (await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE picking_item_id='pi9'"))[0];
  assert.equal(alloc.qty, 0); // pre-existing allocation fully consumed, no top-up row
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM allocations"))[0].c, 1);
  const rii = (await db.execute<{ picked_qty: number; available_qty: number }>(riiAvailSql("'rii9'")))[0];
  assert.deepEqual(rii, { id: "rii9", picked_qty: 10, available_qty: 2 });
  assert.deepEqual(await pickProgress(db, "pi9"), { picked_qty: 0, unboxed: 10, remaining: 0 });
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (lastSql) await lastSql.end();
});
