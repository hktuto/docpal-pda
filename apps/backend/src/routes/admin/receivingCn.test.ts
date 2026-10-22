// Admin CN receiving routes (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// payload validation, upload → workflow kick → tracking row, kick-failure
// attachment cleanup, list/detail. The DocPal workflow/file calls go to a
// dedicated fake server (DOCPAL_URL is read at call time); the admin JWT
// comes from the shared fake-DocPal login in test-helper.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setupTestDb, reseed, TEST_DATABASE_URL, FAKE_DOCPAL_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { transactionLogs } from "../../db/schema/index.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];

const WORKFLOW_TOKEN = "workflow-service-token";
const EXCEL_WORKFLOW_ID = "cn-excel-def-1";

// --- fake DocPal workflow server ----------------------------------------------

interface FakeWorkflowState {
  startFails: boolean;
  processState: string;
  requests: { method: string; url: string; body: string; headers: Record<string, unknown> }[];
}

let fake: FakeWorkflowState;
let fakeServer: Server;
let fakeUrl: string;

function startFakeWorkflowServer(): Promise<string> {
  fake = { startFails: false, processState: "running", requests: [] };
  fakeServer = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      fake.requests.push({ method: req.method ?? "", url: req.url ?? "", body: raw, headers: req.headers as Record<string, unknown> });
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/docpal/workflow/upload/file") {
        return json(200, { code: 200, result: true, data: { id: "doc-1", name: "TE20261010-2.xls" } });
      }
      if (req.method === "DELETE" && url.startsWith("/api/docpal/workflow/task/attachment")) {
        return json(200, { code: 200, result: true, data: null });
      }
      if (req.method === "POST" && url === "/oniflow/api/v1/processes") {
        if (fake.startFails) return json(500, { code: 500, message: "process start exploded" });
        return json(201, { code: 201, data: { id: "proc-1", business_key: "bk-1", state: { type: fake.processState } } });
      }
      if (req.method === "GET" && url.startsWith("/oniflow/api/v1/processes/")) {
        return json(200, { code: 200, result: true, data: { id: "proc-1", state: { type: fake.processState } } });
      }
      json(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => {
    fakeServer.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`);
    });
  });
}

// --- helpers --------------------------------------------------------------------

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

function uploadForm(payload: unknown, opts: { withFile?: boolean; withData?: boolean } = {}): FormData {
  const form = new FormData();
  if (opts.withFile !== false) {
    form.append("file", new Blob(["fake-xls-bytes"], { type: "application/vnd.ms-excel" }), "TE20261010-2.xls");
  }
  if (opts.withData !== false) {
    form.append("data", JSON.stringify(payload));
  }
  return form;
}

async function postExcel(token: string, form: FormData) {
  return app.request("/admin/receiving-cn/excel", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
}

const VALID_PAYLOAD = {
  receivedOffice: "HK",
  supplier: "TE",
  receiptNo: "",
  invoiceNo: "TE20261010-2",
  receivedDate: "2026-10-10",
  items: [
    {
      // Wire contract (swapped vs the sheet): orderNo carries the 发货項
      // value (blank is fine), poNo carries the 訂單號 (required).
      orderNo: "",
      cartonNo: "1",
      partNo: "iC-HAUS-001",
      dateCode: "2641",
      qty: "500",
      weight: "1.5",
      office: "2",
      poNo: "329062100T3",
      remark: "",
    },
  ],
};

before(async () => {
  fakeUrl = await startFakeWorkflowServer();
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
  process.env.DOCPAL_WORKFLOW_TOKEN = WORKFLOW_TOKEN;
  process.env.DOCPAL_CN_EXCEL_WORKFLOW_ID = EXCEL_WORKFLOW_ID;
});

after(() => {
  delete process.env.DOCPAL_WORKFLOW_TOKEN;
  delete process.env.DOCPAL_CN_EXCEL_WORKFLOW_ID;
  fakeServer.close();
});

// Every upload test points DOCPAL_URL at the workflow fake; tests that need the
// login fake restore it themselves.
async function withWorkflowFake(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.DOCPAL_URL;
  process.env.DOCPAL_URL = fakeUrl;
  try {
    await fn();
  } finally {
    process.env.DOCPAL_URL = saved ?? FAKE_DOCPAL_URL;
  }
}

// --- validation -------------------------------------------------------------------

test("excel upload: missing file → 400 file_required", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const res = await postExcel(token, uploadForm(VALID_PAYLOAD, { withFile: false }));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /file_required/);
});

test("excel upload: missing/invalid data → 400 invalid_payload", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const missing = await postExcel(token, uploadForm(VALID_PAYLOAD, { withData: false }));
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /invalid_payload/);

  const badJson = new FormData();
  badJson.append("file", new Blob(["x"]), "a.xls");
  badJson.append("data", "not-json{");
  const bad = await postExcel(token, badJson);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /invalid_payload/);
});

test("excel upload: payload shape errors → 400 invalid_payload", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const cases: unknown[] = [
    { ...VALID_PAYLOAD, items: [] },
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], partNo: "" }] },
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], poNo: undefined }] },
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], qty: 0 }] },
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], qty: "abc" }] },
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], qty: 1.5 }] },
    { ...VALID_PAYLOAD, supplier: 42 },
  ];
  for (const payload of cases) {
    const res = await postExcel(token, uploadForm(payload));
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.match(await res.text(), /invalid_payload/);
  }
});

test("excel upload: workflow token unset → 500 docpal_workflow_token_not_configured", async (t) => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  delete process.env.DOCPAL_WORKFLOW_TOKEN;
  t.after(() => {
    process.env.DOCPAL_WORKFLOW_TOKEN = WORKFLOW_TOKEN;
  });
  await withWorkflowFake(async () => {
    const res = await postExcel(token, uploadForm(VALID_PAYLOAD));
    assert.equal(res.status, 500);
    assert.match(await res.text(), /docpal_workflow_token_not_configured/);
  });
});

// --- happy path -------------------------------------------------------------------

test("excel upload: upload + kick → 201 tracking row with real creator + docpal ids", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await withWorkflowFake(async () => {
    const res = await postExcel(token, uploadForm(VALID_PAYLOAD));
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };

    const row = await queryGet<{
      phase: string;
      status: string;
      invoiceNo: string;
      supplier: string;
      filename: string;
      docpalDocumentId: string;
      docpalProcessId: string;
      docpalBusinessKey: string;
      batchNo: string;
      createdBy: string;
    }>(
      client.db,
      sql`SELECT phase, status, invoice_no AS "invoiceNo", supplier, filename,
                 docpal_document_id AS "docpalDocumentId", docpal_process_id AS "docpalProcessId",
                 docpal_business_key AS "docpalBusinessKey", batch_no AS "batchNo", created_by AS "createdBy"
          FROM receiving_cn_workflows WHERE id = ${id}`
    );
    assert.equal(row!.phase, "excel");
    assert.equal(row!.status, "workflow_running");
    assert.equal(row!.invoiceNo, "TE20261010-2");
    assert.equal(row!.supplier, "TE");
    assert.equal(row!.docpalDocumentId, "doc-1");
    assert.equal(row!.docpalProcessId, "proc-1");
    assert.equal(row!.docpalBusinessKey, "bk-1");
    assert.match(row!.batchNo, /^CN-\d{8}-[A-Z2-9]{6}$/);
    assert.equal(row!.createdBy, "admin"); // the real logged-in admin, not the service token user

    // The workflow kick carried the upload entry, the verified payload, and
    // the real user as creator variables.
    const startReq = fake.requests.find((r) => r.method === "POST" && r.url === "/oniflow/api/v1/processes");
    assert.ok(startReq);
    const startBody = JSON.parse(startReq!.body);
    assert.equal(startBody.definition_id, EXCEL_WORKFLOW_ID);
    assert.equal(startBody.start_user_id, "admin");
    assert.equal(startBody.variables.start_user_id, "admin");
    assert.equal(startBody.variables.__system__user_creator_id, "admin");
    assert.equal(startBody.variables.__system__user_creator_name, "Demo Admin");
    assert.ok(Array.isArray(startBody.variables.excel_result_data));
    assert.equal(startBody.variables.excel_result_data.length, 1);
    assert.equal(startBody.variables.excel_result_data[0].invoiceNo, "TE20261010-2");
    assert.equal(startBody.variables.excel_result_data[0].batchNo, row!.batchNo);
    // Swapped wire contract: poNo carries the 訂單號, orderNo the (blank) 发货項.
    assert.equal(startBody.variables.excel_result_data[0].items[0].poNo, "329062100T3");
    assert.equal(startBody.variables.excel_result_data[0].items[0].orderNo, "");
    assert.equal(startBody.variables.excelFiles[0].id, "doc-1");
    assert.equal(startBody.variables.excelFiles[0].extension, "xls");
    assert.equal(startBody.variables.excelFiles[0].mime_type, "application/vnd.ms-excel");
    assert.equal(startBody.variables.excelFiles[0].response.data.fileContentExtension, "xls");
    // Bearer service token + X-Tenant-ID on both the upload and the kick.
    const uploadReq = fake.requests.find((r) => r.method === "POST" && r.url === "/api/docpal/workflow/upload/file");
    assert.match(String(uploadReq?.body), /fake-xls-bytes/);
    assert.equal(uploadReq?.headers.authorization, `Bearer ${WORKFLOW_TOKEN}`);
    assert.equal(uploadReq?.headers["x-tenant-id"], "demo");
    const startReqHeaders = fake.requests.find((r) => r.method === "POST" && r.url === "/oniflow/api/v1/processes")?.headers;
    assert.equal(startReqHeaders?.authorization, `Bearer ${WORKFLOW_TOKEN}`);
    assert.equal(startReqHeaders?.["x-tenant-id"], "demo");

    const logs = await queryAll<{ toState: string }>(
      client.db,
      sql`SELECT to_state AS "toState" FROM transaction_logs
          WHERE entity_type = 'receiving_cn_workflow' AND entity_id = ${id}`
    );
    assert.deepEqual(logs.map((l) => l.toState), ["workflow_running"]);
  });
});

test("excel upload: startProcess failure deletes the orphaned attachment → 502", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  fake.startFails = true;
  try {
    await withWorkflowFake(async () => {
      const res = await postExcel(token, uploadForm(VALID_PAYLOAD));
      assert.equal(res.status, 502);
      assert.match(await res.text(), /docpal_workflow/);
      const del = fake.requests.find(
        (r) => r.method === "DELETE" && r.url.startsWith("/api/docpal/workflow/task/attachment?attachmentId=doc-1")
      );
      assert.ok(del, "expected the orphaned attachment to be deleted");
      // No tracking row — the kick never happened.
      const count = await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM receiving_cn_workflows`);
      assert.equal(count!.n, 0);
    });
  } finally {
    fake.startFails = false;
  }
});

