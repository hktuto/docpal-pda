import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { updatePickingDeliveryDate, updateReceivingItemDateCode } from "./adminedits.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

test("admin edits: set and clear picking order delivery date + audit row", async () => {
  await reseed(client);
  const orderId = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = 'SO-2026-0001'`
  ))!.id;
  const actorId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'admin'`))!.id;

  const set = await updatePickingDeliveryDate(client.db, { orderId, deliveryDate: "2026-08-01", actorId });
  assert.equal(set.deliveryDate, "2026-08-01");
  const row = await queryGet<{ d: string }>(
    client.db,
    sql`SELECT delivery_date::date::text AS d FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(row!.d, "2026-08-01");

  const log = await queryGet<{ toState: string; metadata: { field: string; to: string }; actorId: string }>(
    client.db,
    sql`SELECT to_state AS "toState", metadata, actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId}
        ORDER BY created_at DESC LIMIT 1`
  );
  assert.equal(log!.toState, "admin_edit");
  assert.equal(log!.metadata.field, "delivery_date");
  assert.equal(log!.metadata.to, "2026-08-01");
  assert.equal(log!.actorId, actorId);

  const cleared = await updatePickingDeliveryDate(client.db, { orderId, deliveryDate: null, actorId });
  assert.equal(cleared.deliveryDate, null);

  const bad = await catchHttp(updatePickingDeliveryDate(client.db, { orderId, deliveryDate: "01/08/2026", actorId }));
  assert.equal(bad.status, 400);
  const missing = await catchHttp(updatePickingDeliveryDate(client.db, { orderId: "nope", deliveryDate: null, actorId }));
  assert.equal(missing.status, 404);
});

test("admin edits: set and clear receiving invoice item date code + audit row", async () => {
  await reseed(client);
  const itemId = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE ro.batch_no = '65878' LIMIT 1`
  ))!.id;
  const actorId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'admin'`))!.id;

  const set = await updateReceivingItemDateCode(client.db, { itemId, dateCode: "2608", actorId });
  assert.equal(set.dateCode, "2608");
  const row = await queryGet<{ d: string | null }>(
    client.db,
    sql`SELECT date_code AS d FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(row!.d, "2608");

  const log = await queryGet<{ metadata: { field: string; to: string } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'receiving_invoice_item' AND entity_id = ${itemId}
        ORDER BY created_at DESC LIMIT 1`
  );
  assert.equal(log!.metadata.field, "date_code");
  assert.equal(log!.metadata.to, "2608");

  const cleared = await updateReceivingItemDateCode(client.db, { itemId, dateCode: null, actorId });
  assert.equal(cleared.dateCode, null);

  const missing = await catchHttp(updateReceivingItemDateCode(client.db, { itemId: "nope", dateCode: "2608", actorId }));
  assert.equal(missing.status, 404);
});
