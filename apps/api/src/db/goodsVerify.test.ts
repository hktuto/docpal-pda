import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb, TEST_DATABASE_URL } from "./test-helper.js";
import { resetTables } from "./tables.js";
import { verifyShelfBoxItem } from "./putAway.js";
import { assertInvariantsHold } from "./invariants.guard.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");

const { sql: testSql, db } = await createTestDb();

const TS = "2026-01-01T00:00:00.000Z";

test.beforeEach(async () => {
  await resetTables(db);
});

async function seedBase() {
  await db.execute(sql`INSERT INTO users (id, username, password_hash, display_name, role, created_at)
    VALUES ('u1','op','pw','Op','operator',${TS})`);
  await db.execute(sql`INSERT INTO suppliers (id, code, name) VALUES ('sup','S','Sup')`);
  await db.execute(sql`INSERT INTO parts (id, part_no) VALUES ('p','X'), ('p2','Y')`);
  await db.execute(sql`INSERT INTO shelves (code, location_type, created_at, updated_at)
    VALUES ('A1','shelf',${TS},${TS}), ('B1','shelf',${TS},${TS})`);
  await db.execute(sql`INSERT INTO receiving_orders (id, ref_no, status, supplier_id, created_at, updated_at)
    VALUES ('ro','RO-1','in_hand','sup',${TS},${TS})`);
  await db.execute(sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv','ro','INV-1','sup',${TS},${TS})`);
  await db.execute(sql`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
    VALUES ('rii','inv','p',5,5), ('rii2','inv','p2',3,3)`);
  await db.execute(sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
    VALUES ('box','ro','A1','closed',${TS})`);
  await db.execute(sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_id, qty, verified)
    VALUES ('sbi1','box','rii','p',5,false), ('sbi2','box','rii2','p2',3,false)`);
}

test("verifyShelfBoxItem verifies only the given part's scans in the box", async () => {
  await seedBase();
  await db.transaction(async (tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p", actorId: "u1" }));
  assert.equal((await db.execute<{ verified: boolean }>(sql`SELECT verified FROM shelf_box_items WHERE id='sbi1'`))[0].verified, true);
  assert.equal((await db.execute<{ verified: boolean }>(sql`SELECT verified FROM shelf_box_items WHERE id='sbi2'`))[0].verified, false);
  await assertInvariantsHold(db);
});

test("verifyShelfBoxItem 404s when the part has no unverified scans in the box", async () => {
  await seedBase();
  await assert.rejects(
    () => db.transaction(async (tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "nope" })),
    (e: any) => e.status === 404
  );
});

test("POST /shelf-boxes/:id/verify-item marks scans verified", async () => {
  await seedBase();
  const res = await app.request("/shelf-boxes/box/verify-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part_id: "p", actor_id: "u1" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.verified_count, 1);
});

test("GET shelf browse endpoints (shelves, with-box-counts, shelf boxes, box detail)", async () => {
  await seedBase();
  await db.execute(sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
    VALUES ('gvbox','ro','B1','closed',${TS})`);
  await db.execute(sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_id, qty, verified, verified_at)
    VALUES ('gvpas','gvbox','rii', 'p',2,true,${TS})`);

  const shelvesRes = await app.request("/shelves");
  assert.equal(shelvesRes.status, 200);
  const shelves = (await shelvesRes.json()) as any[];
  const codes = shelves.map((s) => s.code);
  assert.ok(codes.includes("A1") && codes.includes("B1"));

  const countsRes = await app.request("/shelves/with-box-counts");
  assert.equal(countsRes.status, 200);
  const counts = (await countsRes.json()) as any[];
  assert.equal(counts.find((r) => r.code === "B1").box_count, 1);
  assert.ok(counts.find((r) => r.code === "A1").box_count >= 1);

  const boxesRes = await app.request("/shelves/B1/boxes");
  assert.equal(boxesRes.status, 200);
  const boxes = (await boxesRes.json()) as any[];
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].id, "gvbox");
  assert.equal(boxes[0].item_count, 1);
  assert.equal(boxes[0].verified_count, 1);
  assert.equal(boxes[0].checked_today, false);

  const detailRes = await app.request("/shelf-boxes/gvbox");
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as any;
  assert.equal(detail.id, "gvbox");
  assert.deepEqual(detail.shelf, { code: "B1", zone: null });
  assert.deepEqual(detail.receiving_order, { id: "ro", ref_no: "RO-1" });
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].part_no, "X");
  assert.equal(detail.items[0].qty, 2);
  assert.equal(detail.items[0].verified, true);

  const missingRes = await app.request("/shelf-boxes/nope");
  assert.equal(missingRes.status, 404);
});

test.after(async () => {
  await testSql.end();
  const { sql: appSql } = await import("../db.js");
  await appSql.end();
});
