#!/usr/bin/env node
// Test-reset: revert ONE receiving order's put-away back to a re-testable
// state — order `in_hand` on the dock with a pending put-away task, as if
// confirm-arrival had just run. Arrival itself is NOT undone (received_qty,
// RECEIVE_TO_DOCK ledger rows and arrived_at stay).
//
// Usage:
//   node scripts/reset-receiving-putaway.mjs <DATABASE_URL> <order-id-or-batch-no> [--dry-run] [--keep-audit]
//   node scripts/reset-receiving-putaway.mjs postgres://warehouse:warehouse@192.168.3.99:5432/warehouse_backend 01J...
//
// What it does, in one transaction — the bulk inverse of the put-away flow
// (mirrors `removeScanFromBox` + `deleteStagedPutAwayScan` in
// apps/backend/src/db/putaway.ts, applied to every scan of the order):
//   1. Guards: refuses when any of the order's items were already picked
//      (picked_qty > 0 or picking_packages reference the order/items) — reset
//      those picking orders with scripts/reset-picking-order.mjs first — or
//      when a shelf lot sourced from this order still has pick allocations
//      (same 409 lot_has_pick_allocations guard as removeScanFromBox).
//   2. Un-put-away: for every inventory_lot_sources row of the order's items,
//      subtract the qty from the lot (deleting the lot when it empties —
//      ledger rows detached first, goods_verify_tasks rows removed), then
//      deletes the order's shelf_box_items scan rows (staged and boxed) and
//      zeroes receiving_invoice_items.put_away_qty.
//   3. Boxes: deletes touched shelf_boxes that are now empty (staging boxes
//      included — re-created on the next scan); surviving boxes get their
//      verification flags reset (verified → closed, items unverified).
//   4. Task + order: put_away_tasks back to 'pending' (re-inserted when
//      missing), receiving_orders 'clear' → 'in_hand'.
//   5. Unless --keep-audit: removes the PUT_AWAY inventory_transactions of
//      the order's items and the put-away-related transaction_logs
//      (put_away_task, touched shelf_boxes, the order's →clear transition).
//
// Dock-typed allocations (receiving_order_id / receiving_invoice_item_id) are
// left alone — arrival is not reverted, so that availability still exists.
//
// Missing-source tolerance: rows the UAT nightly inventory reset may have
// deleted (lots, lot sources, scan rows) are skipped with a warning instead
// of aborting; the counters are still zeroed.
//
// The `postgres` driver is resolved from apps/backend (same version the
// backend runs), so run this from anywhere in the repo.

import { createRequire } from "node:module";

const require = createRequire(
  new URL("../apps/backend/package.json", import.meta.url)
);
const postgres = require("postgres");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keepAudit = args.includes("--keep-audit");
const positionalArgs = args.filter((a) => !a.startsWith("--"));

