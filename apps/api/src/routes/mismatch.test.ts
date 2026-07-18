import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const { sql, db } = await createTestDb();

const T0 = "2024-01-01T00:00:00Z";

await db.execute(`
  INSERT INTO users (id, username, password_hash, display_name, created_at)
    VALUES ('reporter5','reporter5','h','Reporter','${T0}'),
           ('other5','other5','h','Other','${T0}');
  INSERT INTO parts (id, part_no) VALUES ('p5','P5');
  INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro5','RO-5','in_hand','${T0}','${T0}');
  INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv5','ro5','INV-5','${T0}','${T0}');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
    VALUES ('rii5','inv5','p5',10,10), ('rii5b','inv5','p5',10,10);
`);

const post = (url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  app.request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET /receiving-invoice-items/:id/mismatch returns null when none, 404 for unknown item", async () => {
  const none = await app.request("/receiving-invoice-items/rii5/mismatch");
  assert.equal(none.status, 200);
  assert.equal(await none.json(), null);
  const missing = await app.request("/receiving-invoice-items/nope/mismatch");
  assert.equal(missing.status, 404);
});

test("POST creates the inline mismatch (201) as snake_case; duplicate is 409", async () => {
  const res = await post("/receiving-invoice-items/rii5/mismatch", {
    reason: "qty_mismatch", mismatch_qty: 8, note: " short ", actor_id: "reporter5",
  });
  assert.equal(res.status, 201);
  const row = (await res.json()) as any;
  assert.deepEqual(row, {
    receiving_invoice_item_id: "rii5",
    reason: "qty_mismatch",
    mismatch_qty: 8,
    wrong_part_no: null,
    note: "short",
    effective_received_qty: 8,
    reported: true,
  });

  const dup = await post("/receiving-invoice-items/rii5/mismatch", { reason: "damaged", mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(dup.status, 409);

  const get = await app.request("/receiving-invoice-items/rii5/mismatch");
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), row);
});

test("POST validation: unknown reason 400, missing actor_id 400, malformed JSON 400, missing reason 400", async () => {
  const unknown = await post("/receiving-invoice-items/rii5b/mismatch", { reason: "bogus", mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(unknown.status, 400);
  const noActor = await post("/receiving-invoice-items/rii5b/mismatch", { reason: "damaged", mismatch_qty: 1 });
  assert.equal(noActor.status, 400);
  const badJson = await post("/receiving-invoice-items/rii5b/mismatch", "{nope");
  assert.equal(badJson.status, 400);
  const noReason = await post("/receiving-invoice-items/rii5b/mismatch", { mismatch_qty: 1, actor_id: "reporter5" });
  assert.equal(noReason.status, 400);
  // all rejected: rii5b still has no mismatch
  const get = await app.request("/receiving-invoice-items/rii5b/mismatch");
  assert.equal(await get.json(), null);
});

test("PATCH edits the reported mismatch (any actor); 409 when nothing is reported", async () => {
  const none = await patch("/receiving-invoice-items/rii5b/mismatch", { mismatch_qty: 5, actor_id: "reporter5" });
  assert.equal(none.status, 409);

  // the inline model stores no reporter, so the old reporter-only rule is gone
  const res = await patch("/receiving-invoice-items/rii5/mismatch", { reason: "damaged", mismatch_qty: 3, actor_id: "other5" });
  assert.equal(res.status, 200);
  const row = (await res.json()) as any;
  assert.equal(row.receiving_invoice_item_id, "rii5");
  assert.equal(row.reason, "damaged");
  assert.equal(row.mismatch_qty, 3);
  assert.equal(row.effective_received_qty, 7);
  assert.equal(row.reported, true);
});

test("the confirm endpoint is gone (404)", async () => {
  const res = await post("/receiving-invoice-items/rii5/mismatch/confirm", { actor_id: "other5" });
  assert.equal(res.status, 404);
  const legacy = await post("/mismatches/whatever/confirm", { actor_id: "other5" });
  assert.equal(legacy.status, 404);
});

test("cancel clears the mismatch (200); 409 when nothing is reported, 400 without actor", async () => {
  const res = await post("/receiving-invoice-items/rii5/mismatch/cancel", { actor_id: "other5" });
  assert.equal(res.status, 200);
  const row = (await res.json()) as any;
  assert.equal(row.receiving_invoice_item_id, "rii5");
  assert.equal(row.reported, false);
  assert.equal(row.reason, null);
  assert.equal(row.mismatch_qty, null);
  assert.equal(row.wrong_part_no, null);
  // received_qty restored to the document qty
  assert.equal(row.effective_received_qty, 10);

  const get = await app.request("/receiving-invoice-items/rii5/mismatch");
  assert.equal(await get.json(), null);

  const again = await post("/receiving-invoice-items/rii5/mismatch/cancel", { actor_id: "other5" });
  assert.equal(again.status, 409);

  const noActor = await post("/receiving-invoice-items/rii5/mismatch/cancel", {});
  assert.equal(noActor.status, 400);
});

test.after(async () => {
  await sql.end();
  const { sql: appSql } = await import("../db.js");
  await appSql.end();
});
