// Put-back queue (spec docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// Tasks are created by the cancel-invoice ingest (covered in cancelInvoice.test.ts);
// this file seeds them directly and covers list scoping + completion crediting.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { completePutBackTask, getPutBackTaskDetail, listPutBackTasks } from "./putback.js";

let client: TestDb;
let actorId = "";

before(async () => {
  client = await setupTestDb();
});
after(async () => {
  await client.sql.end({ timeout: 1 });
});
beforeEach(async () => {
  await reseed(client);
  actorId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`))!.id;
});

async function throws(fn: () => Promise<unknown>): Promise<HTTPException> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err as HTTPException;
  }
  assert.fail("expected HTTPException");
}

/** One lot with stock to anchor the fixtures (never hardcoded seed values). */
async function seedLot() {
  const lot = await queryGet<{ id: string; partNo: string; wclItemNo: string | null; shelfCode: string; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; orgId: number; subInventoryCode: string; totalQty: number }>(
    client.db,
    sql`SELECT id, part_no AS "partNo", wcl_item_no AS "wclItemNo", shelf_code AS "shelfCode",
               date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode", total_qty AS "totalQty"
        FROM inventory_lots WHERE total_qty > 0 LIMIT 1`
  );
  assert.ok(lot, "seed world should contain stocked lots");
  return lot!;
}

/** Order + item + package + pending task with one item. `shelf` = task-item
 *  source shelf (null = dock-sourced, needs the fallback shelf on complete). */
async function seedTask(lot: Awaited<ReturnType<typeof seedLot>>, opts: { shelf: string | null; assignee?: string | null }) {
  const orderId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, org_id, sub_inventory_code, created_date, last_update_date)
        VALUES (${orderId}, 'PB-TEST-01', 'cancelled', ${lot.orgId}, ${lot.subInventoryCode}, now(), now())`
  );
  const itemId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, picked_qty, status, created_date, last_update_date)
        VALUES (${itemId}, ${orderId}, ${lot.partNo}, 10, 10, 'cancelled', now(), now())`
  );
  const pkgId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
        VALUES (${pkgId}, ${itemId}, ${orderId}, 'inventory_lot', ${lot.id}, 10, now(), now())`
  );
  const taskId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO put_back_tasks (id, cancel_source, cancel_source_id, picking_order_id, picking_item_id, status, assignee, created_date, last_update_date)
        VALUES (${taskId}, 'cancel_invoice', ${randomUUID()}, ${orderId}, '', 'pending', ${opts.assignee ?? null}, now(), now())`
  );
  const taskItemId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO put_back_task_items (id, put_back_task_id, picking_package_id, part_no, wcl_item_no, qty,
            date_code, lot_code, coo, cow, shelf_code, org_id, sub_inventory_code, status, created_date, last_update_date)
        VALUES (${taskItemId}, ${taskId}, ${pkgId}, ${lot.partNo}, ${lot.wclItemNo}, 10,
            ${lot.dateCode}, ${lot.lotCode}, ${lot.coo}, ${lot.cow}, ${opts.shelf}, ${lot.orgId}, ${lot.subInventoryCode},
            'pending', now(), now())`
  );
  return { taskId, taskItemId, pkgId, orderId };
}

test("complete: credits the source lot, ADJUST ledger, item + task close; double complete 409", async () => {
  const lot = await seedLot();
  const { taskId, taskItemId } = await seedTask(lot, { shelf: lot.shelfCode });

  const res = await completePutBackTask(client.db, { taskId, actorId });
  assert.equal(res.itemsCredited, 1);
  assert.equal(res.totalQty, 10);

  const after = await queryGet<{ totalQty: number }>(client.db, sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE id = ${lot.id}`);
  assert.equal(after!.totalQty, lot.totalQty + 10);
  const ledger = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM inventory_transactions
        WHERE txn_type = 'ADJUST' AND qty_type = 'on_hand' AND txn_reason = 'cancel put-back' AND reference_id = ${taskId}`
  );
  assert.equal(ledger!.c, 1);

  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM put_back_tasks WHERE id = ${taskId}`);
  assert.equal(task!.status, "completed");
  const item = await queryGet<{ status: string; done_shelf_code: string }>(
    client.db,
    sql`SELECT status, done_shelf_code FROM put_back_task_items WHERE id = ${taskItemId}`
  );
  assert.equal(item!.status, "put_back");
  assert.equal(item!.done_shelf_code, lot.shelfCode);

  const err = await throws(() => completePutBackTask(client.db, { taskId, actorId }));
  assert.equal(err.status, 409);
  assert.match(err.message, /put_back_task_not_pending/);
});

test("dock item without fallback shelf → 409 put_back_shelf_required, nothing credited", async () => {
  const lot = await seedLot();
  const { taskId } = await seedTask(lot, { shelf: null });

  const err = await throws(() => completePutBackTask(client.db, { taskId, actorId }));
  assert.equal(err.status, 409);
  assert.match(err.message, /put_back_shelf_required/);

  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM put_back_tasks WHERE id = ${taskId}`);
  assert.equal(task!.status, "pending"); // rolled back
  const after = await queryGet<{ totalQty: number }>(client.db, sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE id = ${lot.id}`);
  assert.equal(after!.totalQty, lot.totalQty);
});

test("dock item with fallback shelf → creates the shelf-direct lot and credits it", async () => {
  const lot = await seedLot();
  const { taskId } = await seedTask(lot, { shelf: null });
  // Fallback = another shelf than the source lot's so the credit lands on a NEW lot.
  const other = await queryGet<{ code: string }>(
    client.db,
    sql`SELECT code FROM shelves WHERE code <> ${lot.shelfCode} LIMIT 1`
  );
  assert.ok(other);

  const res = await completePutBackTask(client.db, { taskId, actorId, shelfCode: other!.code });
  assert.equal(res.itemsCredited, 1);
  const newLot = await queryGet<{ totalQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty" FROM inventory_lots
        WHERE shelf_code = ${other!.code} AND part_no = ${lot.partNo} AND org_id = ${lot.orgId} AND sub_inventory_code = ${lot.subInventoryCode}`
  );
  assert.equal(newLot!.totalQty, 10);
});

test("list + detail honor the queue assignee convention", async () => {
  const lot = await seedLot();
  const open = await seedTask(lot, { shelf: lot.shelfCode }); // assignee NULL
  const mine = await seedTask(lot, { shelf: lot.shelfCode, assignee: "someone" });

  const all = await listPutBackTasks(client.db, "pending", undefined);
  assert.equal(all.length, 2);
  const asBob = await listPutBackTasks(client.db, "pending", "bob");
  assert.deepEqual((asBob as { id: string }[]).map((r) => r.id), [open.taskId]);
  const asSomeone = await listPutBackTasks(client.db, "pending", "someone");
  assert.equal(asSomeone.length, 2);

  const err = await throws(() => getPutBackTaskDetail(client.db, mine.taskId, "bob"));
  assert.equal(err.status, 404);
});
