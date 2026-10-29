import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { isStepEnabled } from "../config.js";
import { now } from "./now.js";
import { resolveLabelPrintRulesForOrder } from "./labelPrint.js";

// ---------------------------------------------------------------------------
// Verify flow (box-scoped, 2026-08-11 design). A verify_tasks row is created
// when the verify step is enabled — one pending task per box — either by
// closeShippingBox (measuring step on) or by finishPickingOrder on the
// still-open box (measuring step off; the verify completion then closes the
// box). Verify is a second pass over that box: the worker re-scans every
// package (verify_verified; a closed box may be re-opened via
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
// Label mode (2026-10-30 label-source-and-label-verify): an order is
// "labeled" when ≥ 1 active INTERNAL label-print rule matches it (evaluated
// live per box load). Packages of labeled orders follow label mode in
// verify/measuring; the rest (external-only and rule-less orders) stay
// aggregate. Printed-label matching is template-agnostic: raw-string equality
// against any string value of a recorded label_prints payload row's params.
// ---------------------------------------------------------------------------

/** Subset of `orderIds` that are labeled (≥ 1 internal active rule match). */
export async function labeledOrderIds(db: DbOrTx, orderIds: string[]): Promise<Set<string>> {
  const labeled = new Set<string>();
  for (const orderId of new Set(orderIds)) {
    const { matches } = await resolveLabelPrintRulesForOrder(db, orderId);
    if (matches.some((m) => m.labelSource === "internal")) labeled.add(orderId);
  }
  return labeled;
}

/** Any string value of the payload row's params equals the raw scan. */
function paramsContainRaw(raw: string): ReturnType<typeof sql> {
  return sql`EXISTS (SELECT 1 FROM jsonb_each_text(el -> 'params') kv WHERE kv.value = ${raw})`;
}

