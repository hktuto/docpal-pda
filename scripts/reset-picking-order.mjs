#!/usr/bin/env node
// Test-reset: revert ONE picking order back to a re-testable state.
//
// Usage:
//   node scripts/reset-picking-order.mjs <DATABASE_URL> <order-id-or-order-no> [--dry-run]
//   node scripts/reset-picking-order.mjs postgres://warehouse:warehouse@192.168.3.99:5432/warehouse_backend 01M3X0KZQY0T8AJK6HEA5WA9SF
//   node scripts/reset-picking-order.mjs $DATABASE_URL ME2610-0048 --status pending --keep-audit
//
// What it does, in one transaction — the exact inverse of a picking run
// (mirrors `removeScannedPackage` in apps/backend/src/db/picking.ts, applied
// to every package of the order, oldest last):
//   1. Un-scan every picking_package of the order: restores the consumed
//      source qty (inventory_lots.total_qty, or receiving_invoice_items
//      .picked_qty FIFO-unwound for receiving sources), re-opens the touched
//      allocations (bump back to full qty — including manual/perfect-match
//      pins), resets shelf-box verification flags, deletes the package rows.
//   2. Deletes the order's now-empty shipping boxes (only boxes with no
//      remaining packages anywhere — cross-order packing safe), cascading
//      verify_tasks / shipping_box_items.
//   3. Resets picking_items (picked_qty / allocated_qty / status) and the
//      picking order: status → allocated (default; --status pending), lock,
//      issue and shipped fields cleared, allocation_status recomputed.
//   4. Unless --keep-audit: removes the order's transaction_logs and PICK
//      inventory_transactions so each re-test starts with a clean ledger.
//
// After it runs the order is immediately pickable again on the PDA (status
// `allocated` with full allocations). No backend re-allocation needed.
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
const statusIdx = args.indexOf("--status");
const targetStatus = statusIdx >= 0 ? args[statusIdx + 1] : "allocated";
const positionalArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--status") i++; // skip the flag's value
  else if (!args[i].startsWith("--")) positionalArgs.push(args[i]);
}

if (!["pending", "allocated"].includes(targetStatus)) {
  console.error(`--status must be pending|allocated (got "${targetStatus}")`);
  process.exit(1);
}

