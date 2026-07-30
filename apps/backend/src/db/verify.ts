import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Verify flow (spec: docs/superpowers/specs/2026-07-28-verify-step-and-flow-
// step-config-design.md). Verify is a second pass over the same boxes after
// measuring: the worker may re-open boxes (POST /shipping-boxes/:id/reopen),
// edit measurements and re-verify packages (full re-measure), then confirm.
// Mirrors the measuring module — a verify_tasks row is created when a
// measuring task completes (or directly at picking finish when the measuring
// step is disabled); box work reuses the picking routes. This module adds the
// task reads + completion:
//   - list with server-side box counts (closed = any status but 'open')
//   - consolidated detail {task, order, boxes[packages with part identity]}
//   - complete: pending task + all boxes closed + nothing left unboxed →
//     status 'completed' + transition log. No stock movement, and the picking
//     order status is NOT flipped.
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
    createdDate: now(),
  });
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface VerifyTaskListRow {
  id: string;
  status: string;
  pickingOrderId: string;
  orderNo: string;
  shipTo: string | null;
  boxCount: number;
  closedBoxCount: number;
  createdDate: Date;
}

/** List rows with per-task box counts; `status` is a pass-through filter. */
export async function listVerifyTasks(db: AppDb, status?: string): Promise<VerifyTaskListRow[]> {
  return queryAll<VerifyTaskListRow>(
    db,
    sql`
      SELECT
        vt.id, vt.status, vt.picking_order_id AS "pickingOrderId",
        po.order_no AS "orderNo", po.ship_to AS "shipTo",
        COUNT(sb.id)::int AS "boxCount",
        COUNT(sb.id) FILTER (WHERE sb.status <> 'open')::int AS "closedBoxCount",
        vt.created_date AS "createdDate"
      FROM verify_tasks vt
      JOIN picking_orders po ON po.id = vt.picking_order_id
      LEFT JOIN shipping_boxes sb ON sb.picking_order_id = vt.picking_order_id
      ${status ? sql`WHERE vt.status = ${status}` : sql``}
      GROUP BY vt.id, po.order_no, po.ship_to
      ORDER BY vt.created_date DESC, vt.id DESC
    `
  );
}

export interface VerifyTaskRow {
  id: string;
  status: string;
  pickingOrderId: string;
  createdDate: Date;
}

export interface VerifyOrderRow {
  id: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  poNo: string | null;
}

export interface VerifyPackageRow {
  id: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  verified: boolean;
  verifyVerified: boolean;
  partNo: string;
  wclItemNo: string | null;
}

export interface VerifyBoxRow {
  id: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  suggestedNetWeightKg: number | null;
  packages: VerifyPackageRow[];
}

export interface VerifyTaskDetail {
  task: VerifyTaskRow;
  order: VerifyOrderRow;
  boxes: VerifyBoxRow[];
}

/** Consolidated read: task + order + boxes with their packages (part identity embedded). */
export async function getVerifyTaskDetail(db: AppDb, taskId: string): Promise<VerifyTaskDetail> {
  const task = await queryGet<VerifyTaskRow>(
    db,
    sql`SELECT id, status, picking_order_id AS "pickingOrderId", created_date AS "createdDate"
        FROM verify_tasks WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "verify_task_not_found" });

  const order = (await queryGet<VerifyOrderRow>(
    db,
    sql`SELECT id, order_no AS "orderNo", status, ship_to AS "shipTo",
               customer_code AS "customerCode",
               po_no AS "poNo"
        FROM picking_orders WHERE id = ${task.pickingOrderId}`
  ))!;

  const boxes = await queryAll<Omit<VerifyBoxRow, "packages">>(
    db,
    sql`SELECT id, status, box_size AS "boxSize",
               gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry"
        FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId}
        ORDER BY created_date, id`
  );
  const boxIds = boxes.map((b) => b.id);

  const packages = boxIds.length
    ? await queryAll<VerifyPackageRow & { shippingBoxId: string; formulaWeight: number | null; formulaQty: number | null }>(
        db,
        sql`
          SELECT
            pp.id, pp.shipping_box_id AS "shippingBoxId", pp.qty,
            pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
            pp.verify_verified AS "verifyVerified",
            pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
            nwf.weight AS "formulaWeight", nwf.qty AS "formulaQty"
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN parts p ON p.part_no = pi.part_no
          LEFT JOIN net_weight_formula nwf ON nwf.part_no = pi.part_no
          WHERE ${inArray(sql`pp.shipping_box_id`, boxIds)}
          ORDER BY pp.created_date, pp.id
        `
      )
    : [];

  return {
    task,
    order,
    boxes: boxes.map((b) => {
      const boxPackages = packages.filter((p) => p.shippingBoxId === b.id);
      return {
        ...b,
        suggestedNetWeightKg: suggestedNetWeightKg(boxPackages),
        packages: boxPackages.map(({ shippingBoxId: _shippingBoxId, formulaWeight: _fw, formulaQty: _fq, ...rest }) => rest),
      };
    }),
  };
}

/**
 * Suggested net weight from the net_weight_formula master: Σ over the box's
 * packages of (formula.weight / formula.qty) × pkg.qty grams, converted to kg
 * and rounded to 3 dp. Parts without a formula row contribute 0; null when no
 * package has a formula at all.
 */
function suggestedNetWeightKg(
  packages: { qty: number; formulaWeight: number | null; formulaQty: number | null }[]
): number | null {
  let grams = 0;
  let any = false;
  for (const p of packages) {
    if (p.formulaWeight === null || p.formulaQty === null) continue;
    any = true;
    grams += (p.formulaWeight / p.formulaQty) * p.qty;
  }
  if (!any) return null;
  return Math.round((grams / 1000) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Complete a verify task (mirrors completeMeasuringTask): the task must be
 * pending, every shipping box of the order must be closed, no package may be
 * left unboxed, and every package must have been re-scanned during the verify
 * step (`verify_verified`). Sets status 'completed' + transition log. No stock
 * movement; the picking order status is left untouched (stays 'finished').
 */
export async function completeVerifyTask(db: AppDb, input: { taskId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; pickingOrderId: string; status: string }>(
      tx,
      sql`SELECT id, picking_order_id AS "pickingOrderId", status FROM verify_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "verify_task_not_found" });
    await assertActor(tx, input.actorId);
    if (task.status !== "pending") throw new HTTPException(409, { message: "verify_task_not_pending" });

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

    const notRescanned = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_packages WHERE picking_order_id = ${task.pickingOrderId} AND NOT verify_verified LIMIT 1`
    );
    if (notRescanned) throw new HTTPException(409, { message: "packages_not_all_rescanned" });

    await queryRun(tx, sql`UPDATE verify_tasks SET status = 'completed' WHERE id = ${task.id}`);
    await logTransition(tx, {
      entityType: "verify_task",
      entityId: task.id,
      fromState: "pending",
      toState: "completed",
      actorId: input.actorId,
    });
  });
}
