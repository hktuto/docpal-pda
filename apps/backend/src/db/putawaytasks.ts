import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { getPutAwayAggregate, orderPair, type PutAwayAggregate } from "./putaway.js";

// ---------------------------------------------------------------------------
// Put-away tasks (spec 2026-08-10-put-away-tasks-design.md). One task per
// receiving order; auto-created in confirmReceivingArrival's tx when
// FLOW_CONFIG steps.put-away.autoCreateTasks is on, completed by the
// auto-clear in putaway.ts. The derived /put-away/candidates list stays the
// source for manual mode — tasks are an overlay, not a replacement.
// ---------------------------------------------------------------------------

/**
 * Create the pending task for an order that just went in_hand (same tx as the
 * arrival confirm so it can't be lost). Idempotent via the
 * receiving_order_id unique index — a re-confirm after provisional receipt is
 * a no-op.
 */
export async function createPutAwayTaskTx(
  tx: DbOrTx,
  input: { receivingOrderId: string; actorId: string }
): Promise<void> {
  const order = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM receiving_orders WHERE id = ${input.receivingOrderId}`
  );
  if (!order) return;
  // The task's denormalized pair is the order's item-derived uniform pair
  // (NULL when the items are mixed — see orderPair in putaway.ts).
  const pair = await orderPair(tx, input.receivingOrderId);
  const id = newId();
  const inserted = await queryAll<{ id: string }>(
    tx,
    sql`INSERT INTO put_away_tasks (id, receiving_order_id, org_id, sub_inventory_code, status)
        VALUES (${id}, ${order.id}, ${pair.orgId}, ${pair.subInventoryCode}, 'pending')
        ON CONFLICT (receiving_order_id) DO NOTHING
        RETURNING id`
  );
  if (inserted.length === 0) return;
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "put_away_task",
    entityId: id,
    fromState: null,
    toState: "pending",
    actorId: input.actorId,
    createdDate: now(),
  });
  await emitEvent(tx, {
    type: "put_away_task.created",
    topics: ["/put-away-tasks"],
    data: { taskId: id, receivingOrderId: order.id },
  });
}

export interface PutAwayTaskListRow {
  id: string;
  status: string;
  receivingOrderId: string;
  batchNo: string;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  receivedItems: number;
  unboxedItems: number;
  createdDate: Date;
}

/** Task queue, oldest truck first. Item counts use the candidates formula. */
export async function listPutAwayTasks(db: AppDb, status?: string): Promise<PutAwayTaskListRow[]> {
  return queryAll<PutAwayTaskListRow>(
    db,
    sql`
      SELECT
        t.id, t.status,
        ro.id AS "receivingOrderId",
        ro.batch_no AS "batchNo",
        s.code AS "supplierCode",
        s.name AS "supplierName",
        t.org_id AS "orgId",
        t.sub_inventory_code AS "subInventoryCode",
        COUNT(rii.id) FILTER (WHERE rii.received_qty > 0)::int AS "receivedItems",
        COUNT(rii.id) FILTER (WHERE
          rii.received_qty - rii.picked_qty - rii.put_away_qty
            - COALESCE(alloc.qty, 0) - COALESCE(staged.qty, 0) > 0)::int AS "unboxedItems",
        t.created_date AS "createdDate"
      FROM put_away_tasks t
      JOIN receiving_orders ro ON ro.id = t.receiving_order_id
      LEFT JOIN suppliers s ON s.code = ro.supplier_code
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty)::int AS qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      LEFT JOIN (
        SELECT sbi.receiving_invoice_item_id, SUM(sbi.qty)::int AS qty
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sb.shelf_code IS NULL
        GROUP BY sbi.receiving_invoice_item_id
      ) staged ON staged.receiving_invoice_item_id = rii.id
      ${status ? sql`WHERE t.status = ${status}` : sql``}
      GROUP BY t.id, ro.id, s.id
      ORDER BY t.created_date ASC, t.id
    `
  );
}

export interface PutAwayTaskDetail extends PutAwayAggregate {
  task: { id: string; status: string; receivingOrderId: string; createdDate: Date };
}

/**
 * Task detail = the per-order put-away aggregate (which already includes the
 * per-item shelf/box suggestions, ranked within each item's org +
 * sub-inventory) plus the task row.
 */
export async function getPutAwayTaskDetail(db: AppDb, taskId: string): Promise<PutAwayTaskDetail> {
  const task = await queryGet<PutAwayTaskDetail["task"]>(
    db,
    sql`SELECT id, status, receiving_order_id AS "receivingOrderId",
               created_date AS "createdDate"
        FROM put_away_tasks WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "put_away_task_not_found" });

  const aggregate = await getPutAwayAggregate(db, task.receivingOrderId);
  return { ...aggregate, task };
}

/**
 * Complete the order's task when the order auto-clears (nothing left to put
 * away or pick). Called from tryMarkReceivingOrderClear in the same tx.
 */
export async function completePutAwayTaskTx(
  tx: DbOrTx,
  input: { receivingOrderId: string; actorId: string | null }
): Promise<void> {
  const rows = await queryAll<{ id: string }>(
    tx,
    sql`UPDATE put_away_tasks SET status = 'completed', last_update_date = ${now()}
        WHERE receiving_order_id = ${input.receivingOrderId} AND status = 'pending'
        RETURNING id`
  );
  if (rows.length === 0) return;
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "put_away_task",
    entityId: rows[0].id,
    fromState: "pending",
    toState: "completed",
    actorId: input.actorId,
    createdDate: now(),
  });
  await emitEvent(tx, {
    type: "put_away_task.completed",
    topics: ["/put-away-tasks"],
    data: { taskId: rows[0].id, receivingOrderId: input.receivingOrderId },
  });
}
