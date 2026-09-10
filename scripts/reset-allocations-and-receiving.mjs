#!/usr/bin/env node
// Test-reset: wipe all picking allocations and revert non-clear receiving
// orders back to pending (un-confirm-arrival / un-provisional-receipt).
//
// Usage:
//   node scripts/reset-allocations-and-receiving.mjs postgres://user:pass@host:5432/warehouse_backend
//   node scripts/reset-allocations-and-receiving.mjs $DATABASE_URL --dry-run
//   node scripts/reset-allocations-and-receiving.mjs $DATABASE_URL --keep-audit
//
// What it does, in one transaction:
//   1. Un-allocate: deletes all `allocations` rows and resets the cached
//      counters (`picking_items.allocated_qty`, `inventory_lots.allocated_qty`,
//      `picking_orders.allocation_status`), and clears PDA work locks so the
//      allocation engine is not blocked.
//   2. Un-hand: every receiving order with status `in_hand` or
//      `provisional_received` is reverted to `pending`; its items'
//      `received_qty` is zeroed, auto-created put-away tasks, scan-label dedup
//      rows, and (unless --keep-audit) the confirm-arrival audit rows are
//      removed. Orders already `clear` (stock put away) are never touched.
//
// After it runs, hit `POST :3002/dev/allocate` to rebuild allocations from a
// clean slate. Picking progress that was scanned into shipping boxes
// (`picking_packages`) is NOT reverted — this reset only works for orders
// that have not been picked yet.
//
// The `postgres` driver is resolved from apps/backend (same version the
// backend runs), so run this from anywhere in the repo.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(
  new URL("../apps/backend/package.json", import.meta.url)
);
const postgres = require("postgres");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keepAudit = args.includes("--keep-audit");
const connectionString = args.find((a) => !a.startsWith("--"));

if (!connectionString) {
  console.error(
    "Usage: node scripts/reset-allocations-and-receiving.mjs <DATABASE_URL> [--dry-run] [--keep-audit]"
  );
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

// Receiving orders that will be reverted to pending.
const ORDERS = sql`
  SELECT id, batch_no, status FROM receiving_orders
  WHERE status IN ('in_hand', 'provisional_received')
  ORDER BY batch_no
`;

async function preview() {
  const orders = await ORDERS;
  console.log(`Receiving orders to revert to pending: ${orders.length}`);
  for (const o of orders)
    console.log(`  ${o.batch_no}  (${o.status})`);
  const alloc = await sql`SELECT count(*)::int AS n FROM allocations`;
  const pkg = await sql`SELECT count(*)::int AS n FROM picking_packages`;
  const locked = await sql`
    SELECT count(*)::int AS n FROM picking_orders
    WHERE working_by IS NOT NULL AND working_at > now() - interval '10 minutes'
  `;
  console.log(`allocations rows to delete: ${alloc[0].n}`);
  console.log(`picking_packages rows (left untouched): ${pkg[0].n}`);
  console.log(`picking orders with a live PDA work lock (will be cleared): ${locked[0].n}`);
}

async function reset() {
  await sql.begin(async (tx) => {
    // --- 1. Un-allocate -----------------------------------------------------
    const delAlloc = await tx`DELETE FROM allocations`;
    const updItems = await tx`
      UPDATE picking_items SET allocated_qty = 0, last_update_date = now()
    `;
    const updLots = await tx`
      UPDATE inventory_lots SET allocated_qty = 0, last_update_date = now()
    `;
    const updOrders = await tx`
      UPDATE picking_orders
      SET allocation_status = 'unallocated', last_update_date = now()
      WHERE status IN ('pending', 'picking')
    `;
    const clearedLocks = await tx`
      UPDATE picking_orders
      SET working_by = NULL, working_at = NULL, last_update_date = now()
      WHERE working_by IS NOT NULL
    `;

    // --- 2. Un-hand non-clear receiving orders ------------------------------
    const orderIds = (await tx`${ORDERS}`).map((o) => o.id);
    let reverted = { count: 0 };
    if (orderIds.length > 0) {
      reverted = await tx`
        UPDATE receiving_orders
        SET status = 'pending', arrived_at = NULL, arrived_by = NULL, last_update_date = now()
        WHERE id IN ${sql(orderIds)}
      `;
      await tx`
        UPDATE receiving_invoice_items rii
        SET received_qty = 0, last_update_date = now()
        FROM receiving_invoices ri
        WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id IN ${sql(orderIds)}
      `;
      await tx`DELETE FROM put_away_tasks WHERE receiving_order_id IN ${sql(orderIds)}`;
      await tx`DELETE FROM receiving_scan_labels WHERE receiving_order_id IN ${sql(orderIds)}`;
      if (!keepAudit) {
        await tx`DELETE FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id IN ${sql(orderIds)}`;
        await tx`DELETE FROM inventory_transactions WHERE reference_type = 'receiving_order' AND reference_id IN ${sql(orderIds)}`;
      }
    }

    console.log("Done:");
    console.log(`  allocations deleted:            ${delAlloc.count}`);
    console.log(`  picking_items reset:            ${updItems.count}`);
    console.log(`  inventory_lots reset:           ${updLots.count}`);
    console.log(`  picking_orders → unallocated:   ${updOrders.count}`);
    console.log(`  PDA work locks cleared:         ${clearedLocks.count}`);
    console.log(`  receiving orders → pending:     ${reverted.count}`);
  });

  console.log(
    "\nNext: POST :3002/dev/allocate to rebuild allocations from a clean slate."
  );
}

try {
  if (dryRun) {
    await preview();
  } else {
    await reset();
  }
} catch (err) {
  console.error("Reset failed (transaction rolled back):", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