const [connectionString, orderRef] = positionalArgs;
if (!connectionString || !orderRef) {
  console.error(
    "Usage: node scripts/reset-receiving-putaway.mjs <DATABASE_URL> <order-id-or-batch-no> [--dry-run] [--keep-audit]"
  );
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

async function loadOrder() {
  const byId = await sql`
    SELECT id, batch_no, org_id, status FROM receiving_orders WHERE id = ${orderRef}
  `;
  if (byId.length === 1) return byId[0];
  const byNo = await sql`
    SELECT id, batch_no, org_id, status FROM receiving_orders WHERE batch_no = ${orderRef} ORDER BY created_date
  `;
  if (byNo.length === 1) return byNo[0];
  if (byNo.length > 1)
    throw new Error(`batch_no "${orderRef}" matches ${byNo.length} orders — pass the order id instead`);
  throw new Error(`receiving order not found: ${orderRef}`);
}

/** All receiving_invoice_item ids of the order (throws when empty). */
async function loadItemIds(q, orderId) {
  const rows = await q`
    SELECT rii.id FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId}
  `;
  if (rows.length === 0) throw new Error("order has no invoice items");
  return rows.map((r) => r.id);
}

async function preview(order) {
  const itemIds = await loadItemIds(sql, order.id);
  const items = await sql`
    SELECT count(*)::int AS n,
           COALESCE(SUM(received_qty), 0)::int AS received,
           COALESCE(SUM(put_away_qty), 0)::int AS put_away,
           COALESCE(SUM(picked_qty), 0)::int AS picked
    FROM receiving_invoice_items WHERE id IN ${sql(itemIds)}
  `;
  const scans = await sql`
    SELECT sbi.id, sbi.qty, sb.shelf_code
    FROM shelf_box_items sbi JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
    WHERE sbi.receiving_invoice_item_id IN ${sql(itemIds)}
  `;
  const staged = scans.filter((s) => s.shelf_code === null);
  const boxed = scans.filter((s) => s.shelf_code !== null);
  const lotRows = await sql`
    SELECT ils.inventory_lot_id AS lot_id, SUM(ils.qty)::int AS qty
    FROM inventory_lot_sources ils
    WHERE ils.receiving_invoice_item_id IN ${sql(itemIds)}
    GROUP BY ils.inventory_lot_id
  `;
  const tasks = await sql`
    SELECT id, status FROM put_away_tasks WHERE receiving_order_id = ${order.id}
  `;
  const pickPkgs = await sql`
    SELECT count(*)::int AS n FROM picking_packages
    WHERE (source_type = 'receiving_order' AND source_id = ${order.id})
       OR (source_type = 'receiving_invoice_item' AND source_id IN ${sql(itemIds)})
  `;
  const lotAllocs = await sql`
    SELECT count(*)::int AS n FROM allocations
    WHERE inventory_lot_id IN (
      SELECT inventory_lot_id FROM inventory_lot_sources
      WHERE receiving_invoice_item_id IN ${sql(itemIds)})
  `;
  const itxn = await sql`
    SELECT count(*)::int AS n FROM inventory_transactions
    WHERE txn_type = 'PUT_AWAY' AND receiving_invoice_item_id IN ${sql(itemIds)}
  `;
  console.log(`Order:        ${order.id} (${order.batch_no}) — status "${order.status}" → "in_hand"`);
  console.log(`Items:        ${items[0].n} (received ${items[0].received}, put away ${items[0].put_away}, picked ${items[0].picked})`);
  console.log(`Scans:        ${scans.length} (${staged.length} staged, ${boxed.length} boxed) to delete`);
  console.log(`Lots:         ${lotRows.length} to shrink/delete (−${lotRows.reduce((s, r) => s + r.qty, 0)} pcs)`);
  console.log(`Task:         ${tasks.length ? `${tasks[0].status} → pending` : "none — will be re-created"}`);
  if (items[0].picked > 0 || pickPkgs[0].n > 0)
    console.log("WARNING: items already picked — the reset will REFUSE; reset the picking orders first.");
  if (lotAllocs[0].n > 0)
    console.log(`WARNING: ${lotAllocs[0].n} pick allocations sit on this order's shelf lots — the reset will REFUSE; reset those picking orders first.`);
  console.log(`Audit rows:   ${itxn[0].n} PUT_AWAY inventory_transactions + put-away transaction_logs ${keepAudit ? "(kept)" : "(deleted)"}`);
}

async function reset(order) {
  await sql.begin(async (tx) => {
    const itemIds = await loadItemIds(tx, order.id);

    // --- 1. Guards -----------------------------------------------------------
    const picked = await tx`
      SELECT COALESCE(SUM(picked_qty), 0)::int AS n FROM receiving_invoice_items WHERE id IN ${sql(itemIds)}
    `;
    const pickPkgs = await tx`
      SELECT count(*)::int AS n FROM picking_packages
      WHERE (source_type = 'receiving_order' AND source_id = ${order.id})
         OR (source_type = 'receiving_invoice_item' AND source_id IN ${sql(itemIds)})
    `;
    if (picked[0].n > 0 || pickPkgs[0].n > 0)
      throw new Error(
        `order items are already picked (${picked[0].n} pcs, ${pickPkgs[0].n} picking packages) — reset those picking orders with scripts/reset-picking-order.mjs first`
      );
    const lotAllocs = await tx`
      SELECT DISTINCT pi.picking_order_id AS order_id
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE a.inventory_lot_id IN (
        SELECT inventory_lot_id FROM inventory_lot_sources
        WHERE receiving_invoice_item_id IN ${sql(itemIds)})
    `;
    if (lotAllocs.length > 0)
      throw new Error(
        `shelf lots sourced from this order still have pick allocations from picking order(s): ${lotAllocs.map((r) => r.order_id).join(", ")} — reset them with scripts/reset-picking-order.mjs first`
      );

    // --- 2. Un-put-away: reverse lot materialization -------------------------
    const srcRows = await tx`
      SELECT ils.inventory_lot_id AS lot_id, SUM(ils.qty)::int AS qty
      FROM inventory_lot_sources ils
      WHERE ils.receiving_invoice_item_id IN ${sql(itemIds)}
      GROUP BY ils.inventory_lot_id
    `;
    let shrunkLots = 0, deletedLots = 0, deletedGoodsVerify = 0, missingSources = 0;
    for (const src of srcRows) {
      const lot = await tx`SELECT id, total_qty AS "totalQty" FROM inventory_lots WHERE id = ${src.lot_id}`;
      if (lot.length === 0) {
        console.warn(`  ! lot ${src.lot_id} no longer exists (nightly reset?) — skipping stock subtraction`);
        missingSources++;
        continue;
      }
      if (lot[0].totalQty - src.qty <= 0) {
        // Emptied lot is deleted. Detach ledger rows first (no FK cascade)
        // and drop goods-verify tasks referencing it (also no cascade).
        await tx`UPDATE inventory_transactions SET inventory_lot_id = NULL WHERE inventory_lot_id = ${src.lot_id}`;
        const gvt = await tx`DELETE FROM goods_verify_tasks WHERE inventory_lot_id = ${src.lot_id}`;
        deletedGoodsVerify += gvt.count;
        await tx`DELETE FROM inventory_lots WHERE id = ${src.lot_id}`;
        deletedLots++;
      } else {
        await tx`UPDATE inventory_lots SET total_qty = total_qty - ${src.qty}, last_update_date = now() WHERE id = ${src.lot_id}`;
        shrunkLots++;
      }
    }
    await tx`DELETE FROM inventory_lot_sources WHERE receiving_invoice_item_id IN ${sql(itemIds)}`;

    const scans = await tx`
      SELECT sbi.id, sbi.shelf_box_id FROM shelf_box_items sbi
      WHERE sbi.receiving_invoice_item_id IN ${sql(itemIds)}
    `;
    const boxIds = [...new Set(scans.map((s) => s.shelf_box_id))];
    await tx`DELETE FROM shelf_box_items WHERE receiving_invoice_item_id IN ${sql(itemIds)}`;
    await tx`
      UPDATE receiving_invoice_items SET put_away_qty = 0, last_update_date = now()
      WHERE id IN ${sql(itemIds)} AND put_away_qty <> 0
    `;

    // --- 3. Boxes -------------------------------------------------------------
    let deletedBoxes = 0, resetBoxes = 0;
    const deletedBoxIds = [];
    for (const boxId of boxIds) {
      const remaining = await tx`
        SELECT count(*)::int AS n FROM shelf_box_items WHERE shelf_box_id = ${boxId}
      `;
      if (remaining[0].n === 0) {
        await tx`DELETE FROM shelf_boxes WHERE id = ${boxId}`;
        deletedBoxIds.push(boxId);
        deletedBoxes++;
      } else {
        await tx`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${boxId}`;
        await tx`UPDATE shelf_boxes SET status = 'closed', last_update_date = now() WHERE id = ${boxId} AND status = 'verified'`;
        resetBoxes++;
      }
    }

    // --- 4. Task + order -------------------------------------------------------
    const existingTasks = await tx`
      SELECT id FROM put_away_tasks WHERE receiving_order_id = ${order.id}
    `;
    let taskId, taskNote;
    if (existingTasks.length > 0) {
      taskId = existingTasks[0].id;
      await tx`UPDATE put_away_tasks SET status = 'pending', last_update_date = now() WHERE id = ${taskId}`;
      taskNote = "reset to pending";
    } else {
      const pair = await tx`
        SELECT COUNT(DISTINCT sub_inventory_code)::int AS n,
               MIN(sub_inventory_code) AS code
        FROM receiving_invoice_items WHERE id IN ${sql(itemIds)}
      `;
      taskId = crypto.randomUUID();
      await tx`
        INSERT INTO put_away_tasks (id, receiving_order_id, org_id, sub_inventory_code, status, created_date, last_update_date)
        VALUES (${taskId}, ${order.id}, ${order.org_id}, ${pair[0].n === 1 ? pair[0].code : null}, 'pending', now(), now())
      `;
      taskNote = "re-created as pending";
    }
    if (order.status === "clear") {
      await tx`
        UPDATE receiving_orders SET status = 'in_hand', last_update_date = now() WHERE id = ${order.id}
      `;
    } else if (order.status !== "in_hand") {
      console.warn(`  ! order status is "${order.status}" (expected in_hand|clear) — leaving it unchanged`);
    }

    // --- 5. Audit cleanup ------------------------------------------------------
    let delItxn = { count: 0 }, delLogs = { count: 0 };
    if (!keepAudit) {
      delItxn = await tx`
        DELETE FROM inventory_transactions
        WHERE txn_type = 'PUT_AWAY' AND receiving_invoice_item_id IN ${sql(itemIds)}
      `;
      const logBoxIds = boxIds.length ? boxIds : ["∅"]; // touched boxes (deleted + surviving); "∅" = match none
      delLogs = await tx`
        DELETE FROM transaction_logs
        WHERE (entity_type = 'receiving_order' AND entity_id = ${order.id} AND to_state = 'clear')
           OR (entity_type = 'put_away_task' AND entity_id = ${taskId})
           OR (entity_type = 'shelf_box' AND entity_id IN ${sql(logBoxIds)})
      `;
    }

    console.log("Done:");
    console.log(`  scans deleted:                  ${scans.length}`);
    console.log(`  lots shrunk:                    ${shrunkLots}, lots deleted: ${deletedLots} (goods-verify tasks removed: ${deletedGoodsVerify})`);
    if (missingSources > 0)
      console.log(`  missing lots skipped:           ${missingSources}`);
    console.log(`  boxes deleted:                  ${deletedBoxes}, boxes un-verified: ${resetBoxes}`);
    console.log(`  put-away task:                  ${taskNote}`);
    console.log(`  order status:                   ${order.status === "clear" ? "clear → in_hand" : `${order.status} (unchanged)`}`);
    if (!keepAudit)
      console.log(`  audit rows deleted:             ${delItxn.count} inventory_transactions + ${delLogs.count} transaction_logs`);
  });

  console.log(`\nOrder ${order.id} is ready to re-test put-away — status "in_hand" with a pending put-away task.`);
}

try {
  const order = await loadOrder();
  if (dryRun) await preview(order);
  else await reset(order);
} catch (err) {
  console.error("Reset failed (transaction rolled back):", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
