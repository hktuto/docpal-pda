import { inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "./query.js";
import { queryAll, queryGet } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Internal transfer put-away task lifecycle (spec
// 2026-11-17-internal-transfer-allocation-supply-design.md): allocation
// actions drive the task. Σ picking promises on the transfer's items
// (allocations.internal_transfer_item_id) vs Σ item qty:
//   - fully promised  → the task must not exist: delete a pending task with
//     nothing shelved yet, or complete one that already has shelved packages
//     (never delete shelved work).
//   - remainder exists → the task must exist once the order is finished
//     (finish creates it; this helper restores it when a post-finish
//     allocation removal re-opens a remainder).
// Before finish there is nothing to create — finish only creates a task for
// the unpromised remainder.
// ---------------------------------------------------------------------------

/** Sync one transfer's task. Pass either the order id or any of its item ids. */
export async function syncTransferPutAwayTask(
  tx: DbOrTx,
  ref: { transferOrderId?: string; transferItemId?: string }
): Promise<void> {
  let orderId = ref.transferOrderId ?? null;
  if (!orderId && ref.transferItemId) {
    const row = await queryGet<{ transferOrderId: string }>(
      tx,
      sql`SELECT transfer_order_id AS "transferOrderId" FROM internal_transfer_items WHERE id = ${ref.transferItemId}`
    );
    orderId = row?.transferOrderId ?? null;
  }
  if (!orderId) return;

  const order = await queryGet<{
    id: string;
    status: string;
    toOrgId: number | null;
    toSubInventoryCode: string | null;
  }>(
    tx,
    sql`SELECT id, status, to_org_id AS "toOrgId", to_sub_inventory_code AS "toSubInventoryCode"
        FROM internal_transfer_orders WHERE id = ${orderId}`
  );
  if (!order) return;

  const totals = (await queryGet<{ total: number; promised: number }>(
    tx,
    sql`SELECT (SELECT COALESCE(SUM(qty), 0)::int FROM internal_transfer_items WHERE transfer_order_id = ${orderId}) AS total,
               (SELECT COALESCE(SUM(a.qty), 0)::int
                FROM allocations a
                JOIN internal_transfer_items iti ON iti.id = a.internal_transfer_item_id
                WHERE iti.transfer_order_id = ${orderId}) AS promised`
  )) ?? { total: 0, promised: 0 };
  const task = (await queryGet<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM put_away_tasks WHERE internal_transfer_order_id = ${orderId}`
  )) ?? null;

  const at = now();
  if (totals.total > 0 && totals.promised >= totals.total) {
    if (!task) return;
    const shelved = (await queryGet<{ qty: number }>(
      tx,
      sql`SELECT COALESCE(SUM(qty), 0)::int AS qty FROM internal_transfer_packages
          WHERE transfer_order_id = ${orderId} AND shelf_code IS NOT NULL`
    )) ?? { qty: 0 };
    if (shelved.qty === 0) {
      await tx.execute(sql`DELETE FROM put_away_tasks WHERE id = ${task.id}`);
    } else if (task.status !== "completed") {
      await tx.execute(
        sql`UPDATE put_away_tasks SET status = 'completed', last_update_date = ${at} WHERE id = ${task.id}`
      );
    }
    return;
  }

  // Remainder exists: only a finished order can be missing its task (finish
  // skips creation when fully promised; a later promise removal reopens it).
  if (!task && order.status === "finished") {
    await tx.execute(
      sql`INSERT INTO put_away_tasks (id, internal_transfer_order_id, org_id, sub_inventory_code, status, created_date, last_update_date)
          VALUES (${newId()}, ${orderId}, ${order.toOrgId}, ${order.toSubInventoryCode}, 'pending', ${at}, ${at})`
    );
  }
}

/** Sync every transfer order touched by the given picking items' allocations. */
export async function syncTransferPutAwayTasksForPickingItems(
  tx: DbOrTx,
  pickingItemIds: string[]
): Promise<void> {
  if (pickingItemIds.length === 0) return;
  const rows = await queryAll<{ transferOrderId: string }>(
    tx,
    sql`SELECT DISTINCT ito.id AS "transferOrderId"
        FROM allocations a
        JOIN internal_transfer_items iti ON iti.id = a.internal_transfer_item_id
        JOIN internal_transfer_orders ito ON ito.id = iti.transfer_order_id
        WHERE ${inArray(sql`a.picking_item_id`, pickingItemIds)}`
  );
  for (const row of rows) {
    await syncTransferPutAwayTask(tx, { transferOrderId: row.transferOrderId });
  }
}