// --- list / detail ------------------------------------------------------------------

test("list + detail: status filter, paging, payload round-trip", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await withWorkflowFake(async () => {
    await postExcel(token, uploadForm(VALID_PAYLOAD));
    await postExcel(token, uploadForm({ ...VALID_PAYLOAD, invoiceNo: "TE20261010-3" }));
  });

  const all = await app.request("/admin/receiving-cn?page=1&pageSize=10", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(all.status, 200);
  const allBody = (await all.json()) as { rows: { id: string; invoiceNo: string }[]; total: number };
  assert.equal(allBody.total, 2);
  assert.equal(allBody.rows[0].invoiceNo, "TE20261010-3"); // newest first

  const filtered = await app.request("/admin/receiving-cn?status=completed", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(((await filtered.json()) as { total: number }).total, 0);
  const running = await app.request("/admin/receiving-cn?status=workflow_running", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(((await running.json()) as { total: number }).total, 2);

  const detail = await app.request(`/admin/receiving-cn/${allBody.rows[0].id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { invoiceNo: string; payload: { items: { partNo: string; qty: number }[] } };
  assert.equal(detailBody.invoiceNo, "TE20261010-3");
  assert.equal(detailBody.payload.items[0].partNo, "iC-HAUS-001");
  assert.equal(detailBody.payload.items[0].qty, 500); // qty coerced from the string "500"
});

test("detail: unknown id → 404 receiving_cn_workflow_not_found", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const res = await app.request("/admin/receiving-cn/00000000-0000-4000-8000-000000000000", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /receiving_cn_workflow_not_found/);
});

// --- order-centric list / detail ------------------------------------------------------

/** Simulate the upstream sync writing a CN order (stamped with the workflow's
 *  generated batch_no) + its invoice/item world. */
async function seedCnOrderByBatch(batchNo: string, opts: { withTask?: boolean } = {}): Promise<string> {
  const orderId = `cn-order-${batchNo}`;
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, delivery_date, org_id, arrived_at, arrived_by)
        VALUES (${orderId}, ${batchNo}, 'in_hand', '2026-10-10', 2, now(), (SELECT id FROM users WHERE username = 'operator'))`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, total_qty, total_ctn, org_id)
        VALUES (${`cn-inv-${batchNo}`}, ${orderId}, 'INV-CN-1', 100, 2, 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, po_no, line_qty, received_qty, date_code, org_id, sub_inventory_code)
        VALUES (${`cn-item-${batchNo}`}, ${`cn-inv-${batchNo}`}, 'RK73B1JTTD181G', 'WCL/181G', 'PO-1', 100, 100, '2641', 2, 'STORE1')`
  );
  if (opts.withTask) {
    await client.db.execute(
      sql`INSERT INTO put_away_tasks_cn (id, receiving_order_cn_id, org_id, sub_inventory_code, status)
          VALUES (${`cn-task-${batchNo}`}, ${orderId}, 2, 'STORE1', 'pending')`
    );
  }
  return orderId;
}

test("orders list: synced order row (kind order) + unmatched workflow in pending; no duplicates", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  let orderBatchNo = "";
  await withWorkflowFake(async () => {
    await postExcel(token, uploadForm(VALID_PAYLOAD));
    orderBatchNo = (
      await queryGet<{ batchNo: string }>(client.db, sql`SELECT batch_no AS "batchNo" FROM receiving_cn_workflows ORDER BY created_date DESC LIMIT 1`)
    )!.batchNo;
    // The upstream sync writes the order stamped with that batch_no.
    await seedCnOrderByBatch(orderBatchNo, { withTask: true });
    // Second upload whose order hasn't synced → pending placeholder.
    await postExcel(token, uploadForm({ ...VALID_PAYLOAD, invoiceNo: "TE20261010-3" }));
  });

  const res = await app.request("/admin/receiving-cn/orders", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rows: {
      kind: string;
      batchNo: string;
      invoiceNo: string;
      supplier: string;
      status: string;
      putAwayStatus: string | null;
      docpalBusinessKey: string | null;
      arrivedByName: string | null;
    }[];
    total: number;
    pending: {
      kind: string;
      batchNo: string;
      invoiceNo: string;
      status: string;
      error: string | null;
      docpalBusinessKey: string | null;
    }[];
  };
  assert.equal(body.total, 1);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].kind, "order");
  assert.equal(body.rows[0].batchNo, orderBatchNo);
  assert.equal(body.rows[0].invoiceNo, "TE20261010-2"); // from the matched workflow
  assert.equal(body.rows[0].supplier, "TE");
  assert.equal(body.rows[0].status, "in_hand");
  assert.equal(body.rows[0].putAwayStatus, "pending");
  assert.equal(body.rows[0].docpalBusinessKey, "bk-1");
  assert.equal(body.rows[0].arrivedByName, "Demo Operator"); // users join on arrived_by

  assert.equal(body.pending.length, 1);
  assert.equal(body.pending[0].kind, "pending");
  assert.equal(body.pending[0].status, "processing");
  assert.equal(body.pending[0].invoiceNo, "TE20261010-3");
  assert.match(body.pending[0].batchNo, /^CN-\d{8}-[A-Z2-9]{6}$/);
  assert.notEqual(body.pending[0].batchNo, orderBatchNo);
});

test("orders list: legacy workflow (no batch_no) matched to its order via invoice_no fallback", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("TE-LEGACY-1");
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, supplier, filename, docpal_document_id, docpal_process_id, docpal_business_key, status, payload, created_by)
        VALUES ('wf-legacy', 'excel', 'TE-LEGACY-1', 'TE', 'TE.xls', 'doc-9', 'proc-9', 'bk-9', 'workflow_running', '{}'::jsonb, 'admin')`
  );
  const res = await app.request("/admin/receiving-cn/orders", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    rows: { batchNo: string; invoiceNo: string; docpalBusinessKey: string | null }[];
    total: number;
    pending: { batchNo: string }[];
  };
  assert.equal(body.total, 1);
  assert.equal(body.rows[0].batchNo, "TE-LEGACY-1"); // fallback key = invoice_no
  assert.equal(body.rows[0].invoiceNo, "TE-LEGACY-1");
  assert.equal(body.rows[0].docpalBusinessKey, "bk-9");
  assert.equal(body.pending.length, 0); // matched — not pending
});

test("orders detail: order + invoices + items (invoiceNo per item) + putAway", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("TE-DETAIL-1", { withTask: true });
  const res = await app.request("/admin/receiving-cn/orders/TE-DETAIL-1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    order: { id: string; batchNo: string; status: string; orgId: number; arrivedAt: string | null; arrivedByName: string };
    invoices: { id: string; invoiceNo: string; totalQty: number }[];
    items: { id: string; receivingInvoiceId: string; invoiceNo: string; partNo: string; receivedQty: number; putAwayQty: number; orgId: number; subInventoryCode: string }[];
    putAway: { id: string; status: string } | null;
  };
  assert.equal(body.order.batchNo, "TE-DETAIL-1");
  assert.equal(body.order.status, "in_hand");
  assert.equal(body.order.orgId, 2);
  assert.ok(body.order.arrivedAt);
  assert.equal(body.order.arrivedByName, "Demo Operator");
  assert.equal(body.invoices.length, 1);
  assert.equal(body.invoices[0].invoiceNo, "INV-CN-1");
  assert.equal(body.invoices[0].totalQty, 100);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].invoiceNo, "INV-CN-1"); // invoice no carried on the item
  assert.equal(body.items[0].partNo, "RK73B1JTTD181G");
  assert.equal(body.items[0].receivedQty, 100);
  assert.equal(body.items[0].subInventoryCode, "STORE1");
  assert.ok(body.putAway);
  assert.equal(body.putAway!.status, "pending");
});

