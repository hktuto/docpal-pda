import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Measuring flow (ported from apps/api measure.ts, adapted to the new schema).
//
// A measuring_tasks row is created when a picking order finishes (Phase 3
// finish/auto-finish); box measurement itself reuses the picking routes
// (PATCH /shipping-boxes/:id weights/size, POST /packages/:id/verify, close).
// This module adds the task reads + completion:
//   - list with server-side box counts (closed = any status but 'open')
//   - consolidated detail {task, order, boxes[packages with part identity]}
//   - complete: pending task + all boxes closed + nothing left unboxed →
//     status 'completed' + transition log. No stock movement, and the picking
//     order status is NOT flipped (old completeMeasuringTask semantics).
// The old per-item "packed !== picked" guard is ported as "no unboxed
// packages for the order" — in the new schema picked_qty already tracks
// boxed-only packages, so unboxed leftovers are the only possible mismatch.
// ---------------------------------------------------------------------------

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

async function logTransition(
  tx: DbOrTx,
  entry: {
    entityType: string;
    entityId: string;
    fromState: string | null;
    toState: string;
    actorId: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(transactionLogs).values({
    id: randomUUID(),
    entityType: entry.entityType,
    entityId: entry.entityId,
    fromState: entry.fromState,
    toState: entry.toState,
    actorId: entry.actorId,
    metadata: entry.metadata ?? {},
    createdAt: now(),
  });
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface MeasuringTaskListRow {
  id: string;
  status: string;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  createdAt: Date;
}

/** List rows with per-task box counts; `status` is a pass-through filter. */
export async function listMeasuringTasks(db: AppDb, status?: string): Promise<MeasuringTaskListRow[]> {
  return queryAll<MeasuringTaskListRow>(
    db,
    sql`
      SELECT
        mt.id, mt.status, mt.picking_order_id AS "pickingOrderId",
        po.order_no AS "orderNo", po.ship_to AS "shipTo",
        COUNT(sb.id)::int AS "boxCount",
        COUNT(sb.id) FILTER (WHERE sb.status <> 'open')::int AS "closedBoxCount",
        mt.created_at AS "createdAt"
      FROM measuring_tasks mt
      JOIN picking_orders po ON po.id = mt.picking_order_id
      LEFT JOIN shipping_boxes sb ON sb.picking_order_id = mt.picking_order_id
      ${status ? sql`WHERE mt.status = ${status}` : sql``}
      GROUP BY mt.id, po.order_no, po.ship_to
      ORDER BY mt.created_at DESC, mt.id DESC
    `
  );
}

export interface MeasuringTaskRow {
  id: string;
  status: string;
  pickingOrderId: string;
  createdAt: Date;
}

export interface MeasuringOrderRow {
  id: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  poNo: string | null;
}

export interface MeasuringPackageRow {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  partNo: string;
  wclItemNo: string | null;
}

export interface MeasuringBoxRow {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  packages: MeasuringPackageRow[];
}

export interface MeasuringTaskDetail {
  task: MeasuringTaskRow;
  order: MeasuringOrderRow;
  boxes: MeasuringBoxRow[];
}

/** Consolidated read: task + order + boxes with their packages (part identity embedded). */
export async function getMeasuringTaskDetail(db: AppDb, taskId: string): Promise<MeasuringTaskDetail> {
  const task = await queryGet<MeasuringTaskRow>(
    db,
    sql`SELECT id, status, picking_order_id AS "pickingOrderId", created_at AS "createdAt"
        FROM measuring_tasks WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "measuring_task_not_found" });

  const order = (await queryGet<MeasuringOrderRow>(
    db,
    sql`SELECT id, order_no AS "orderNo", status, ship_to AS "shipTo",
               customer_code AS "customerCode",
               po_no AS "poNo"
        FROM picking_orders WHERE id = ${task.pickingOrderId}`
  ))!;

  const boxes = await queryAll<Omit<MeasuringBoxRow, "packages">>(
    db,
    sql`SELECT id, status, box_size AS "boxSize",
               gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry"
        FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId}
        ORDER BY created_at, id`
  );
  const boxIds = boxes.map((b) => b.id);

  const packages = boxIds.length
    ? await queryAll<MeasuringPackageRow & { shippingBoxId: string }>(
        db,
        sql`
          SELECT
            pp.id, pp.shipping_box_id AS "shippingBoxId", pp.qty,
            pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
            pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo"
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN parts p ON p.part_no = pi.part_no
          WHERE ${inArray(sql`pp.shipping_box_id`, boxIds)}
          ORDER BY pp.created_at, pp.id
        `
      )
    : [];

  return {
    task,
    order,
    boxes: boxes.map((b) => ({
      ...b,
      packages: packages.filter((p) => p.shippingBoxId === b.id).map(({ shippingBoxId: _shippingBoxId, ...rest }) => rest),
    })),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Complete a measuring task (ported from old completeMeasuringTask): the task
 * must be pending, every shipping box of the order must be closed, and no
 * package may be left unboxed (the old "picking item not fully packed" guard).
 * Sets status 'completed' + transition log. No stock movement; the picking
 * order status is left untouched (stays 'finished'), mirroring the old code.
 */
export async function completeMeasuringTask(db: AppDb, input: { taskId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; pickingOrderId: string; status: string }>(
      tx,
      sql`SELECT id, picking_order_id AS "pickingOrderId", status FROM measuring_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "measuring_task_not_found" });
    await assertActor(tx, input.actorId);
    if (task.status !== "pending") throw new HTTPException(409, { message: "measuring_task_not_pending" });

    const openBox = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId} AND status <> 'closed' LIMIT 1`
    );
    if (openBox) throw new HTTPException(409, { message: "shipping_boxes_not_all_closed" });

    const unboxed = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_packages WHERE picking_order_id = ${task.pickingOrderId} AND shipping_box_id IS NULL LIMIT 1`
    );
    if (unboxed) throw new HTTPException(409, { message: "picking_items_not_fully_packed" });

    await queryRun(tx, sql`UPDATE measuring_tasks SET status = 'completed' WHERE id = ${task.id}`);
    await logTransition(tx, {
      entityType: "measuring_task",
      entityId: task.id,
      fromState: "pending",
      toState: "completed",
      actorId: input.actorId,
    });
  });
}
