// Print proxy tests: stub upstream print service over node:http, exercise
// src/routes/print.ts on a bare Hono app (auth middleware lives on the root
// app, so no JWT needed here). No database involved.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { printRoute } from "./routes/print.js";

let upstream: Server;
let lastRequest: { method: string; url: string; body: string } | null = null;
let savedBaseUrl: string | undefined;

const app = new Hono();
app.route("/", printRoute);

function respond(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

before(async () => {
  savedBaseUrl = process.env.PRINT_API_BASE_URL;
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastRequest = { method: req.method!, url: req.url!, body };
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/v1/printers") {
        res.end(respond(["Printer A", "Printer B"]));
      } else if (req.url === "/api/v1/templates/dynamic-print") {
        res.end(respond({ templateId: "katata-label", totalPages: 1, jobs: [{ jobId: "job-1", status: "success" }] }));
      } else if (req.url === "/api/v1/print/files") {
        res.end(respond({ jobId: "job-2", status: "success" }));
      } else if (req.url === "/api/v1/print/jobs/broken") {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: { code: "BOOM", message: "printer exploded" } }));
      } else if (req.url?.startsWith("/api/v1/print/jobs/")) {
        res.end(respond({ jobId: req.url.split("/").pop(), status: "success" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "not found" } }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as AddressInfo;
  process.env.PRINT_API_BASE_URL = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (savedBaseUrl === undefined) delete process.env.PRINT_API_BASE_URL;
  else process.env.PRINT_API_BASE_URL = savedBaseUrl;
  await new Promise((resolve) => upstream.close(resolve));
});

test("GET /print/printers passes the printer list through", async () => {
  const res = await app.request("/print/printers");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), ["Printer A", "Printer B"]);
});

test("POST /print/dynamic requires templateId and non-empty printingParams", async () => {
  let res = await app.request("/print/dynamic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ printingParams: [{}] }),
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "template_id_required");

  res = await app.request("/print/dynamic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId: "katata-label", printingParams: [] }),
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "printing_params_required");
});

test("POST /print/dynamic forwards the body to the print service", async () => {
  const payload = {
    templateId: "katata-label",
    printingParams: [{ sku: "SKU-001" }],
    printerName: "Printer A",
    copies: 2,
    mode: "auto",
  };
  const res = await app.request("/print/dynamic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { jobs: { jobId: string }[] };
  assert.equal(data.jobs[0].jobId, "job-1");
  assert.deepEqual(JSON.parse(lastRequest!.body), payload);
});

test("POST /print/files forwards multipart uploads", async () => {
  const form = new FormData();
  form.append("file", new Blob(["png-bytes"], { type: "image/png" }), "badge.png");
  form.append("printerName", "Printer A");
  const res = await app.request("/print/files", { method: "POST", body: form });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { jobId: string };
  assert.equal(data.jobId, "job-2");
  assert.match(lastRequest!.body, /png-bytes/);
});

test("GET /print/jobs/:jobId returns the upstream job", async () => {
  const res = await app.request("/print/jobs/job-9");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jobId: "job-9", status: "success" });
});

test("upstream errors surface as 502 with the upstream message", async () => {
  const res = await app.request("/print/jobs/broken");
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "print service: printer exploded");
});
