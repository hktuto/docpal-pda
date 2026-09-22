// One-off repair: un-allocate inventory lots whose shelf_code is missing from
// shelves (upstream sync wrote them with FK bypass; ordinary UPDATEs on those
// rows fail the FK). Mirrors the engine wipe: RESERVE-release ledger rows,
// allocations delete, lot counter reset. Allocations of work-locked picking
// orders are skipped (a PDA may be scanning against them).
// Usage: node fix-dangling-lots.mjs  (run from apps/backend, postgres pkg resolves)
import postgres from "postgres";

const sql = postgres("postgresql://warehouse:warehouse@192.168.3.99:5432/warehouse_backend", { max: 1 });

const DANGLING = `l.shelf_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shelves s WHERE s.code = l.shelf_code)`;

const before = await sql.unsafe(`
  SELECT
    (SELECT count(*)::int FROM inventory_lots l WHERE ${DANGLING}) AS dangling_lots,
    (SELECT count(*)::int FROM inventory_lots l WHERE ${DANGLING} AND l.allocated_qty <> 0) AS lots_to_zero,
    (SELECT count(*)::int FROM allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id WHERE ${DANGLING}) AS allocs_total,
    (SELECT count(*)::int FROM allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id
       JOIN picking_items pi ON pi.id = a.picking_item_id
       JOIN picking_orders po ON po.id = pi.picking_order_id
       WHERE ${DANGLING} AND po.working_by IS NOT NULL AND po.working_at >= now() - interval '10 minutes') AS allocs_locked
`);
console.log("BEFORE", before[0]);

await sql.unsafe(`SET session_replication_role = replica`);
try {
  await sql.unsafe("BEGIN");

  const ledger = await sql.unsafe(`
    INSERT INTO inventory_transactions
      (id, inventory_lot_id, part_no, shelf_code, box_id, txn_type, qty_type, qty_delta,
       date_code, lot_code, coo, cow, reference_type, reference_id, receiving_invoice_item_id,
       txn_reason, txn_at)
    SELECT app_uuid_v7(), a.inventory_lot_id,
           COALESCE(l.part_no, rii.part_no, pi.part_no),
           l.shelf_code,
           COALESCE(l.box_id, rii.ctn_no),
           'RESERVE', 'reserved', -a.qty,
           COALESCE(l.date_code, rii.date_code),
           COALESCE(l.lot_code, rii.lot_code),
           COALESCE(l.coo, rii.coo),
           COALESCE(l.cow, rii.cow),
           'allocation', a.id, a.receiving_invoice_item_id,
           'repair: release dangling-shelf lot', now()
    FROM allocations a
    JOIN inventory_lots l ON l.id = a.inventory_lot_id
    JOIN picking_items pi ON pi.id = a.picking_item_id
    JOIN picking_orders po ON po.id = pi.picking_order_id
    LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
    WHERE ${DANGLING}
      AND (po.working_by IS NULL OR po.working_at < now() - interval '10 minutes')
  `);

  const del = await sql.unsafe(`
    DELETE FROM allocations a
    USING inventory_lots l, picking_items pi, picking_orders po
    WHERE a.inventory_lot_id = l.id
      AND pi.id = a.picking_item_id
      AND po.id = pi.picking_order_id
      AND ${DANGLING}
      AND (po.working_by IS NULL OR po.working_at < now() - interval '10 minutes')
  `);

  const zero = await sql.unsafe(`
    UPDATE inventory_lots l SET allocated_qty = 0
    WHERE l.allocated_qty <> 0 AND ${DANGLING}
      AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.inventory_lot_id = l.id)
  `);

  await sql.unsafe("COMMIT");
  console.log("ledger rows:", ledger.count, "allocations deleted:", del.count, "lots zeroed:", zero.count);
} catch (e) {
  await sql.unsafe("ROLLBACK");
  throw e;
} finally {
  await sql.unsafe(`RESET session_replication_role`);
}

const after = await sql.unsafe(`
  SELECT
    (SELECT count(*)::int FROM inventory_lots l WHERE ${DANGLING} AND l.allocated_qty <> 0) AS dangling_with_alloc_qty,
    (SELECT count(*)::int FROM allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id WHERE ${DANGLING}) AS allocs_remaining
`);
console.log("AFTER", after[0]);

await sql.end();
