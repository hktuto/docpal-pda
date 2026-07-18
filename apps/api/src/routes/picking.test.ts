import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const { sql, db } = await createTestDb();

test("PUT picking order runs allocation against existing in_hand receiving stock", async () => {
  await db.execute(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('pP','P','P','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','re','R','in_hand','2026-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii','ri','pP',100,100,100,'0','0');
  `);
  const res = await app.request("/picking-orders/PE-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { ref_no: "PO-1" }, items: [{ line_id: "L1", part_no: "P", qty: 30 }] }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { created: boolean; changed: boolean };
  assert.equal(body.created, true);

  const alloc = (await db.execute<{ qty: number; ro: string }>("SELECT qty, receiving_order_id AS ro FROM allocations"))[0];
  assert.equal(alloc.qty, 30);
  assert.equal(alloc.ro, "ro");
  const rii = (await db.execute<{ allocated_qty: number; available_qty: number }>("SELECT allocated_qty, available_qty FROM receiving_invoice_items WHERE id='rii'"))[0];
  assert.equal(rii.allocated_qty, 30);
  assert.equal(rii.available_qty, 70);
});

const post = (url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

await db.execute(`
  INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
    VALUES ('op7r','op7r','h','operator','Op7r','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p7r','P7R','P7R','0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES
    ('po7r1','e7r1','PO-7R1','pending','0','0'),
    ('po7r2','e7r2','PO-7R2','picking','0','0'),
    ('po7r3','e7r3','PO-7R3','finished','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
    ('pi7r1','po7r1','p7r',10,'0','0'),
    ('pi7r2','po7r2','p7r',10,'0','0');
`);

test("POST /picking-orders/report-issues reports pending/picking orders and skips finished ones", async () => {
  const res = await post("/picking-orders/report-issues", {
    picking_order_ids: ["po7r1", "po7r2", "po7r3"], reason: "insufficient_stock", qty: 5, remark: "short", actor_id: "op7r",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reported: string[]; skipped: string[] };
  assert.deepEqual(body.reported, ["po7r1", "po7r2"]);
  assert.deepEqual(body.skipped, ["po7r3"]);
  const row = (await db.execute<{
    status: string; issue_reason: string; issue_qty: number; issue_remark: string; issue_reported_by: string;
  }>("SELECT status, issue_reason, issue_qty, issue_remark, issue_reported_by FROM picking_orders WHERE id='po7r1'"))[0];
  assert.deepEqual(row, { status: "issue", issue_reason: "insufficient_stock", issue_qty: 5, issue_remark: "short", issue_reported_by: "op7r" });
});

test("POST /picking-orders/report-issues accepts reason 'other' (remark only, no qty/pack_size)", async () => {
  await db.execute(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po9o','e9o','PO-9O','pending','0','0')`);
  const res = await post("/picking-orders/report-issues", {
    picking_order_ids: ["po9o"], reason: "other", remark: "damaged label", actor_id: "op7r",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reported: string[]; skipped: string[] };
  assert.deepEqual(body.reported, ["po9o"]);
  const row = (await db.execute<{
    status: string; issue_reason: string; issue_qty: number | null; issue_pack_size: number | null; issue_remark: string;
  }>("SELECT status, issue_reason, issue_qty, issue_pack_size, issue_remark FROM picking_orders WHERE id='po9o'"))[0];
  assert.deepEqual(row, { status: "issue", issue_reason: "other", issue_qty: null, issue_pack_size: null, issue_remark: "damaged label" });
});

test("POST /picking-orders/report-issues validation: malformed JSON / actor_id / ids / reason -> 400", async () => {
  const badJson = await post("/picking-orders/report-issues", "{nope");
  assert.equal(badJson.status, 400);
  const noActor = await post("/picking-orders/report-issues", { picking_order_ids: ["po7r1"], reason: "merge" });
  assert.equal(noActor.status, 400);
  const emptyIds = await post("/picking-orders/report-issues", { picking_order_ids: [], reason: "merge", actor_id: "op7r" });
  assert.equal(emptyIds.status, 400);
  const nonArrayIds = await post("/picking-orders/report-issues", { picking_order_ids: "po7r1", reason: "merge", actor_id: "op7r" });
  assert.equal(nonArrayIds.status, 400);
  const unknownReason = await post("/picking-orders/report-issues", { picking_order_ids: ["po7r1"], reason: "bogus", actor_id: "op7r" });
  assert.equal(unknownReason.status, 400);
});

await db.execute(`
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p8r','P8R','P8R','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, created_at, updated_at)
    VALUES ('ro8r','e8r','R8R','2026-07-01','in_hand','0','0');
  INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv8r','ro8r','INV8R','0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, date_code, created_at, updated_at)
    VALUES ('rii8r','inv8r','p8r',8,8,8,'D8R','0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po8r','e8rp','PO-8R','pending','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi8r','po8r','p8r',5,'0','0');
`);

test("POST /picking-orders/:id/ocr-pick scans from the receiving order and returns package_ids", async () => {
  const res = await post("/picking-orders/ro8r/ocr-pick", { picking_item_id: "pi8r", qty: 5, actor_id: "op7r" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  const pkg = (await db.execute<{
    source_type: string; source_id: string; qty: number; date_code: string;
  }>("SELECT source_type, source_id, qty, date_code FROM picking_packages WHERE id = '" + body.package_ids[0] + "'"))[0];
  assert.deepEqual(pkg, { source_type: "receiving_invoice_item", source_id: "rii8r", qty: 5, date_code: "D8R" });
  const pi = (await db.execute<{ scanned_not_boxed_qty: number; remaining_qty: number }>("SELECT scanned_not_boxed_qty, remaining_qty FROM picking_items WHERE id='pi8r'"))[0];
  assert.deepEqual(pi, { scanned_not_boxed_qty: 5, remaining_qty: 0 });
  assert.equal((await db.execute<{ status: string }>("SELECT status FROM picking_orders WHERE id='po8r'"))[0].status, "picking");
});

test("POST /picking-orders/:id/ocr-pick requires picking_item_id -> 400", async () => {
  const res = await post("/picking-orders/ro8r/ocr-pick", { qty: 5, actor_id: "op7r" });
  assert.equal(res.status, 400);
});

test.after(async () => { await sql.end(); });
