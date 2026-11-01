// Task assignee (spec 2026-11-01-task-assignee-design.md): PDA list/detail
// endpoints filter by the optional assignee column (NULL = everyone, set =
// only that username), and the admin GET /admin/task-assignments +
// PATCH /admin/task-assignment surface manages the assignments.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { _setCnReceivingForTests, _resetFlowConfigForTests } from "../config.js";
import { queryGet } from "../db/query.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
  _setCnReceivingForTests(true); // the receiving-cn surface 404s while off
});

after(() => {
  _resetFlowConfigForTests();
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

async function call(token: string, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- picking ---------------------------------------------------------------

async function seedPickingOrder(id: string, orderNo: string): Promise<void> {
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status) VALUES (${id}, ${orderNo}, 'pending')`
  );
}

test("picking: assignee filters the list + detail; NULL is visible to everyone", async () => {
  await reseed(client);
  const operator = await login("operator", "DocPal2026!");
  const admin = await login("admin", "DocPalAdmin2026!");
  await seedPickingOrder("po-assignee-1", "SO-ASSIGNEE-1");

  const idsOf = async (token: string) =>
    ((await (await call(token, "GET", "/picking-orders")).json()) as { rows: { id: string; assignee: string | null }[] }).rows.map(
      (r) => r.id
    );

  // NULL assignee → both users see it (and the row carries assignee: null).
  assert.ok((await idsOf(operator)).includes("po-assignee-1"));
  assert.ok((await idsOf(admin)).includes("po-assignee-1"));

  // Assign to operator via the admin API.
  const set = await call(admin, "PATCH", "/admin/task-assignment", {
    flow: "picking",
    id: "po-assignee-1",
    assignee: "operator",
  });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { ok: true, flow: "picking", id: "po-assignee-1", assignee: "operator" });

  assert.ok((await idsOf(operator)).includes("po-assignee-1"));
  assert.ok(!(await idsOf(admin)).includes("po-assignee-1"));
  const row = ((await (await call(operator, "GET", "/picking-orders")).json()) as {
    rows: { id: string; assignee: string | null }[];
  }).rows.find((r) => r.id === "po-assignee-1");
  assert.equal(row!.assignee, "operator");

  // Detail: the assignee reads it; anyone else gets a plain 404.
  assert.equal((await call(operator, "GET", "/picking-orders/po-assignee-1")).status, 200);
  const denied = await call(admin, "GET", "/picking-orders/po-assignee-1");
  assert.equal(denied.status, 404);
  assert.match(await denied.text(), /picking_order_not_found/);

  // Clearing the assignment makes it visible to everyone again.
  const cleared = await call(admin, "PATCH", "/admin/task-assignment", {
    flow: "picking",
    id: "po-assignee-1",
    assignee: null,
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).assignee, null);
  assert.ok((await idsOf(admin)).includes("po-assignee-1"));
});

// --- verify -----------------------------------------------------------------

async function seedVerifyTask(taskId: string, boxId: string): Promise<void> {
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, status) VALUES (${boxId}, 'closed')`);
  await client.db.execute(
    sql`INSERT INTO verify_tasks (id, shipping_box_id, status) VALUES (${taskId}, ${boxId}, 'pending')`
  );
}

test("verify: assignee filters the list + detail; NULL is visible to everyone", async () => {
  await reseed(client);
  const operator = await login("operator", "DocPal2026!");
  const admin = await login("admin", "DocPalAdmin2026!");
  await seedVerifyTask("vt-assignee-1", "BOX-ASSIGNEE-1");

  const idsOf = async (token: string) =>
    ((await (await call(token, "GET", "/verify-tasks")).json()) as { taskId: string }[]).map((r) => r.taskId);

  assert.ok((await idsOf(operator)).includes("vt-assignee-1"));
  assert.ok((await idsOf(admin)).includes("vt-assignee-1"));

  await client.db.execute(sql`UPDATE verify_tasks SET assignee = 'operator' WHERE id = 'vt-assignee-1'`);
  assert.ok((await idsOf(operator)).includes("vt-assignee-1"));
  assert.ok(!(await idsOf(admin)).includes("vt-assignee-1"));

  const detail = await call(operator, "GET", "/verify-tasks/vt-assignee-1");
  assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as { task: { assignee: string } }).task.assignee, "operator");
  const denied = await call(admin, "GET", "/verify-tasks/vt-assignee-1");
  assert.equal(denied.status, 404);
  assert.match(await denied.text(), /verify_task_not_found/);
});

// --- receiving-cn scan tasks -------------------------------------------------

