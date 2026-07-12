import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const sqlite = new Database(dbPath);

sqlite.exec(`
  INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
    VALUES ('reporter5','reporter5','h','operator','Reporter','0','0'),
           ('confirmer5','confirmer5','h','operator','Confirmer','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p5','P5','P5','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro5','e5','RO-5','in_hand','0','0');
  INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv5','ro5','INV-5','0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
    VALUES ('rii5','inv5','p5',10,10,10,'0','0'), ('rii5b','inv5','p5',10,10,10,'0','0');
`);

const post = (url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  app.request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

let m5Id: string;

test("GET /receiving-invoice-items/:id/mismatch returns null when none, 404 for unknown item", async () => {
  const none = await app.request("/receiving-invoice-items/rii5/mismatch");
  assert.equal(none.status, 200);
  assert.equal(await none.json(), null);
  const missing = await app.request("/receiving-invoice-items/nope/mismatch");
  assert.equal(missing.status, 404);
});

test("POST creates a snake_case mismatch row (201); duplicate is 409", async () => {
  const res = await post("/receiving-invoice-items/rii5/mismatches", {
    reason: "qty_mismatch", mismatch_qty: 8, note: " short ", actor_id: "reporter5",
  });
  assert.equal(res.status, 201);
  const row = (await res.json()) as any;
  m5Id = row.id;
  assert.ok(m5Id);
  assert.equal(row.receiving_invoice_item_id, "rii5");
  assert.equal(row.kind, "qty_mismatch");
  assert.equal(row.mismatch_qty, 8);
  assert.equal(row.note, "short");
  assert.equal(row.status, "pending");
  assert.equal(row.reported_by, "reporter5");
  assert.equal(row.effective_received_qty, 8);
  assert.equal(row.previous_received_qty, 10);
  assert.equal(row.confirmed_by, null);
  assert.equal(row.cancelled_by, null);
  assert.ok(row.created_at);

  const dup = await post("/receiving-invoice-items/rii5/mismatches", { reason: "damaged", mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(dup.status, 409);

  const get = await app.request("/receiving-invoice-items/rii5/mismatch");
  assert.equal((await get.json() as any).id, m5Id);
});

test("POST validation: unknown reason 400, missing actor_id 400, malformed JSON 400", async () => {
  const unknown = await post("/receiving-invoice-items/rii5b/mismatches", { reason: "bogus", mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(unknown.status, 400);
  const noActor = await post("/receiving-invoice-items/rii5b/mismatches", { reason: "damaged", mismatch_qty: 1 });
  assert.equal(noActor.status, 400);
  const badJson = await post("/receiving-invoice-items/rii5b/mismatches", "{nope");
  assert.equal(badJson.status, 400);
  const noReason = await post("/receiving-invoice-items/rii5b/mismatches", { mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(noReason.status, 400);
});

test("PATCH: non-reporter is 409, reporter edits successfully", async () => {
  const wrongActor = await patch(`/mismatches/${m5Id}`, { reason: "damaged", mismatch_qty: 3, actor_id: "confirmer5" });
  assert.equal(wrongActor.status, 409);

  const res = await patch(`/mismatches/${m5Id}`, { reason: "damaged", mismatch_qty: 3, actor_id: "reporter5" });
  assert.equal(res.status, 200);
  const row = (await res.json()) as any;
  assert.equal(row.id, m5Id);
  assert.equal(row.kind, "damaged");
  assert.equal(row.mismatch_qty, 3);
  assert.equal(row.effective_received_qty, 7);
  assert.equal(row.status, "pending");
});

test("confirm: reporter is 409, another user confirms (200)", async () => {
  const self = await post(`/mismatches/${m5Id}/confirm`, { actor_id: "reporter5" });
  assert.equal(self.status, 409);

  const res = await post(`/mismatches/${m5Id}/confirm`, { actor_id: "confirmer5" });
  assert.equal(res.status, 200);
  const row = (await res.json()) as any;
  assert.equal(row.status, "confirmed");
  assert.equal(row.confirmed_by, "confirmer5");
  assert.ok(row.confirmed_at);

  const noActor = await post(`/mismatches/${m5Id}/confirm`, {});
  assert.equal(noActor.status, 400);
});

test("cancel: another user cancels a pending mismatch (200)", async () => {
  const created = await post("/receiving-invoice-items/rii5b/mismatches", { reason: "qty_mismatch", mismatch_qty: 5, actor_id: "reporter5" });
  assert.equal(created.status, 201);
  const id = ((await created.json()) as any).id;

  const self = await post(`/mismatches/${id}/cancel`, { actor_id: "reporter5" });
  assert.equal(self.status, 409);

  const res = await post(`/mismatches/${id}/cancel`, { actor_id: "confirmer5" });
  assert.equal(res.status, 200);
  const row = (await res.json()) as any;
  assert.equal(row.status, "cancelled");
  assert.equal(row.cancelled_by, "confirmer5");
  assert.ok(row.cancelled_at);

  // cancelled rows are no longer active
  const get = await app.request("/receiving-invoice-items/rii5b/mismatch");
  assert.equal(await get.json(), null);
});

test("cleanup", () => { sqlite.close(); });