const [connectionString, orderRef] = positionalArgs;
if (!connectionString || !orderRef) {
  console.error(
    "Usage: node scripts/reset-picking-order.mjs <DATABASE_URL> <order-id-or-order-no> [--status pending|allocated] [--dry-run] [--keep-audit]"
  );
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

async function loadOrder() {
  const byId = await sql`
    SELECT id, order_no, status, allocation_status FROM picking_orders WHERE id = ${orderRef}
  `;
  if (byId.length === 1) return byId[0];
  const byNo = await sql`
    SELECT id, order_no, status, allocation_status FROM picking_orders WHERE order_no = ${orderRef} ORDER BY created_date
  `;
  if (byNo.length === 1) return byNo[0];
  if (byNo.length > 1)
    throw new Error(`order_no "${orderRef}" matches ${byNo.length} orders — pass the order id instead`);
  throw new Error(`picking order not found: ${orderRef}`);
}

async function preview(order) {
  const items = await sql`
    SELECT id, part_no, qty, picked_qty, allocated_qty, status
    FROM picking_items WHERE picking_order_id = ${order.id} ORDER BY created_date, id
  `;
  const pkgs = await sql`
    SELECT pp.id, pp.source_type, pp.source_id, pp.qty, pp.shipping_box_id, pp.created_date
    FROM picking_packages pp
    WHERE pp.picking_order_id = ${order.id}
    ORDER BY pp.created_date DESC, pp.id DESC
  `;
  const boxes = await sql`
    SELECT id, status, shipped_at, source_shelf_box_id
    FROM shipping_boxes
    WHERE picking_order_id = ${order.id} OR id IN (
      SELECT DISTINCT shipping_box_id FROM picking_packages
      WHERE picking_order_id = ${order.id} AND shipping_box_id IS NOT NULL
    )
  `;
  const logs = await sql`
    SELECT count(*)::int AS n FROM transaction_logs
    WHERE (entity_type = 'picking_order' AND entity_id = ${order.id})
       OR (entity_type = 'picking_item' AND entity_id IN (
         SELECT id FROM picking_items WHERE picking_order_id = ${order.id}))
  `;
  const itxn = await sql`
    SELECT count(*)::int AS n FROM inventory_transactions
    WHERE reference_type = 'picking_item' AND reference_id IN (
      SELECT id FROM picking_items WHERE picking_order_id = ${order.id})
  `;
  console.log(`Order:        ${order.id} (${order.order_no}) — status "${order.status}" → "${targetStatus}"`);
  console.log(`Items:        ${items.length} (picked ${items.reduce((s, i) => s + i.picked_qty, 0)} / ${items.reduce((s, i) => s + i.qty, 0)})`);
  console.log(`Packages:     ${pkgs.length} to un-scan and delete`);
  console.log(`Boxes:        ${boxes.length} (${boxes.map((b) => `${b.id}[${b.status}]`).join(", ") || "none"})`);
  if (boxes.some((b) => b.shipped_at))
    console.log("WARNING: a box is already shipped — the stock left the dock; restoring anyway.");
  console.log(`Audit rows:   ${logs[0].n} transaction_logs + ${itxn[0].n} inventory_transactions ${keepAudit ? "(kept)" : "(deleted)"}`);
  const sources = {};
  for (const p of pkgs) sources[p.source_type] = (sources[p.source_type] ?? 0) + p.qty;
  for (const [type, qty] of Object.entries(sources))
    console.log(`  restore ${type}: +${qty}`);
}

async function reset(order) {
  await sql.begin(async (tx) => {
    const items = await tx`
      SELECT id, part_no, qty FROM picking_items WHERE picking_order_id = ${order.id}
    `;
    const itemIds = items.map((i) => i.id);
    const itemPart = Object.fromEntries(items.map((i) => [i.id, i.part_no]));
    if (itemIds.length === 0) throw new Error("order has no items");

    // --- 1. Un-scan every package (newest first, FIFO unwind) ---------------
    const pkgs = await tx`
      SELECT id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_date
      FROM picking_packages
      WHERE picking_order_id = ${order.id}
      ORDER BY created_date DESC, id DESC
    `;
    const boxIds = new Set();
    let restoredLots = 0, restoredReceiving = 0;
    for (const pkg of pkgs) {
      if (pkg.shipping_box_id) boxIds.add(pkg.shipping_box_id);
      if (pkg.source_type === "inventory_lot") {
        const lot = await tx`
          SELECT id, box_id AS "boxId" FROM inventory_lots WHERE id = ${pkg.source_id}
        `;
        if (lot.length === 0) throw new Error(`package ${pkg.id}: lot ${pkg.source_id} not found`);
        await tx`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty}, last_update_date = now() WHERE id = ${lot[0].id}`;
        if (lot[0].boxId) {
          await tx`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${lot[0].boxId}`;
          await tx`UPDATE shelf_boxes SET status = 'closed', last_update_date = now() WHERE id = ${lot[0].boxId} AND status = 'verified'`;
        }
        await bumpAllocation(tx, pkg.picking_item_id, pkg.qty, { inventoryLotId: lot[0].id });
        restoredLots += pkg.qty;
      } else if (pkg.source_type === "receiving_invoice_item") {
        const rii = await tx`
          UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty}, last_update_date = now()
          WHERE id = ${pkg.source_id} RETURNING id
        `;
        if (rii.length === 0) throw new Error(`package ${pkg.id}: receiving_invoice_item ${pkg.source_id} not found`);
        await bumpAllocation(tx, pkg.picking_item_id, pkg.qty, { receivingInvoiceItemId: pkg.source_id });
        restoredReceiving += pkg.qty;
      } else if (pkg.source_type === "receiving_order") {
        // FIFO unwind, newest picked lines first (mirror removeScannedPackage).
        const lines = await tx`
          SELECT rii.id, rii.picked_qty AS "pickedQty"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${pkg.source_id} AND rii.part_no = ${itemPart[pkg.picking_item_id]} AND rii.picked_qty > 0
          ORDER BY rii.date_code DESC NULLS FIRST, rii.id DESC
        `;
        let left = pkg.qty;
        for (const line of lines) {
          if (left <= 0) break;
          const give = Math.min(line.pickedQty, left);
          await tx`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${give}, last_update_date = now() WHERE id = ${line.id}`;
          left -= give;
        }
        if (left > 0) throw new Error(`package ${pkg.id}: receiving source ${pkg.source_id} cannot unwind ${left} pcs`);
        await bumpAllocation(tx, pkg.picking_item_id, pkg.qty, { receivingOrderId: pkg.source_id });
        restoredReceiving += pkg.qty;
      } else {
        throw new Error(`package ${pkg.id}: unknown source_type "${pkg.source_type}"`);
      }
      await tx`DELETE FROM picking_packages WHERE id = ${pkg.id}`;
    }

    // --- 2. Delete now-empty boxes of this order (cross-order packing safe) --
    const boxIdList = [...boxIds];
    const empty = boxIdList.length
      ? await tx`
          SELECT sb.id FROM shipping_boxes sb
          WHERE (sb.picking_order_id = ${order.id} OR sb.id IN ${sql(boxIdList)})
            AND NOT EXISTS (SELECT 1 FROM picking_packages pp WHERE pp.shipping_box_id = sb.id)
        `
      : await tx`
          SELECT sb.id FROM shipping_boxes sb
          WHERE sb.picking_order_id = ${order.id}
            AND NOT EXISTS (SELECT 1 FROM picking_packages pp WHERE pp.shipping_box_id = sb.id)
        `;
    let deletedBoxes = 0;
    for (const box of empty) {
      await tx`DELETE FROM verify_tasks WHERE shipping_box_id = ${box.id}`;
      await tx`DELETE FROM shipping_box_items WHERE shipping_box_id = ${box.id}`;
      await tx`DELETE FROM shipping_boxes WHERE id = ${box.id}`;
      deletedBoxes++;
    }

    // --- 3. Reset items + order ---------------------------------------------
    await tx`
      UPDATE picking_items pi
      SET picked_qty = COALESCE((SELECT SUM(pp.qty) FROM picking_packages pp
                                 WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NOT NULL), 0),
          allocated_qty = COALESCE((SELECT SUM(a.qty) FROM allocations a
                                    WHERE a.picking_item_id = pi.id), 0),
          status = 'pending', last_update_date = now()
      WHERE pi.picking_order_id = ${order.id}
    `;
    const sums = await tx`
      SELECT COALESCE(SUM(qty), 0)::int AS open,
             COALESCE((SELECT SUM(a.qty) FROM allocations a
                       WHERE a.picking_item_id IN (SELECT id FROM picking_items
                                                   WHERE picking_order_id = ${order.id})), 0)::int AS alloc
      FROM picking_items WHERE picking_order_id = ${order.id}
    `;
    const allocStatus =
      sums[0].alloc <= 0 ? "unallocated" : sums[0].alloc >= sums[0].open ? "allocated" : "partial";
    const upd = await tx`
      UPDATE picking_orders
      SET status = ${targetStatus}, allocation_status = ${allocStatus},
          working_by = NULL, working_at = NULL,
          issue_reason = NULL, issue_qty = NULL, issue_pack_size = NULL,
          issue_note = NULL, issue_remark = NULL, issue_reported_at = NULL, issue_reported_by = NULL,
          shipped_at = NULL, shipped_by = NULL, last_update_date = now()
      WHERE id = ${order.id}
    `;
    if (upd.count !== 1) throw new Error("order update failed");

    // Re-derive lot reserved counters from the surviving allocation rows.
    await tx`
      UPDATE inventory_lots il
      SET allocated_qty = COALESCE((SELECT SUM(a.qty) FROM allocations a
                                    WHERE a.inventory_lot_id = il.id), 0),
          last_update_date = now()
      WHERE il.id IN (SELECT DISTINCT inventory_lot_id FROM allocations
                      WHERE inventory_lot_id IS NOT NULL
                        AND picking_item_id IN (SELECT id FROM picking_items
                                                WHERE picking_order_id = ${order.id}))
    `;

    // --- 4. Audit cleanup ----------------------------------------------------
    let delLogs = { count: 0 }, delItxn = { count: 0 };
    if (!keepAudit) {
      delLogs = await tx`
        DELETE FROM transaction_logs
        WHERE (entity_type = 'picking_order' AND entity_id = ${order.id})
           OR (entity_type = 'picking_item' AND entity_id IN ${sql(itemIds)})
      `;
      delItxn = await tx`
        DELETE FROM inventory_transactions
        WHERE reference_type = 'picking_item' AND reference_id IN ${sql(itemIds)}
      `;
    }

    console.log("Done:");
    console.log(`  packages un-scanned/deleted:    ${pkgs.length} (lots +${restoredLots}, receiving −${restoredReceiving} picked)`);
    console.log(`  empty shipping boxes deleted:   ${deletedBoxes}`);
    console.log(`  order → ${targetStatus} (${allocStatus})`);
    if (!keepAudit)
      console.log(`  audit rows deleted:             ${delLogs.count} logs + ${delItxn.count} inventory_transactions`);
  });

  console.log(`\nOrder ${order.id} is ready to re-test — status "${targetStatus}" with restored allocations.`);
}

/** Find-or-create the allocation for (picking item, source) and add qty back. */
async function bumpAllocation(tx, pickingItemId, qty, source) {
  let existing;
  if (source.inventoryLotId) {
    existing = await tx`SELECT id FROM allocations
      WHERE picking_item_id = ${pickingItemId} AND inventory_lot_id = ${source.inventoryLotId}`;
  } else if (source.receivingInvoiceItemId) {
    existing = await tx`SELECT id FROM allocations
      WHERE picking_item_id = ${pickingItemId} AND receiving_invoice_item_id = ${source.receivingInvoiceItemId}`;
  } else {
    existing = await tx`SELECT id FROM allocations
      WHERE picking_item_id = ${pickingItemId} AND receiving_order_id = ${source.receivingOrderId}`;
  }
  if (existing.length > 0) {
    await tx`UPDATE allocations SET qty = qty + ${qty}, last_update_date = now() WHERE id = ${existing[0].id}`;
  } else {
    const id = crypto.randomUUID();
    await tx`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_invoice_item_id, receiving_order_id, created_date, last_update_date)
      VALUES (${id}, ${pickingItemId}, ${qty}, ${source.inventoryLotId ?? null}, ${source.receivingInvoiceItemId ?? null}, ${source.receivingOrderId ?? null}, now(), now())`;
  }
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
