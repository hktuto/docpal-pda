import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { logTransition } from "./picking.js";
import { creditLotTx } from "./adhocPutaway.js";
import { assigneeFilter } from "./user-scope.js";
import { inventoryTransactions } from "./schema/index.js";

// ---------------------------------------------------------------------------
// Put-back queue (spec docs/superpowers/specs/2026-11-07-cancel-invoice-
// putback-design.md): stock already picked for a cancelled order/item has to
// go physically back onto a shelf. The rows are created by the cancel-invoice
// cron (db/cancelInvoice.ts); this module serves the PDA queue and the
// completion that credits shelf stock back.
// ---------------------------------------------------------------------------

export async function listPutBackTasks(
  db: AppDb,
  status: string | undefined,
  username: string | undefined
): Promise<unknown[]> {
  return queryAll(
    db,
    sql`SELECT t.id, t.status, t.assignee, t.picking_order_id AS "pickingOrderId", po.order_no AS "orderNo",
               COALESCE(SUM(i.qty), 0)::int AS "totalQty", COUNT(i.id)::int AS "itemCount",
               t.created_date AS "createdDate"
        FROM put_back_tasks t
        JOIN picking_orders po ON po.id = t.picking_order_id
        LEFT JOIN put_back_task_items i ON i.put_back_task_id = t.id
        WHERE (${status ?? null}::text IS NULL OR t.status = ${status ?? null})
          ${assigneeFilter(sql`t.assignee`, username)}
        GROUP BY t.id, po.order_no
        ORDER BY t.created_date`
  );
}

export async function getPutBackTaskDetail(db: AppDb, taskId: string, username: string | undefined): Promise<unknown> {
  const task = await queryGet<Record<string, unknown>>(
    db,
    sql`SELECT t.id, t.status, t.assignee, t.picking_order_id AS "pickingOrderId", po.order_no AS "orderNo",
               t.cancel_source AS "cancelSource", t.cancel_source_id AS "cancelSourceId",
               t.picking_item_id AS "pickingItemId", t.created_date AS "createdDate", t.last_update_date AS "lastUpdateDate"
        FROM put_back_tasks t
        JOIN picking_orders po ON po.id = t.picking_order_id
        WHERE t.id = ${taskId} ${assigneeFilter(sql`t.assignee`, username)}`
  );
  if (!task) throw new HTTPException(404, { message: "put_back_task_not_found" });
  task.items = await queryAll(
    db,
    sql`SELECT id, picking_package_id AS "pickingPackageId", part_no AS "partNo", wcl_item_no AS "wclItemNo",
                qty, date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
                shelf_code AS "shelfCode", org_id AS "orgId", sub_inventory_code AS "subInventoryCode",
                status, done_shelf_code AS "doneShelfCode", done_at AS "doneAt"
         FROM put_back_task_items WHERE put_back_task_id = ${taskId} ORDER BY part_no, created_date`
  );
  return task;
}

/**
 * Complete a put-back task: credit every pending item back onto a shelf lot
 * (the item's source shelf, or the scanned fallback for dock-sourced stock —
 * shelf-direct, same key as ad-hoc put-away), write ADJUST on_hand +qty
 * ledger rows, and close the task. The status flip doubles as the claim
 * (like completePutAwayTaskTx): second call → 409.
 * No allocation recompute (manual-only policy): freed stock joins the pool
 * at the admin's next Re-allocate.
 */
export async function completePutBackTask(
  db: AppDb,
  input: { taskId: string; actorId: string; username?: string; shelfCode?: string | null }
): Promise<{ id: string; itemsCredited: number; totalQty: number }> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM put_back_tasks WHERE id = ${input.taskId} ${assigneeFilter(sql`assignee`, input.username)}`
    );
    if (!task) throw new HTTPException(404, { message: "put_back_task_not_found" });
    if (task.status !== "pending") throw new HTTPException(409, { message: "put_back_task_not_pending" });
    const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${input.actorId}`);
    if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

    const fallbackShelf = input.shelfCode?.trim() || null;
    const items = await queryAll<PutBackItemRow>(
      tx,
      sql`SELECT id, part_no AS "partNo", wcl_item_no AS "wclItemNo", qty,
                 date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
                 shelf_code AS "shelfCode", org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM put_back_task_items WHERE put_back_task_id = ${task.id} AND status = 'pending'`
    );

    // Claim the task — the RETURNING is the race guard (two concurrent
    // completers: the loser's UPDATE matches no pending row → 409).
    const claimed = await queryGet<{ id: string }>(
      tx,
      sql`UPDATE put_back_tasks SET status = 'completed', last_update_date = ${now()} WHERE id = ${task.id} AND status = 'pending' RETURNING id`
    );
    if (!claimed) throw new HTTPException(409, { message: "put_back_task_not_pending" });

    // Credit loop validates per item (same tx — a throw rolls the claim +
    // earlier credits back, so it is atomic either way).
    const at = now();
    let totalQty = 0;
    for (const item of items) {
      const shelf = item.shelfCode ?? fallbackShelf;
      if (!shelf) throw new HTTPException(409, { message: "put_back_shelf_required" });
      if (item.orgId === null || !item.subInventoryCode) throw new HTTPException(409, { message: "put_back_org_missing" });
      const { lotId, boxId } = await creditLotTx(
        tx,
        {
          partNo: item.partNo,
          wclItemNo: item.wclItemNo,
          shelfCode: shelf,
          dateCode: item.dateCode,
          lotCode: item.lotCode,
          coo: item.coo,
          cow: item.cow,
          orgId: item.orgId,
          subInventoryCode: item.subInventoryCode,
          qty: item.qty,
        }
      );
      await tx.insert(inventoryTransactions).values({
        id: newId(),
        inventoryLotId: lotId,
        partNo: item.partNo,
        shelfCode: shelf,
        txnType: "ADJUST",
        qtyType: "on_hand",
        qtyDelta: item.qty,
        dateCode: item.dateCode,
        lotCode: item.lotCode,
        coo: item.coo,
        cow: item.cow,
        referenceType: "put_back_task",
        referenceId: task.id,
        actorId: input.actorId,
        txnReason: "cancel put-back",
        txnAt: at,
      });
      // Crediting a boxed lot invalidates its shelf-box verification (same
      // rule as the put-away commit).
      if (boxId) {
        await queryRun(tx, sql`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${boxId}`);
        await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${boxId} AND status = 'verified'`);
      }
      await queryRun(
        tx,
        sql`UPDATE put_back_task_items SET status = 'put_back', done_shelf_code = ${shelf}, done_at = ${at},
                  last_update_date = ${at} WHERE id = ${item.id}`
      );
      totalQty += item.qty;
    }

    await logTransition(tx, {
      entityType: "put_back_task",
      entityId: task.id,
      fromState: "pending",
      toState: "completed",
      actorId: input.actorId,
      metadata: { items: items.length, totalQty },
    });
    await emitEvent(tx, {
      type: "put_back_task.completed",
      topics: ["/put-back-tasks"],
      data: { taskId: task.id },
    });
    return { id: task.id, itemsCredited: items.length, totalQty };
  });
}

interface PutBackItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
}