/** True when a carton print record targets this box. */
export async function cartonPrintExists(db: DbOrTx, boxId: string): Promise<boolean> {
  const row = await queryGet<{ id: string }>(
    db,
    sql`SELECT lp.id
        FROM label_prints lp, jsonb_array_elements(lp.payload) el
        WHERE lp.label_type = 'carton' AND el ->> 'shippingBoxId' = ${boxId}
        LIMIT 1`
  );
  return row !== undefined;
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
  /** A carton print record exists for this box (carton label scan required at completion). */
  cartonLabelRequired: boolean;
  cartonLabelVerified: boolean;
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
  /** Re-scan credit (mode-agnostic): completion when rescannedQty >= qty. */
  rescannedQty: number;
  /** Raw scan string of the source label (traceability/display only). */
  labelBarcode: string | null;
  /** Pick-time scanned batch fields (2026-10-14) — the re-scan comparison
   *  anchor; NULL on legacy rows → consumers fall back to the source snapshot
   *  (dateCode/lotCode/coo/cow above). */
  scannedDateCode: string | null;
  scannedLotCode: string | null;
  scannedCoo: string | null;
  scannedCow: string | null;
  partNo: string;
  wclItemNo: string | null;
  /** Label mode (2026-10-30): the package's order matched ≥ 1 internal rule. */
  labelMode: boolean;
  /** The package's printed label has been scanned. */
  labelVerified: boolean;
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

  const box = (await queryGet<Omit<VerifyBoxRow, "suggestedNetWeightKg" | "cartonLabelRequired">>(
    db,
    sql`SELECT id, picking_order_id AS "pickingOrderId", status, box_size AS "boxSize",
               gross_weight AS "grossWeight", net_weight AS "netWeight",
               destination_country AS "destinationCountry", shipped_at AS "shippedAt",
               carton_label_verified AS "cartonLabelVerified"
        FROM shipping_boxes WHERE id = ${task.shippingBoxId}`
  ))!;

  const packages = await queryAll<
    VerifyPackageRow & { formulaWeight: number | null; formulaQty: number | null; pickingOrderId: string }
  >(
    db,
    sql`
      SELECT
        pp.id, pp.qty,
        pp.date_code AS "dateCode", pp.lot_code AS "lotCode", pp.coo, pp.cow, pp.verified,
        pp.verify_verified AS "verifyVerified",
        pp.rescanned_qty AS "rescannedQty",
        pp.label_barcode AS "labelBarcode",
        pp.scanned_date_code AS "scannedDateCode", pp.scanned_lot_code AS "scannedLotCode",
        pp.scanned_coo AS "scannedCoo", pp.scanned_cow AS "scannedCow",
        pp.label_verified AS "labelVerified",
        pi.picking_order_id AS "pickingOrderId",
        COALESCE(pp.scanned_part_no, pi.part_no) AS "partNo",
        COALESCE(pp.scanned_wcl_item_no, p.wcl_item_no) AS "wclItemNo",
        nwf.weight AS "formulaWeight", nwf.qty AS "formulaQty"
      FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id
      JOIN parts p ON p.wcl_item_no = pi.part_no
      LEFT JOIN net_weight_formula nwf ON nwf.part_no = pi.part_no
      WHERE pp.shipping_box_id = ${task.shippingBoxId}
      ORDER BY pp.created_date, pp.id
    `
  );

  const labeled = await labeledOrderIds(db, packages.map((p) => p.pickingOrderId));
  const cartonLabelRequired = await cartonPrintExists(db, task.shippingBoxId);

  return {
    task,
    box: { ...box, cartonLabelRequired, suggestedNetWeightKg: suggestedNetWeightKg(packages) },
    packages: packages.map(({ formulaWeight: _fw, formulaQty: _fq, pickingOrderId, ...rest }) => ({
      ...rest,
      labelMode: labeled.has(pickingOrderId),
    })),
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

export interface LabelLookupResult {
  taskId: string | null; // null when the box is still open (measuring pass)
  shippingBoxId: string;
}

/**
 * Box resolution by carton label (2026-10-30): the raw scan matches a recorded
 * carton print row (any string value of its params) whose box has a pending
 * verify task or is still open. Stamps the box's carton_label_verified
 * triple. 404 label_print_not_found on no match; idempotent on re-scan.
 */
export async function lookupVerifyTaskByLabel(
  db: AppDb,
  input: { raw: string; actorId: string }
): Promise<LabelLookupResult> {
  return db.transaction(async (tx) => {
    await assertActor(tx, input.actorId);
    const candidates = await queryAll<{ shippingBoxId: string }>(
      tx,
      sql`SELECT DISTINCT el ->> 'shippingBoxId' AS "shippingBoxId"
          FROM label_prints lp, jsonb_array_elements(lp.payload) el
          WHERE lp.label_type = 'carton'
            AND el ->> 'shippingBoxId' IS NOT NULL
            AND ${paramsContainRaw(input.raw)}
          ORDER BY 1`
    );
    for (const { shippingBoxId } of candidates) {
      const box = await queryGet<{ id: string; status: string }>(
        tx,
        sql`SELECT id, status FROM shipping_boxes WHERE id = ${shippingBoxId}`
      );
      if (!box) continue;
      const task = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM verify_tasks WHERE shipping_box_id = ${box.id} AND status = 'pending'`
      );
      if (!task && box.status !== "open") continue;
      await queryRun(
        tx,
        sql`UPDATE shipping_boxes
            SET carton_label_verified = true, carton_label_verified_at = ${now()},
                carton_label_verified_by = ${input.actorId}, last_update_date = ${now()}
            WHERE id = ${box.id}`
      );
      return { taskId: task?.id ?? null, shippingBoxId: box.id };
    }
    throw new HTTPException(404, { message: "label_print_not_found" });
  });
}

export interface LabelScanExpectations {
  partNo: string;
  wclItemNo: string | null;
  coo: string | null;
  dateCode: string | null;
  qty: number;
}

export interface LabelScanResult {
  kind: "carton" | "item";
  packageId?: string;
  expectations?: LabelScanExpectations;
}

/**
 * Label-mode label scan within a verify task's box (2026-10-30). Carton print
 * rows for the box match first (stamps carton_label_verified); then
 * item/item_box print rows of the box's orders (marks the linked package
 * label_verified and returns its anchored expectations — the same values the
 * label was printed from). 404 label_print_not_found on no match; idempotent
 * on re-scan.
 */
export async function scanVerifyTaskLabel(
  db: AppDb,
  input: { taskId: string; raw: string; actorId: string }
): Promise<LabelScanResult> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; shippingBoxId: string }>(
      tx,
      sql`SELECT id, shipping_box_id AS "shippingBoxId" FROM verify_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "verify_task_not_found" });
    await assertActor(tx, input.actorId);
    const boxId = task.shippingBoxId;

    const cartonHit = await queryGet<{ id: string }>(
      tx,
      sql`SELECT lp.id
          FROM label_prints lp, jsonb_array_elements(lp.payload) el
          WHERE lp.label_type = 'carton'
            AND el ->> 'shippingBoxId' = ${boxId}
            AND ${paramsContainRaw(input.raw)}
          LIMIT 1`
    );
    if (cartonHit) {
      await queryRun(
        tx,
        sql`UPDATE shipping_boxes
            SET carton_label_verified = true, carton_label_verified_at = ${now()},
                carton_label_verified_by = ${input.actorId}, last_update_date = ${now()}
            WHERE id = ${boxId}`
      );
      return { kind: "carton" };
    }

    const itemHit = await queryGet<{ packageId: string }>(
      tx,
      sql`SELECT el ->> 'packageId' AS "packageId"
          FROM label_prints lp, jsonb_array_elements(lp.payload) el
          WHERE lp.label_type IN ('item', 'item_box')
            AND ${paramsContainRaw(input.raw)}
            AND (el ->> 'packageId') IN (
              SELECT id FROM picking_packages WHERE shipping_box_id = ${boxId}
            )
          ORDER BY lp.created_date DESC
          LIMIT 1`
    );
    if (!itemHit?.packageId) throw new HTTPException(404, { message: "label_print_not_found" });

    await queryRun(
      tx,
      sql`UPDATE picking_packages
          SET label_verified = true, label_verified_at = ${now()},
              label_verified_by = ${input.actorId}, last_update_date = ${now()}
          WHERE id = ${itemHit.packageId}`
    );
    const pkg = (await queryGet<LabelScanExpectations>(
      tx,
      sql`SELECT pp.qty,
                 COALESCE(pp.scanned_part_no, pi.part_no) AS "partNo",
                 COALESCE(pp.scanned_wcl_item_no, p.wcl_item_no) AS "wclItemNo",
                 COALESCE(pp.scanned_coo, pp.coo) AS coo,
                 COALESCE(pp.scanned_date_code, pp.date_code) AS "dateCode"
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN parts p ON p.wcl_item_no = pi.part_no
          WHERE pp.id = ${itemHit.packageId}`
    ))!;
    return { kind: "item", packageId: itemHit.packageId, expectations: pkg };
  });
}

/**
 * Complete a box's verify task: the task must be pending and every package
 * in the box must be fully re-scanned (`rescanned_qty >= qty`). With the
 * measuring step enabled the box must already be closed (the measuring close
 * spawned the task); with measuring disabled the finish spawned the task on
 * the open box and this completion closes it (no weights/size — nothing is
 * measured). Sets status 'completed' + transition log, then flips every
 * `picking_finished` order with packages in this box to
 * `measuring_finished` when no other pending verify task remains for it
 * (spec 2026-10-22). No stock movement.
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

    const box = await queryGet<{
      id: string;
      status: string;
      pickingOrderId: string | null;
      destinationCountry: string | null;
      cartonLabelVerified: boolean;
    }>(
      tx,
      sql`SELECT id, status, picking_order_id AS "pickingOrderId",
                 destination_country AS "destinationCountry",
                 carton_label_verified AS "cartonLabelVerified"
          FROM shipping_boxes WHERE id = ${task.shippingBoxId}`
    );
    // Measuring ON: the box must already be closed (measuring close spawns
    // the task). Measuring OFF: the finish spawned the task on the open box
    // and this completion closes it (no weights/size — nothing is measured).
    const measuringOn = isStepEnabled("measuring");
    if (!box || (measuringOn ? box.status !== "closed" : box.status !== "closed" && box.status !== "open")) {
      throw new HTTPException(409, { message: "shipping_box_not_closed" });
    }

    const notRescanned = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_packages WHERE shipping_box_id = ${task.shippingBoxId} AND rescanned_qty < qty LIMIT 1`
    );
    if (notRescanned) throw new HTTPException(409, { message: "packages_not_all_rescanned" });

    // Label gate (2026-10-30): every package with an item/item_box print
    // record must be label_verified, and a box with a carton print record must
    // be carton_label_verified. Packages whose label was never printed fall
    // back to plain aggregate (no print row → nothing to check).
    const unverifiedItemLabel = await queryGet<{ id: string }>(
      tx,
      sql`SELECT pp.id
          FROM label_prints lp, jsonb_array_elements(lp.payload) el
          JOIN picking_packages pp ON pp.id = el ->> 'packageId'
          WHERE lp.label_type IN ('item', 'item_box')
            AND pp.shipping_box_id = ${task.shippingBoxId}
            AND NOT pp.label_verified
          LIMIT 1`
    );
    if (unverifiedItemLabel) throw new HTTPException(409, { message: "labels_not_all_verified" });
    if (!box.cartonLabelVerified && (await cartonPrintExists(tx, task.shippingBoxId))) {
      throw new HTTPException(409, { message: "labels_not_all_verified" });
    }

    if (!measuringOn && box.status === "open") {
      let dest = box.destinationCountry;
      if (dest === null || dest.trim() === "") {
        const order = await queryGet<{ st: string | null }>(
          tx,
          sql`SELECT ship_to AS st FROM picking_orders WHERE id = ${box.pickingOrderId}`
        );
        dest = order?.st ?? null;
      }
      await queryRun(
        tx,
        sql`UPDATE shipping_boxes SET status = 'closed', destination_country = ${dest}, last_update_date = ${now()} WHERE id = ${box.id}`
      );
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "shipping_box",
        entityId: box.id,
        fromState: "open",
        toState: "closed",
        actorId: input.actorId,
        metadata: {},
        createdDate: now(),
      });
    }

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

    // Picking status split (spec 2026-10-22): flip every picking_finished
    // order holding packages in this box to measuring_finished once no OTHER
    // pending verify task remains for any box containing that order's
    // packages. Orders already shipped are untouched.
    const orderIds = await queryAll<{ id: string; status: string }>(
      tx,
      sql`SELECT DISTINCT po.id, po.status
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE pp.shipping_box_id = ${task.shippingBoxId}`
    );
    for (const order of orderIds) {
      if (order.status !== "picking_finished") continue;
      const otherPending = await queryGet<{ id: string }>(
        tx,
        sql`SELECT vt.id FROM verify_tasks vt
            WHERE vt.status = 'pending'
              AND EXISTS (
                SELECT 1 FROM picking_packages pp2
                JOIN picking_items pi2 ON pi2.id = pp2.picking_item_id
                WHERE pp2.shipping_box_id = vt.shipping_box_id
                  AND pi2.picking_order_id = ${order.id}
              )
            LIMIT 1`
      );
      if (otherPending) continue;
      await queryRun(
        tx,
        sql`UPDATE picking_orders SET status = 'measuring_finished', last_update_date = ${now()} WHERE id = ${order.id}`
      );
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "picking_order",
        entityId: order.id,
        fromState: "picking_finished",
        toState: "measuring_finished",
        actorId: input.actorId,
        metadata: {},
        createdDate: now(),
      });
    }
  });
}
