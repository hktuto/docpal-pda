import { sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { transactionLogs } from "./schema/index.js";

// ---------------------------------------------------------------------------
// Admin task-assignment API (spec 2026-11-01-task-assignee-design.md): one
// table-driven surface over the assignable PDA task queues. assignee is a
// username with NO FK (matches user_profiles — an assignment may pre-exist the
// users row); NULL = unassigned = visible to everyone. Admin lists include
// rows regardless of assignee (this is where assignments are managed).
// ---------------------------------------------------------------------------

export const TASK_ASSIGNMENT_FLOWS = [
  "receiving-cn",
  "picking",
  "label-printing",
  "labeling",
  "put-away",
  "put-away-cn",
  "measuring",
  "verify",
] as const;
export type TaskAssignmentFlow = (typeof TASK_ASSIGNMENT_FLOWS)[number];

export function parseTaskAssignmentFlow(input: unknown): TaskAssignmentFlow {
  if (typeof input !== "string" || !(TASK_ASSIGNMENT_FLOWS as readonly string[]).includes(input)) {
    throw new HTTPException(400, { message: `unknown_flow: must be one of ${TASK_ASSIGNMENT_FLOWS.join(", ")}` });
  }
  return input as TaskAssignmentFlow;
}

export interface TaskAssignmentRow {
  id: string;
  /** Human label for the picker UI (batch no / order no / box id). */
  label: string;
  status: string;
  assignee: string | null;
  /** Flow-specific context for the picker UI. */
  batchNo?: string | null;
  orderNo?: string | null;
  boxId?: string | null;
  orderNos?: string[];
}

/** Open tasks of one flow for the assignment picker, sorted by label.
 *  keyMatch (lifecycle search, CR-048) restricts rows to tasks whose context
 *  columns equal the searched order/batch/box number. */
export async function listTaskAssignments(
  db: AppDb,
  flow: TaskAssignmentFlow,
  keyMatch?: SQL
): Promise<TaskAssignmentRow[]> {
  const keyCond = keyMatch ? sql`AND ${keyMatch}` : sql``;
  switch (flow) {
    case "receiving-cn":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT id, batch_no AS "label", batch_no AS "batchNo", status, assignee
            FROM receiving_orders_cn WHERE status != 'clear' ${keyCond}
            ORDER BY batch_no, id`
      );
    case "picking":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT id, order_no AS "label", order_no AS "orderNo", status, assignee
            FROM picking_orders
            WHERE status NOT IN ('picking_finished', 'measuring_finished', 'shipped', 'skip') ${keyCond}
            ORDER BY order_no, id`
      );
    case "label-printing":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT id, order_no AS "label", order_no AS "orderNo", status, assignee
            FROM picking_orders WHERE label_printing_pending = true ${keyCond}
            ORDER BY order_no, id`
      );
    case "labeling":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT id, order_no AS "label", order_no AS "orderNo", status, assignee
            FROM picking_orders WHERE labeling_pending = true ${keyCond}
            ORDER BY order_no, id`
      );
    case "put-away":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT t.id, COALESCE(ro.batch_no, ito.order_no) AS "label",
                   ro.batch_no AS "batchNo", ito.order_no AS "orderNo", t.status, t.assignee
            FROM put_away_tasks t
            LEFT JOIN receiving_orders ro ON ro.id = t.receiving_order_id
            LEFT JOIN internal_transfer_orders ito ON ito.id = t.internal_transfer_order_id
            WHERE t.status = 'pending' ${keyCond}
            ORDER BY "label", t.id`
      );
    case "put-away-cn":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT t.id, ro.batch_no AS "label", ro.batch_no AS "batchNo", t.status, t.assignee
            FROM put_away_tasks_cn t
            LEFT JOIN receiving_orders_cn ro ON ro.id = t.receiving_order_cn_id
            WHERE t.status = 'pending' ${keyCond}
            ORDER BY ro.batch_no, t.id`
      );
    case "measuring":
      // The exact set the PDA measuring queue shows (see db/measuring.ts):
      // open boxes with packages whose orders are all picking-complete.
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT sb.id, sb.id AS "label", sb.id AS "boxId", sb.status, sb.assignee,
                   COALESCE(array_agg(DISTINCT po.order_no) FILTER (WHERE po.order_no IS NOT NULL), '{}') AS "orderNos"
            FROM shipping_boxes sb
            JOIN picking_packages pp ON pp.shipping_box_id = sb.id
            JOIN picking_items pi ON pi.id = pp.picking_item_id
            JOIN picking_orders po ON po.id = pi.picking_order_id
            WHERE sb.status = 'open'
              AND NOT EXISTS (
                SELECT 1
                FROM picking_packages pp2
                JOIN picking_items pi2 ON pi2.id = pp2.picking_item_id
                JOIN picking_orders po2 ON po2.id = pi2.picking_order_id
                WHERE pp2.shipping_box_id = sb.id
                  AND (po2.status NOT IN ('picking_finished', 'measuring_finished', 'shipped')
                       OR po2.labeling_pending = true
                       OR po2.label_printing_pending = true)
              )
              ${keyCond}
            GROUP BY sb.id
            ORDER BY sb.id`
      );
    case "verify":
      return queryAll<TaskAssignmentRow>(
        db,
        sql`SELECT vt.id, vt.shipping_box_id AS "label", vt.shipping_box_id AS "boxId",
                   vt.status, vt.assignee
            FROM verify_tasks vt
            JOIN shipping_boxes sb ON sb.id = vt.shipping_box_id
            WHERE vt.status = 'pending' ${keyCond}
            ORDER BY vt.shipping_box_id, vt.id`
      );
  }
}

// ---------------------------------------------------------------------------
// Per-step assignee view (CR-048, plan 2026-11-06-uat-open-items.md): search
// one order/batch/box number, get the open task + assignee of every flow
// step that references it. A step with no matching open task simply doesn't
// appear — done/closed tasks need no assignee (listTaskAssignments keeps the
// rows to the same open sets the PDA queues show).
// ---------------------------------------------------------------------------

export interface TaskLifecycleStep {
  flow: TaskAssignmentFlow;
  id: string;
  label: string;
  status: string;
  assignee: string | null;
}

/** Lifecycle display order: CN inbound → picking/labeling → measure/verify,
 *  put-away branches last. NOTE: picking / labeling / label-printing are the
 *  same picking_orders row (shared assignee column), so editing any of those
 *  steps updates the others. */
const LIFECYCLE_FLOW_ORDER: readonly TaskAssignmentFlow[] = [
  "receiving-cn",
  "picking",
  "labeling",
  "label-printing",
  "measuring",
  "verify",
  "put-away",
  "put-away-cn",
];

/** One flow's "context column equals the searched key" predicate:
 *  receiving-cn/put-away-cn = batch_no; picking/labeling/label-printing =
 *  order_no; put-away = batch_no OR order_no; measuring/verify = box id OR
 *  any member order_no (boxes carry packages → items → picking orders). */
function lifecycleKeyMatch(flow: TaskAssignmentFlow, key: string): SQL {
  const boxHasOrder = (boxId: SQL) => sql`EXISTS (
      SELECT 1
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE pp.shipping_box_id = ${boxId} AND po.order_no = ${key})`;
  switch (flow) {
    case "receiving-cn":
      return sql`batch_no = ${key}`;
    case "picking":
    case "labeling":
    case "label-printing":
      return sql`order_no = ${key}`;
    case "put-away":
      return sql`(ro.batch_no = ${key} OR ito.order_no = ${key})`;
    case "put-away-cn":
      return sql`ro.batch_no = ${key}`;
    case "measuring":
      return sql`(sb.id = ${key} OR ${boxHasOrder(sql`sb.id`)})`;
    case "verify":
      return sql`(vt.shipping_box_id = ${key} OR ${boxHasOrder(sql`vt.shipping_box_id`)})`;
  }
}

/** Steps of the searched key across all 8 flows, in lifecycle order. */
export async function listTaskLifecycle(db: AppDb, key: string): Promise<TaskLifecycleStep[]> {
  const steps: TaskLifecycleStep[] = [];
  for (const flow of LIFECYCLE_FLOW_ORDER) {
    const rows = await listTaskAssignments(db, flow, lifecycleKeyMatch(flow, key));
    for (const row of rows) {
      steps.push({ flow, id: row.id, label: row.label, status: row.status, assignee: row.assignee });
    }
  }
  return steps;
}

/** flow → assignee-bearing table + transaction_logs entity type. */
const FLOW_TABLES: Record<TaskAssignmentFlow, { table: SQL; entityType: string }> = {
  "receiving-cn": { table: sql`receiving_orders_cn`, entityType: "receiving_order_cn" },
  picking: { table: sql`picking_orders`, entityType: "picking_order" },
  "label-printing": { table: sql`picking_orders`, entityType: "picking_order" },
  labeling: { table: sql`picking_orders`, entityType: "picking_order" },
  "put-away": { table: sql`put_away_tasks`, entityType: "put_away_task" },
  "put-away-cn": { table: sql`put_away_tasks_cn`, entityType: "put_away_task_cn" },
  measuring: { table: sql`shipping_boxes`, entityType: "shipping_box" },
  verify: { table: sql`verify_tasks`, entityType: "verify_task" },
};

/** Set (or clear with null) one task's assignee. 404 task_not_found on an
 *  unknown id; writes a transaction_logs audit row (from/to = assignee). */
export async function setTaskAssignee(
  db: AppDb,
  input: { flow: TaskAssignmentFlow; id: string; assignee: string | null; actorId: string | null }
): Promise<{ ok: true; flow: TaskAssignmentFlow; id: string; assignee: string | null }> {
  const { table, entityType } = FLOW_TABLES[input.flow];
  return db.transaction(async (tx) => {
    const existing = await queryGet<{ assignee: string | null }>(
      tx,
      sql`SELECT assignee FROM ${table} WHERE id = ${input.id}`
    );
    if (!existing) throw new HTTPException(404, { message: "task_not_found" });
    const at = now();
    await queryRun(
      tx,
      sql`UPDATE ${table} SET assignee = ${input.assignee}, last_update_date = ${at} WHERE id = ${input.id}`
    );
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType,
      entityId: input.id,
      fromState: existing.assignee,
      toState: "admin_edit",
      actorId: input.actorId,
      metadata: { flow: input.flow, field: "assignee", from: existing.assignee, to: input.assignee },
      createdDate: at,
    });
    return { ok: true, flow: input.flow, id: input.id, assignee: input.assignee };
  });
}