test("orders detail: unknown batchNo → 404 receiving_cn_order_not_found", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const res = await app.request("/admin/receiving-cn/orders/NO-SUCH-BATCH", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /receiving_cn_order_not_found/);
});

// --- search ---------------------------------------------------------------------------

test("orders search: filters order rows by batch_no (total reflects filter)", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("CN-20261010-AAAAAA");
  await seedCnOrderByBatch("CN-20261010-BBBBBB");
  // Unmatched workflow so pending exists (should be filtered out by this term).
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, supplier, docpal_process_id, status, payload, created_by)
        VALUES ('wf-s1', 'excel', 'TE-PENDING-1', 'TE', 'proc-s1', 'workflow_running', '{}'::jsonb, 'admin')`
  );

  const res = await app.request("/admin/receiving-cn/orders?search=aaaaaa", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rows: { batchNo: string }[];
    total: number;
    pending: { batchNo: string }[];
  };
  assert.equal(body.total, 1);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].batchNo, "CN-20261010-AAAAAA"); // ILIKE — case-insensitive
  assert.equal(body.pending.length, 0);
});

test("orders search: term matching the pending's invoice_no → order rows empty, pending filtered to it", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("CN-20261010-CCCCCC");
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, supplier, docpal_process_id, status, payload, created_by)
        VALUES ('wf-s2', 'excel', 'TE-PENDING-2', 'TE', 'proc-s2', 'workflow_running', '{}'::jsonb, 'admin')`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, supplier, docpal_process_id, status, payload, created_by)
        VALUES ('wf-s3', 'excel', 'TE-OTHER-3', 'SUPPLIER-X', 'proc-s3', 'workflow_running', '{}'::jsonb, 'admin')`
  );

  const res = await app.request("/admin/receiving-cn/orders?search=pending-2", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as {
    rows: { batchNo: string }[];
    total: number;
    pending: { invoiceNo: string }[];
  };
  assert.equal(body.total, 0);
  assert.equal(body.rows.length, 0);
  assert.equal(body.pending.length, 1);
  assert.equal(body.pending[0].invoiceNo, "TE-PENDING-2");

  // Same term also matches the supplier column on the other workflow.
  const bySupplier = await app.request("/admin/receiving-cn/orders?search=supplier-x", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const supplierBody = (await bySupplier.json()) as { total: number; pending: { invoiceNo: string }[] };
  assert.equal(supplierBody.total, 0);
  assert.equal(supplierBody.pending.length, 1);
  assert.equal(supplierBody.pending[0].invoiceNo, "TE-OTHER-3");
});

test("orders search: non-matching term → empty rows and pending", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("CN-20261010-DDDDDD");
  await client.db.execute(
    sql`INSERT INTO receiving_cn_workflows (id, phase, invoice_no, docpal_process_id, status, payload, created_by)
        VALUES ('wf-s4', 'excel', 'TE-PENDING-4', 'proc-s4', 'workflow_running', '{}'::jsonb, 'admin')`
  );
  const res = await app.request("/admin/receiving-cn/orders?search=zzz-no-match", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { rows: unknown[]; total: number; pending: unknown[] };
  assert.equal(body.total, 0);
  assert.deepEqual(body.rows, []);
  assert.deepEqual(body.pending, []);
});

// --- item edit ------------------------------------------------------------------------

async function itemIdOf(batchNo: string): Promise<string> {
  return `cn-item-${batchNo}`;
}

test("item edit: PATCH sets dateCode + clears coo; absent keys unchanged; audit row written", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("TE-EDIT-1");
  // Give the seeded item a coo so clearing it is a real change (audit row).
  await client.db.execute(sql`UPDATE receiving_invoice_items_cn SET coo = 'JP' WHERE id = ${await itemIdOf("TE-EDIT-1")}`);
  const itemId = await itemIdOf("TE-EDIT-1");
  const res = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateCode: " 2652 ", coo: null }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    id: string;
    receivingInvoiceId: string;
    invoiceNo: string;
    partNo: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    ctnNo: string | null;
    receivedQty: number;
    putAwayQty: number;
    orgId: number;
    subInventoryCode: string;
  };
  assert.equal(body.id, itemId);
  assert.equal(body.invoiceNo, "INV-CN-1"); // joined from the invoice
  assert.equal(body.dateCode, "2652"); // trimmed
  assert.equal(body.coo, null); // cleared
  assert.equal(body.lotCode, null); // absent key unchanged (seed has none)
  assert.equal(body.cow, null);
  assert.equal(body.ctnNo, null);
  assert.equal(body.receivedQty, 100);

  // Audit rows: one per actually-changed field.
  const logs = await queryAll<{ toState: string; metadata: { field: string; from: string | null; to: string | null } }>(
    client.db,
    sql`SELECT to_state AS "toState", metadata FROM transaction_logs
        WHERE entity_type = 'receiving_invoice_item_cn' AND entity_id = ${itemId}
        ORDER BY created_date`
  );
  assert.deepEqual(logs.map((l) => l.toState), ["admin_edit", "admin_edit"]);
  assert.deepEqual(
    logs.map((l) => l.metadata.field),
    ["date_code", "coo"]
  );
  assert.equal(logs[0].metadata.from, "2641");
  assert.equal(logs[0].metadata.to, "2652");

  // "" also clears; a no-change field writes no audit row.
  const res2 = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateCode: "2652", ctnNo: "CTN-7" }),
  });
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { dateCode: string | null; ctnNo: string | null };
  assert.equal(body2.dateCode, "2652"); // unchanged value → no new audit row for it
  assert.equal(body2.ctnNo, "CTN-7");
  const logs2 = await queryAll<{ metadata: { field: string } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'receiving_invoice_item_cn' AND entity_id = ${itemId}`
  );
  assert.deepEqual(logs2.map((l) => l.metadata.field).sort(), ["coo", "ctn_no", "date_code"]);
});

