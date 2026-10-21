// CN receiving workflow-status cron (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// terminal-state handling — completed → finalizeCnOrder (order in_hand +
// CN put-away task, idempotent), failed/cancelled → status + error, and the
// not-yet-synced order case stays workflow_running for the next poll.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setupTestDb, reseed, TEST_DATABASE_URL, FAKE_DOCPAL_URL, type TestDb } from "../db/test-helper.js";
import { queryAll, queryGet } from "../db/query.js";
import { runReceivingCnSyncOnce } from "../jobs/receivingCnSync.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;

let processStates: Record<string, string> = {};
let requests: { method: string; url: string }[] = [];
let fakeServer: Server;
let fakeUrl: string;

function startFake(): Promise<string> {
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    const procId = (req.url ?? "").split("/").pop() ?? "proc-1";
    const state = processStates[procId] ?? "running";
    res.end(JSON.stringify({ code: 200, result: true, data: { id: procId, state: { type: state } } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** Simulate the upstream sync writing the CN order world. */
async function seedCnOrder(batchNo: string): Promise<string> {
  const orderId = `cn-order-${batchNo}`;
  await client.db.execute(sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES (${orderId}, ${batchNo}, 'pending', 2)`);
  await client.db.execute(sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, org_id) VALUES (${`cn-inv-${batchNo}`}, ${orderId}, 'INV-CN-1', 2)`);
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, received_qty, org_id, sub_inventory_code)
        VALUES (${`cn-item-${batchNo}`}, ${`cn-inv-${batchNo}`}, 'RK73B1JTTD181G', 'WCL/181G', 100, 2, 'STORE1')`
  );
  return orderId;
}

async function seedWorkflow(id: string, invoiceNo: string, processId = "proc-1", batchNo: string | null = null): Promise<void> {
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, supplier, filename, docpal_document_id, docpal_process_id, docpal_business_key, batch_no, status, payload, created_by)
        VALUES (${id}, 'excel', ${invoiceNo}, 'TE', 'TE.xls', 'doc-1', ${processId}, 'bk-1', ${batchNo}, 'workflow_running', '{}'::jsonb, 'operator')`
  );
}

before(async () => {
  fakeUrl = await startFake();
  client = await setupTestDb();
  process.env.DOCPAL_WORKFLOW_TOKEN = "workflow-service-token";
});

async function withFake(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.DOCPAL_URL;
  process.env.DOCPAL_URL = fakeUrl;
  try {
    await fn();
  } finally {
    process.env.DOCPAL_URL = saved ?? FAKE_DOCPAL_URL;
  }
}

test("cron: completed process finalizes the CN order (in_hand + put-away task) and is idempotent", async () => {
  await reseed(client);
  const orderId = await seedCnOrder("TE20261010-2");
  await seedWorkflow("wf-1", "TE20261010-2");
  processStates = { "proc-1": "completed" };

  await withFake(async () => {
    await runReceivingCnSyncOnce(client.db);

    // Status is polled via the confirmed instance route.
    assert.ok(requests.some((r) => r.method === "GET" && r.url === "/oniflow/api/v1/processes/instance/proc-1"));

    const order = await queryGet<{ status: string; arrivedAt: Date | null }>(
      client.db,
      sql`SELECT status, arrived_at AS "arrivedAt" FROM receiving_orders_cn WHERE id = ${orderId}`
    );
    assert.equal(order!.status, "in_hand");
    assert.ok(order!.arrivedAt);

    const task = await queryGet<{ id: string; status: string; orgId: number | null; subInventoryCode: string | null }>(
      client.db,
      sql`SELECT id, status, org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${orderId}`
    );
    assert.ok(task);
    assert.equal(task!.status, "pending");
    assert.equal(task!.orgId, 2); // uniform pair from the order's items
    assert.equal(task!.subInventoryCode, "STORE1");

    const wf = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-1'`);
    assert.equal(wf!.status, "completed");

    // Second tick: the workflow is no longer running — nothing re-runs, the
    // task insert stays idempotent (unique receiving_order_cn_id).
    await runReceivingCnSyncOnce(client.db);
    const tasks = await queryAll<{ id: string }>(
      client.db,
      sql`SELECT id FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${orderId}`
    );
    assert.equal(tasks.length, 1);
    assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`))!.status, "in_hand");
  });
});

test("cron: completed process but the CN order is not synced yet → stays workflow_running (retries next poll)", async () => {
  await reseed(client);
  await seedWorkflow("wf-2", "NOT-SYNCED-YET");
  processStates = { "proc-1": "completed" };

  await withFake(async () => {
    await runReceivingCnSyncOnce(client.db);
    const wf = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-2'`);
    assert.equal(wf!.status, "workflow_running");
    const tasks = await queryAll<{ id: string }>(client.db, sql`SELECT id FROM put_away_tasks_cn`);
    assert.equal(tasks.length, 0);
  });
});

test("cron: failed/cancelled process states → workflow failed/cancelled with error", async () => {
  await reseed(client);
  await seedWorkflow("wf-3", "TE-FAIL-1", "proc-fail");
  await seedWorkflow("wf-4", "TE-CANCEL-1", "proc-cancel");
  await withFake(async () => {
    processStates = { "proc-fail": "failed", "proc-cancel": "cancelled" };
    await runReceivingCnSyncOnce(client.db);
    const failed = await queryGet<{ status: string; error: string | null }>(
      client.db,
      sql`SELECT status, error FROM receiving_cn_workflows WHERE id = 'wf-3'`
    );
    assert.equal(failed!.status, "failed");
    assert.match(failed!.error ?? "", /failed/);

    const cancelled = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-4'`);
    assert.equal(cancelled!.status, "cancelled");
  });
});

test("cron: running process → no change", async () => {
  await reseed(client);
  await seedWorkflow("wf-5", "TE-RUNNING-1");
  processStates = { "proc-1": "running" };
  await withFake(async () => {
    await runReceivingCnSyncOnce(client.db);
    const wf = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-5'`);
    assert.equal(wf!.status, "workflow_running");
  });
});

test("cron: completed process finalizes the order matched by the generated batch_no (invoice_no differs)", async () => {
  await reseed(client);
  const orderId = await seedCnOrder("CN-20261010-ABC123");
  await seedWorkflow("wf-6", "TE20261010-2", "proc-6", "CN-20261010-ABC123"); // batch_no wins over invoice_no
  processStates = { "proc-6": "completed" };

  await withFake(async () => {
    await runReceivingCnSyncOnce(client.db);
    const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`);
    assert.equal(order!.status, "in_hand");
    const wf = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-6'`);
    assert.equal(wf!.status, "completed");
  });
});

test("cron: legacy workflow without batch_no still finalizes via invoice_no fallback", async () => {
  await reseed(client);
  const orderId = await seedCnOrder("TE-LEGACY-FALLBACK");
  await seedWorkflow("wf-7", "TE-LEGACY-FALLBACK", "proc-7"); // batch_no NULL
  processStates = { "proc-7": "completed" };

  await withFake(async () => {
    await runReceivingCnSyncOnce(client.db);
    const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`);
    assert.equal(order!.status, "in_hand");
    const wf = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_cn_workflows WHERE id = 'wf-7'`);
    assert.equal(wf!.status, "completed");
  });
});
