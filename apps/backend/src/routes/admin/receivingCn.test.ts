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

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];

const WORKFLOW_TOKEN = "workflow-service-token";
const EXCEL_WORKFLOW_ID = "cn-excel-def-1";

// --- fake DocPal workflow server ----------------------------------------------

interface FakeWorkflowState {
  startFails: boolean;
  processState: string;
  requests: { method: string; url: string; body: string }[];
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
      fake.requests.push({ method: req.method ?? "", url: req.url ?? "", body: raw });
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
      orderNo: "7004951243",
      cartonNo: "1",
      partNo: "iC-HAUS-001",
      dateCode: "2641",
      qty: "500",
      weight: "1.5",
      office: "2",
      poNo: "7004951243",
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
    { ...VALID_PAYLOAD, items: [{ ...VALID_PAYLOAD.items[0], orderNo: undefined }] },
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
      createdBy: string;
    }>(
      client.db,
      sql`SELECT phase, status, invoice_no AS "invoiceNo", supplier, filename,
                 docpal_document_id AS "docpalDocumentId", docpal_process_id AS "docpalProcessId",
                 docpal_business_key AS "docpalBusinessKey", created_by AS "createdBy"
          FROM receiving_cn_workflows WHERE id = ${id}`
    );
    assert.equal(row!.phase, "excel");
    assert.equal(row!.status, "workflow_running");
    assert.equal(row!.invoiceNo, "TE20261010-2");
    assert.equal(row!.supplier, "TE");
    assert.equal(row!.docpalDocumentId, "doc-1");
    assert.equal(row!.docpalProcessId, "proc-1");
    assert.equal(row!.docpalBusinessKey, "bk-1");
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
    assert.equal(startBody.variables.excel_result_data.invoiceNo, "TE20261010-2");
    assert.equal(startBody.variables.excelFiles[0].id, "doc-1");
    assert.equal(startBody.variables.excelFiles[0].extension, "xls");
    assert.equal(startBody.variables.excelFiles[0].mime_type, "application/vnd.ms-excel");
    assert.equal(startBody.variables.excelFiles[0].response.data.fileContentExtension, "xls");
    // Bearer service token on both the upload and the kick.
    const uploadReq = fake.requests.find((r) => r.method === "POST" && r.url === "/api/docpal/workflow/upload/file");
    assert.match(String(uploadReq?.body), /fake-xls-bytes/);

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