test("item edit: unknown id → 404; empty body → 400; non-string value → 400", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const missing = await app.request("/admin/receiving-cn/items/nope", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateCode: "2652" }),
  });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /receiving_cn_item_not_found/);

  await seedCnOrderByBatch("TE-EDIT-2");
  const empty = await app.request(`/admin/receiving-cn/items/${await itemIdOf("TE-EDIT-2")}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  const badType = await app.request(`/admin/receiving-cn/items/${await itemIdOf("TE-EDIT-2")}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateCode: 42 }),
  });
  assert.equal(badType.status, 400);
  assert.match(await badType.text(), /dateCode must be a string/);
});

test("item edit: subInventory sets after org_info validation, clears via null, audits the field", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  await seedCnOrderByBatch("TE-SUBINV-1");
  const itemId = await itemIdOf("TE-SUBINV-1");

  // Seed a second sub-inventory for the item's org (2).
  await client.db.execute(
    sql`INSERT INTO org_info (id, org_id, secondary_inventory_name) VALUES ('test-orginfo-cn-1', 2, 'CNSTORE9')`
  );

  // Invalid pair (org 2 has no NOPE-SUB) → 400.
  const bad = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subInventory: "NOPE-SUB" }),
  });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /invalid_sub_inventory/);

  // Set the valid pair (trimmed).
  const set = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subInventory: "  CNSTORE9  " }),
  });
  assert.equal(set.status, 200);
  const setBody = (await set.json()) as { subInventoryCode: string };
  assert.equal(setBody.subInventoryCode, "CNSTORE9");

  // Clear via null.
  const cleared = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subInventory: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { subInventoryCode: string | null }).subInventoryCode, null);

  const logs = await queryAll<{ metadata: { field: string; from: string | null; to: string | null } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'receiving_invoice_item_cn' AND entity_id = ${itemId}
        ORDER BY created_date`
  );
  const subLogs = logs.filter((l) => l.metadata.field === "sub_inventory_code");
  assert.equal(subLogs.length, 2);
  assert.equal(subLogs[0].metadata.from, "STORE1");
  assert.equal(subLogs[0].metadata.to, "CNSTORE9");
  assert.equal(subLogs[1].metadata.to, null);
});

// --- order audit logs -----------------------------------------------------------------

async function patchItem(token: string, itemId: string, body: unknown): Promise<void> {
  const res = await app.request(`/admin/receiving-cn/items/${itemId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
}

test("order logs: order + item-edit (+ task/workflow) rows, partNo on item rows", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const orderId = await seedCnOrderByBatch("TE-LOGS-1", { withTask: true });
  const itemId = await itemIdOf("TE-LOGS-1");
  await patchItem(token, itemId, { dateCode: "2652" });
  // What finalizeCnOrder writes for real (covered in the cron tests): an
  // order transition row + a task-creation row referencing the order in its
  // metadata.
  const operatorId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`))!.id;
  await client.db.insert(transactionLogs).values([
    {
      id: "tl-cn-order-1",
      entityType: "receiving_order_cn",
      entityId: orderId,
      fromState: "pending",
      toState: "in_hand",
      actorId: operatorId,
    },
    {
      id: "tl-cn-task-1",
      entityType: "put_away_task_cn",
      entityId: "cn-task-TE-LOGS-1",
      toState: "pending",
      metadata: { receivingOrderCnId: orderId },
      actorId: operatorId,
    },
  ]);

  const res = await app.request("/admin/receiving-cn/orders/TE-LOGS-1/logs", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as {
    entityType: string;
    toState: string;
    partNo: string | null;
    actorName: string | null;
  }[];
  const byType = new Map(rows.map((r) => [r.entityType, r]));
  assert.ok(byType.has("receiving_order_cn")); // finalize order transition
  assert.ok(byType.has("receiving_invoice_item_cn")); // the item edit
  assert.ok(byType.has("put_away_task_cn")); // task creation, matched via metadata
  const itemRow = byType.get("receiving_invoice_item_cn")!;
  assert.equal(itemRow.partNo, "RK73B1JTTD181G"); // item display = part no
  assert.equal(itemRow.toState, "admin_edit");
  assert.equal(itemRow.actorName, "Demo Admin");

  // Unknown batch → 404.
  const missing = await app.request("/admin/receiving-cn/orders/NO-SUCH/logs", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /receiving_cn_order_not_found/);
});

test("order logs: paged mode respects page/pageSize; q filters actor/metadata", async () => {
  await reseed(client);
  const token = await login("admin", "DocPalAdmin2026!");
  const orderId = await seedCnOrderByBatch("TE-LOGS-2");
  const itemId = await itemIdOf("TE-LOGS-2");
  await patchItem(token, itemId, { dateCode: "2652" });
  await patchItem(token, itemId, { ctnNo: "CTN-9" });
  await client.db.execute(
    sql`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state)
        VALUES ('tl-cn-order-2', 'receiving_order_cn', ${orderId}, 'pending', 'in_hand')`
  );

  const paged = await app.request("/admin/receiving-cn/orders/TE-LOGS-2/logs?page=1&pageSize=2", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(paged.status, 200);
  const pageBody = (await paged.json()) as { rows: { entityType: string }[]; total: number };
  assert.equal(pageBody.rows.length, 2); // pageSize cap
  assert.equal(pageBody.total, 3); // order transition + 2 item edits

  // q without page → full filtered array (same convention as the standard
  // /admin/receiving-orders/:id/logs).
  const q = await app.request("/admin/receiving-cn/orders/TE-LOGS-2/logs?q=ctn_no", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(q.status, 200);
  const qRows = (await q.json()) as { metadata: { field: string } }[];
  assert.ok(Array.isArray(qRows));
  assert.ok(qRows.length >= 1);
  assert.ok(qRows.every((r) => JSON.stringify(r.metadata).includes("ctn_no")));

  const qActor = await app.request("/admin/receiving-cn/orders/TE-LOGS-2/logs?q=Demo Admin", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const qActorRows = (await qActor.json()) as { actorName: string | null }[];
  assert.ok(Array.isArray(qActorRows));
  assert.ok(qActorRows.length >= 2); // both item edits by Demo Admin
  assert.ok(qActorRows.every((r) => r.actorName === "Demo Admin"));
});
