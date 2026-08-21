import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Verify flow (box-scoped, 2026-08-11 design). A verify_tasks row is created
// by closeShippingBox when the verify step is enabled — one pending task per
// box. Verify is a second pass over that box: the worker re-scans every
// package (verify_verified; the box may be re-opened via
// POST /shipping-boxes/:id/reopen, which resets both flags and keeps the task
// pending), then completes. A box may hold packages from several picking
// orders (cross-order packing) — order numbers are aggregated per box.
// This module adds the task reads + completion:
//   - list with per-box package/re-scan counts
//   - detail {task, box, packages with part identity}
//   - complete: pending task + box closed + every package re-scanned →
//     status 'completed' + transition log. No stock movement.
// ---------------------------------------------------------------------------

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface VerifyTaskListRow {
  taskId: string;
  status: string;
  shippingBoxId: string;
  boxStatus: string;
  orderNos: string[];
  destinationCountry: string | null;
  packageCount: number;
  verifyVerifiedCount: number;
  createdDate: Date;
}

/** List rows with per-box package/re-scan counts; `status` is a pass-through filter. */
export async function listVerifyTasks(db: AppDb, status?: string): Promise<VerifyTaskListRow[]> {
  return queryAll<VerifyTaskListRow>(
    db,
    sql`
      SELECT
        vt.id AS "taskId", vt.status, vt.shipping_box_id AS "shippingBoxId",
        sb.status AS "boxStatus",
        COALESCE(array_agg(DISTINCT po.order_no) FILTER (WHERE po.order_no IS NOT NULL), '{}') AS "orderNos",
        sb.destination_country AS "destinationCountry",
        COUNT(pp.id)::int AS "packageCount",
        COUNT(pp.id) FILTER (WHERE pp.verify_verified)::int AS "verifyVerifiedCount",
        vt.created_date AS "createdDate"
      FROM verify_tasks vt
      JOIN shipping_boxes sb ON sb.id = vt.shipping_box_id
      LEFT JOIN picking_packages pp ON pp.shipping_box_id = sb.id
      LEFT JOIN picking_items pi ON pi.id = pp.picking_item_id
      LEFT JOIN picking_orders po ON po.id = pi.picking_order_id
      ${status ? sql`WHERE vt.status = ${status}` : sql``}
      GROUP BY vt.id, sb.id
      ORDER BY vt.created_date DESC, vt.id DESC
    `
  );
}

export interface VerifyTaskRow {
  id: string;
  status: string;
  shippingBoxId: string;
  createdDate: Date;
}

export interface VerifyBoxRow {
  id: string;
  pickingOrderId: string | null;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  destinationCountry: string | null;
  shippedAt: Date | null;
  suggestedNetWeightKg: number | null;
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

export interface VerifyTaskDetail {
  task: VerifyTaskRow;
  box: VerifyBoxRow;
  packages: VerifyPackageRow[];
}

/** Consolidated read: task + its box + the box's packages (part identity embedded). */
export async function getVerifyTaskDetail(db: AppDb, taskId: string): Promise<VerifyTaskDetail> {
  const task = await queryGet<VerifyTaskRow>(
    db,
    sql`SELECT id, status, shipping_box_id AS "shippingBoxId", created_date AS "createdDate"
        FROM verify_tasks WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "verify_task_not_found" });

  const box = (await queryGet<Omit<VerifyBoxRow, "suggestedNetWeightKg">>(
    db,
    sql`SELECT id, picking_order_id AS "pickingOrderId", status, box_size AS "boxSize",
               gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry", shipped_at AS "shippedAt"
        FROM shipping_boxes WHERE id = ${task.shippingBoxId}`
  ))!;

  const packages = await queryAll<VerifyPackageRow & { formulaWeight: number | null; formulaQty: number | null }>(
    db,
    sql`
      SELECT
        pp.id, pp.qty,
        pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
        pp.verify_verified AS "verifyVerified",
        pi.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
        nwf.weight AS "formulaWeight", nwf.qty AS "formulaQty"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN parts p ON p.wcl_item_no = pi.part_no
      LEFT JOIN net_weight_formula nwf ON nwf.part_no = pi.part_no
      WHERE pp.shipping_box_id = ${task.shippingBoxId}
      ORDER BY pp.created_date, pp.id
    `
  );

  return {
    task,
    box: { ...box, suggestedNetWeightKg: suggestedNetWeightKg(packages) },
    packages: packages.map(({ formulaWeight: _fw, formulaQty: _fq, ...rest }) => rest),
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
 * Complete a box's verify task: the task must be pending, the box must be
 * closed, and every package in the box must have been re-scanned during the
 * verify step (`verify_verified`). Sets status 'completed' + transition log.
 * No stock movement.
 */
export async function completeVerifyTask(db: AppDb, input: { taskId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; shippingBoxId: string; status: string }>(
      tx,
      sql`SELECT id, shipping_box_id AS "shippingBoxId", status FROM verify_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "verify_task_not_found" });
    await assertActor(tx, input.actorId);
    if (task.status !== "pending") throw new HTTPException(409, { message: "verify_task_not_pending" });

    const box = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM shipping_boxes WHERE id = ${task.shippingBoxId}`
    );
    if (!box || box.status !== "closed") throw new HTTPException(409, { message: "shipping_box_not_closed" });

    const notRescanned = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_packages WHERE shipping_box_id = ${task.shippingBoxId} AND NOT verify_verified LIMIT 1`
    );
    if (notRescanned) throw new HTTPException(409, { message: "packages_not_all_rescanned" });

    await queryRun(tx, sql`UPDATE verify_tasks SET status = 'completed', last_update_date = ${now()} WHERE id = ${task.id}`);
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "verify_task",
      entityId: task.id,
      fromState: "pending",
      toState: "completed",
      actorId: input.actorId,
      metadata: {},
      createdDate: now(),
    });
  });
}