async function seedCnScanningOrder(id: string, batchNo: string): Promise<void> {
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES (${id}, ${batchNo}, 'scanning', 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, org_id)
        VALUES (${`inv-${id}`}, ${id}, ${`INV-${batchNo}`}, 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, line_qty, received_qty, org_id, sub_inventory_code)
        VALUES (${`item-${id}`}, ${`inv-${id}`}, 'PART-A', 10, 0, 2, 'STORE1')`
  );
}

test("receiving-cn scan tasks: assignee filters list + detail; NULL visible to everyone", async () => {
  await reseed(client);
  const operator = await login("operator", "DocPal2026!");
  const admin = await login("admin", "DocPalAdmin2026!");
  await seedCnScanningOrder("cn-assignee-1", "CN-ASSIGNEE-1");

  const idsOf = async (token: string) =>
    ((await (await call(token, "GET", "/receiving-cn/scan-tasks")).json()) as { id: string }[]).map((r) => r.id);

  assert.ok((await idsOf(operator)).includes("cn-assignee-1"));
  assert.ok((await idsOf(admin)).includes("cn-assignee-1"));

  await client.db.execute(sql`UPDATE receiving_orders_cn SET assignee = 'admin' WHERE id = 'cn-assignee-1'`);
  assert.ok(!(await idsOf(operator)).includes("cn-assignee-1"));
  assert.ok((await idsOf(admin)).includes("cn-assignee-1"));

  const denied = await call(operator, "GET", "/receiving-cn/scan-tasks/cn-assignee-1");
  assert.equal(denied.status, 404);
  assert.match(await denied.text(), /receiving_cn_scan_task_not_found/);
  const detail = await call(admin, "GET", "/receiving-cn/scan-tasks/cn-assignee-1");
  assert.equal(detail.status, 200);
  assert.equal(((await detail.json()) as { order: { assignee: string } }).order.assignee, "admin");
});

// --- admin API ---------------------------------------------------------------

test("admin task-assignments: GET lists open tasks per flow; unknown flow → 400", async () => {
  await reseed(client);
  const admin = await login("admin", "DocPalAdmin2026!");
  await seedPickingOrder("po-assignee-2", "SO-ASSIGNEE-2");
  await seedVerifyTask("vt-assignee-2", "BOX-ASSIGNEE-2");
  await client.db.execute(sql`UPDATE verify_tasks SET assignee = 'operator' WHERE id = 'vt-assignee-2'`);

  const picking = await call(admin, "GET", "/admin/task-assignments?flow=picking");
  assert.equal(picking.status, 200);
  const pickingRows = (await picking.json()) as { id: string; label: string; status: string; assignee: string | null }[];
  const row = pickingRows.find((r) => r.id === "po-assignee-2");
  assert.ok(row);
  assert.equal(row!.label, "SO-ASSIGNEE-2");
  assert.equal(row!.status, "pending");
  assert.equal(row!.assignee, null);

  // Admin sees rows regardless of assignee.
  const verify = await call(admin, "GET", "/admin/task-assignments?flow=verify");
  const verifyRows = (await verify.json()) as { id: string; label: string; assignee: string | null }[];
  const vrow = verifyRows.find((r) => r.id === "vt-assignee-2");
  assert.ok(vrow);
  assert.equal(vrow!.label, "BOX-ASSIGNEE-2");
  assert.equal(vrow!.assignee, "operator");

  for (const bad of ["/admin/task-assignments?flow=nope", "/admin/task-assignments"]) {
    const res = await call(admin, "GET", bad);
    assert.equal(res.status, 400, bad);
    assert.match(await res.text(), /unknown_flow/);
  }
});

test("admin PATCH task-assignment: validation + 404 unknown id; set persists and clears", async () => {
  await reseed(client);
  const admin = await login("admin", "DocPalAdmin2026!");
  await seedPickingOrder("po-assignee-3", "SO-ASSIGNEE-3");

  const badFlow = await call(admin, "PATCH", "/admin/task-assignment", { flow: "nope", id: "x", assignee: "operator" });
  assert.equal(badFlow.status, 400);
  assert.match(await badFlow.text(), /unknown_flow/);

  const badAssignee = await call(admin, "PATCH", "/admin/task-assignment", { flow: "picking", id: "po-assignee-3", assignee: 5 });
  assert.equal(badAssignee.status, 400);
  assert.match(await badAssignee.text(), /assignee must be a string/);

  const missing = await call(admin, "PATCH", "/admin/task-assignment", { flow: "picking", id: "nope", assignee: "operator" });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /task_not_found/);

  const set = await call(admin, "PATCH", "/admin/task-assignment", { flow: "picking", id: "po-assignee-3", assignee: "operator" });
  assert.equal(set.status, 200);
  const stored = await queryGet<{ assignee: string | null }>(
    client.db,
    sql`SELECT assignee FROM picking_orders WHERE id = 'po-assignee-3'`
  );
  assert.equal(stored!.assignee, "operator");

  // Audit row: from/to the assignee values.
  const audit = await queryGet<{ fromState: string | null; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState" FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = 'po-assignee-3'
        ORDER BY created_date DESC LIMIT 1`
  );
  assert.equal(audit!.fromState, null);
  assert.equal(audit!.toState, "admin_edit");

  // "" clears, same as null.
  const cleared = await call(admin, "PATCH", "/admin/task-assignment", { flow: "picking", id: "po-assignee-3", assignee: "" });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).assignee, null);
  assert.equal(
    (await queryGet<{ assignee: string | null }>(client.db, sql`SELECT assignee FROM picking_orders WHERE id = 'po-assignee-3'`))!
      .assignee,
    null
  );
});
