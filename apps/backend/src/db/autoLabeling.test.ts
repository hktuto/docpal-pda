import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { scanPickingItem } from "./picking.js";
import {
  createAutoLabelingJob,
  fetchAutoLabelingJob,
  latestAutoLabelingJobForOrder,
  reportAutoLabelingJob,
} from "./autoLabeling.js";
import type { RuleConditions } from "../routes/admin/crud.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

beforeEach(async () => {
  await reseed(client);
  // resetAndReseed does not truncate label_print_rules — clear between tests.
  await client.db.execute(sql`DELETE FROM label_print_rules`);
});

const ORDER_NO = "SO-DEMO-0001";

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`);
  return row!.id;
}

async function pickingItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi
        WHERE pi.picking_order_id = ${orderId} AND pi.part_no = ${partNo}`
  );
  return row!.id;
}

async function allocationIdOf(pickingItemId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  return row!.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

async function insertRule(opts: { labelSource?: string; active?: boolean; labelType?: string }): Promise<string> {
  const id = randomUUID();
  const conditions: RuleConditions = {
    combinator: "and",
    conditions: [{ field: "order_no", operator: "match", value: `${ORDER_NO}*` } as never],
  };
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, label_source, priority, active)
    VALUES
      (${id}, 'auto-rule', ${opts.labelType ?? "item"}, ${JSON.stringify(conditions)}::jsonb,
       'tpl-auto', ${opts.labelSource ?? "auto_machine"}, 100, ${opts.active ?? true})
  `);
  return id;
}

/** The seeded pending order with all three items scanned in full (so it has
 *  picking packages to snapshot). */
async function scannedOrder(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await orderIdOf(ORDER_NO);
  for (const [partNo, qty] of [
    ["RK73H1JTTD1002F", 1000],
    ["RK73H1JTTD2202F", 500],
    ["RK73B1JTTD181G", 300],
  ] as const) {
    const item = await pickingItemIdOf(orderId, partNo);
    await scanPickingItem(client.db, item, { actorId, allocationId: await allocationIdOf(item), qty });
  }
  return { orderId, actorId };
}

test("createAutoLabelingJob: inserts a pending job with payload + snapshots", async () => {
  const { orderId, actorId } = await scannedOrder();
  const ruleId = await insertRule({});
  const job = await createAutoLabelingJob(client.db, { orderId, ruleId, actorId });
  assert.equal(job.status, "pending");
  assert.equal(job.createdBy, actorId);
  assert.ok(job.labelCount > 0);

  const row = await queryGet<{ payload: unknown[]; orderSnapshot: Record<string, unknown>; scanSnapshot: unknown[] }>(
    client.db,
    sql`SELECT payload, order_snapshot AS "orderSnapshot", scan_snapshot AS "scanSnapshot"
        FROM auto_labeling_jobs WHERE id = ${job.id}`
  );
  assert.equal(row!.payload.length, job.labelCount);
  assert.equal(row!.orderSnapshot.orderNo, ORDER_NO);
  assert.ok(Array.isArray(row!.orderSnapshot.brands));
  assert.equal(row!.scanSnapshot.length, job.labelCount); // one scan record per label row (item labels)
  const latest = await latestAutoLabelingJobForOrder(client.db, orderId);
  assert.equal(latest?.id, job.id);
});

test("createAutoLabelingJob: rejects unknown / inactive / non-matching / non-auto rules", async () => {
  const { orderId, actorId } = await scannedOrder();
  const inactive = await insertRule({ active: false });
  assert.equal((await catchHttp(createAutoLabelingJob(client.db, { orderId, ruleId: inactive, actorId }))).message, "label_print_rule_inactive");

  const internal = await insertRule({ labelSource: "internal" });
  assert.equal((await catchHttp(createAutoLabelingJob(client.db, { orderId, ruleId: internal, actorId }))).message, "label_rule_not_auto_machine");

  assert.equal((await catchHttp(createAutoLabelingJob(client.db, { orderId, ruleId: randomUUID(), actorId }))).message, "label_print_rule_not_found");

  const rule = await insertRule({});
  assert.equal(
    (await catchHttp(createAutoLabelingJob(client.db, { orderId: (await orderIdOf("SO-DEMO-0002")), ruleId: rule, actorId }))).message,
    "label_rule_no_longer_matches"
  );
});

test("fetchAutoLabelingJob: claims the newest pending job → printing", async () => {
  const { orderId, actorId } = await scannedOrder();
  const ruleId = await insertRule({});
  const j1 = await createAutoLabelingJob(client.db, { orderId, ruleId, actorId });
  const j2 = await createAutoLabelingJob(client.db, { orderId, ruleId, actorId });

  const fetched = await fetchAutoLabelingJob(client.db, {});
  assert.equal(fetched.id, j2.id); // newest wins
  assert.equal(fetched.status, "printing");
  assert.ok(Array.isArray(fetched.payload) && fetched.payload.length > 0);
  assert.ok(fetched.orderSnapshot && typeof fetched.orderSnapshot === "object");
  assert.ok(Array.isArray(fetched.scanSnapshot));

  const state = await queryGet<{ fetchedDate: Date | null }>(
    client.db,
    sql`SELECT fetched_date AS "fetchedDate" FROM auto_labeling_jobs WHERE id = ${j2.id}`
  );
  assert.ok(state!.fetchedDate);

  const fetched2 = await fetchAutoLabelingJob(client.db, {});
  assert.equal(fetched2.id, j1.id);
  await assert.rejects(fetchAutoLabelingJob(client.db, {}), (e: HTTPException) => e.message === "auto_labeling_no_pending_job");
});

test("fetchAutoLabelingJob: jobId re-claim is idempotent for printing/failed", async () => {
  const { orderId, actorId } = await scannedOrder();
  const ruleId = await insertRule({});
  const job = await createAutoLabelingJob(client.db, { orderId, ruleId, actorId });

  // Initial claim comes from the button (no jobId); retries re-claim by id.
  const first = await fetchAutoLabelingJob(client.db, {});
  assert.equal(first.id, job.id);
  assert.equal(first.status, "printing");
  const again = await fetchAutoLabelingJob(client.db, { jobId: job.id });
  assert.equal(again.id, job.id);
  assert.equal(again.status, "printing");

  await reportAutoLabelingJob(client.db, { id: job.id, status: "failed", note: "label jam" });
  const retry = await fetchAutoLabelingJob(client.db, { jobId: job.id });
  assert.equal(retry.status, "printing"); // failed → re-claimable for retry
  assert.deepEqual(retry.payload, first.payload);
});

test("reportAutoLabelingJob: completed stamps the date; illegal transitions 409", async () => {
  const { orderId, actorId } = await scannedOrder();
  const ruleId = await insertRule({});
  const job = await createAutoLabelingJob(client.db, { orderId, ruleId, actorId });

  // pending → completed is illegal (the machine must fetch first).
  await assert.rejects(reportAutoLabelingJob(client.db, { id: job.id, status: "completed" }), (e: HTTPException) => e.message === "auto_labeling_job_state");
  await assert.rejects(reportAutoLabelingJob(client.db, { id: job.id, status: "pending" }), (e: HTTPException) => e.message === "auto_labeling_status_invalid");

  await fetchAutoLabelingJob(client.db, {});
  const done = await reportAutoLabelingJob(client.db, { id: job.id, status: "completed" });
  assert.equal(done.status, "completed");
  assert.ok(done.completedDate);

  const row = await queryGet<{ completedDate: Date | null }>(
    client.db,
    sql`SELECT completed_date AS "completedDate" FROM auto_labeling_jobs WHERE id = ${job.id}`
  );
  assert.ok(row!.completedDate);
});
