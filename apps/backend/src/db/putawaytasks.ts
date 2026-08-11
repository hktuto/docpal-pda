import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { getPutAwayAggregate, type PutAwayAggregate, type PutAwayExpectedItemRow } from "./putaway.js";
import { putAwayConfig } from "../config.js";

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
  const order = await queryGet<{ id: string; orgId: number; subInventoryCode: string }>(
    tx,
    sql`SELECT id, org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM receiving_orders WHERE id = ${input.receivingOrderId}`
  );
  if (!order) return;
  const id = newId();
  const inserted = await queryAll<{ id: string }>(
    tx,
    sql`INSERT INTO put_away_tasks (id, receiving_order_id, org_id, sub_inventory_code, status)
        VALUES (${id}, ${order.id}, ${order.orgId}, ${order.subInventoryCode}, 'pending')
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
  orgId: number;
  subInventoryCode: string;
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

export interface PutAwayTaskDetail extends Omit<PutAwayAggregate, "items"> {
  task: { id: string; status: string; receivingOrderId: string; createdDate: Date };
  items: (PutAwayExpectedItemRow & { suggestedShelfCode: string | null })[];
}

/**
 * Task detail = the per-order put-away aggregate plus a per-item shelf
 * suggestion ("existing-stock": the shelf of the most recent lot of the same
 * part in the task's org + sub-inventory; null when the part has no stock
 * history). Advisory, computed at read time, never stored.
 */
export async function getPutAwayTaskDetail(db: AppDb, taskId: string): Promise<PutAwayTaskDetail> {
  const task = await queryGet<PutAwayTaskDetail["task"] & { orgId: number; subInventoryCode: string }>(
    db,
    sql`SELECT id, status, receiving_order_id AS "receivingOrderId",
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode",
               created_date AS "createdDate"
        FROM put_away_tasks WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "put_away_task_not_found" });

  const aggregate = await getPutAwayAggregate(db, task.receivingOrderId);

  const suggestions = new Map<string, string | null>();
  if (putAwayConfig().suggestShelf !== "off") {
    const partNos = [...new Set(aggregate.items.map((it) => it.partNo))];
    if (partNos.length > 0) {
      const rows = await queryAll<{ partNo: string; shelfCode: string }>(
        db,
        sql`SELECT DISTINCT ON (part_no) part_no AS "partNo", shelf_code AS "shelfCode"
            FROM inventory_lots
            WHERE part_no IN (${sql.join(partNos.map((p) => sql`${p}`), sql`, `)})
              AND org_id = ${task.orgId}
              AND sub_inventory_code = ${task.subInventoryCode}
              AND shelf_code IS NOT NULL
            ORDER BY part_no, created_date DESC, id`
      );
      for (const r of rows) suggestions.set(r.partNo, r.shelfCode);
    }
  }

  return {
    ...aggregate,
    task: { id: task.id, status: task.status, receivingOrderId: task.receivingOrderId, createdDate: task.createdDate },
    items: aggregate.items.map((it) => ({ ...it, suggestedShelfCode: suggestions.get(it.partNo) ?? null })),
  };
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
