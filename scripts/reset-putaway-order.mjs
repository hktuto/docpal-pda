// Reset a put-away flow for one receiving order back to a fresh slate:
// deletes PUT_AWAY ledger rows, the materialized lots (+ sources + derived
// goods-verify tasks) and all shelf_box_items scans, zeroes put_away_qty,
// and restores the receiving order to 'in_hand' + the put-away task to
// 'pending'. Allocation rows touching the order's items are deleted too.
//
// Usage:
//   DATABASE_URL=postgresql://warehouse:warehouse@192.168.3.99:5432/warehouse_backend \
//     node scripts/reset-putaway-order.mjs <receivingOrderId>
//
// Dev convenience (uses apps/backend's node_modules for the postgres driver):
//   run from the repo root.

import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/backend/package.json", import.meta.url));
const { default: postgresDriver } = await import(require.resolve("postgres"));

const orderId = process.argv[2];
if (!orderId) {
  console.error("usage: node scripts/reset-putaway-order.mjs <receivingOrderId>");
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgresDriver(connectionString, { max: 1 });
const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase();

try {
  await sql.begin(async (tx) => {
    const items = await tx`
      SELECT rii.id FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${orderId}`;
    if (items.length === 0) throw new Error(`no items found for order ${orderId}`);
    const itemIds = items.map((r) => r.id);
    console.log(`order items: ${itemIds.length}`);

    const led = await tx`DELETE FROM inventory_transactions
      WHERE txn_type = 'PUT_AWAY' AND receiving_invoice_item_id IN ${sql(itemIds)} RETURNING id`;
    console.log(`deleted PUT_AWAY ledger rows: ${led.length}`);

    const allocs = await tx`DELETE FROM allocations
      WHERE receiving_invoice_item_id IN ${sql(itemIds)} RETURNING id`;
    console.log(`deleted allocations: ${allocs.length}`);

    const lotRows = await tx`SELECT DISTINCT ils.inventory_lot_id AS lid
      FROM inventory_lot_sources ils WHERE ils.receiving_invoice_item_id IN ${sql(itemIds)}`;
    for (const { lid } of lotRows) {
      const gvt = await tx`DELETE FROM goods_verify_tasks WHERE inventory_lot_id = ${lid} RETURNING id`;
      const ita = await tx`DELETE FROM internal_transfer_allocations WHERE inventory_lot_id = ${lid} RETURNING id`;
      const srcs = await tx`DELETE FROM inventory_lot_sources WHERE inventory_lot_id = ${lid} RETURNING id`;
      await tx`DELETE FROM inventory_lots WHERE id = ${lid}`;
      console.log(`deleted lot ${lid} (sources: ${srcs.length}, goods_verify_tasks: ${gvt.length}, internal_transfer_allocations: ${ita.length})`);
    }

    const scans = await tx`DELETE FROM shelf_box_items
      WHERE receiving_invoice_item_id IN ${sql(itemIds)} RETURNING id`;
    console.log(`deleted scans: ${scans.length}`);

    await tx`UPDATE receiving_invoice_items SET put_away_qty = 0 WHERE id IN ${sql(itemIds)}`;
    await tx`UPDATE receiving_orders SET status = 'in_hand', last_update_date = now() WHERE id = ${orderId}`;
    await tx`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, created_date)
             VALUES (${newId()}, 'receiving_order', ${orderId}, 'clear', 'in_hand', NULL, now())`;
    await tx`UPDATE put_away_tasks SET status = 'pending', last_update_date = now() WHERE receiving_order_id = ${orderId}`;
    await tx`INSERT INTO transaction_logs (id, entity_type, entity_id, from_state, to_state, actor_id, created_date)
             VALUES (${newId()}, 'put_away_task',
               (SELECT id FROM put_away_tasks WHERE receiving_order_id = ${orderId}), 'completed', 'pending', NULL, now())`;

    console.log("final:", JSON.stringify({
      order: (await tx`SELECT status FROM receiving_orders WHERE id = ${orderId}`)[0],
      task: (await tx`SELECT status FROM put_away_tasks WHERE receiving_order_id = ${orderId}`)[0],
      items: await tx`SELECT id, received_qty, put_away_qty FROM receiving_invoice_items WHERE id IN ${sql(itemIds)}`,
      scansLeft: (await tx`SELECT COUNT(*)::int c FROM shelf_box_items WHERE receiving_invoice_item_id IN ${sql(itemIds)}`)[0].c,
      lotsLeft: (await tx`SELECT COUNT(*)::int c FROM inventory_lot_sources WHERE receiving_invoice_item_id IN ${sql(itemIds)}`)[0].c,
      ledgerLeft: (await tx`SELECT COUNT(*)::int c FROM inventory_transactions WHERE txn_type = 'PUT_AWAY' AND receiving_invoice_item_id IN ${sql(itemIds)}`)[0].c,
    }));
  });
  console.log("RESET COMMITTED");
} catch (e) {
  console.error("ROLLED BACK:", e.message);
  process.exit(1);
}
await sql.end();
