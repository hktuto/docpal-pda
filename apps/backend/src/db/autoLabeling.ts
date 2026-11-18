// Auto labeling machine print jobs (spec 2026-11-12-auto-labeling-machine).
// The PDA creates a pending job instead of printing; the machine claims it
// (fetch → printing) and reports the result back (patch → completed/failed).
// Auto jobs are NOT written to label_prints and do not participate in
// label-mode verify — the machine's verification is the verification.

import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { autoLabelingJobs } from "./schema/index.js";
import { resolveLabelPrintRulesForOrder } from "./labelPrint.js";
import { buildLinkedLabelPrintParams } from "./labelPrintParams.js";
import { getPickingOrderDetail, type PickingOrderDetail } from "./picking.js";
import type { UserScopeEntry } from "./user-scope.js";

const VALID_STATUSES = new Set(["completed", "failed"]);

export interface AutoLabelingJobRow {
  id: string;
  pickingOrderId: string;
  machineId: string | null;
  status: string;
  statusNote: string | null;
  createdBy: string;
  fetchedDate: Date | null;
  completedDate: Date | null;
  createdDate: Date;
  lastUpdateDate: Date;
  labelCount: number;
}

/** Subset of the picking order the machine needs to display/check. */
function orderSnapshot(order: PickingOrderDetail, brands: string[]) {
  return {
    orderNo: order.orderNo,
    poNo: order.poNo,
    customerCode: order.customerCode,
    shipTo: order.shipTo,
    deliveryDate: order.deliveryDate,
    orgId: order.orgId,
    subInventoryCode: order.subInventoryCode,
    pickingOrderType: order.pickingOrderType,
    remark: order.remark,
    brands,
  };
}

/** The pick-time scan records: one entry per package with its batch fields
 *  (both the stored source snapshot and the scanned overrides). */
function scanSnapshot(order: PickingOrderDetail) {
  return order.items.flatMap((item) =>
    item.packages.map((pkg) => ({
      partNo: item.partNo,
      wclItemNo: item.wclItemNo,
      brand: item.brand,
      qty: pkg.qty,
      dateCode: pkg.dateCode,
      lotCode: pkg.lotCode,
      coo: pkg.coo,
      cow: pkg.cow,
      scannedDateCode: pkg.scannedDateCode,
      scannedLotCode: pkg.scannedLotCode,
      scannedCoo: pkg.scannedCoo,
      scannedCow: pkg.scannedCow,
      shippingBoxId: pkg.shippingBoxId,
      labelBarcode: pkg.labelBarcode,
    }))
  );
}

async function brandList(db: DbOrTx, orderId: string): Promise<string[]> {
  const rows = await queryAll<{ brand: string }>(
    db,
    sql`
      SELECT DISTINCT p.brand
      FROM picking_items pi
      JOIN parts p ON p.wcl_item_no = pi.part_no
      WHERE pi.picking_order_id = ${orderId} AND p.brand IS NOT NULL
    `
  );
  return rows.map((r) => r.brand);
}

/** PDA-side creation: validate the rule the same way printOrderLabel does,
 *  require an auto_machine rule, convert the labels, insert a pending job. */
export async function createAutoLabelingJob(
  db: DbOrTx,
  input: {
    orderId: string;
    ruleId: string;
    actorId: string;
    scope?: UserScopeEntry[] | null;
    username?: string;
  }
): Promise<AutoLabelingJobRow> {
  const rule = await queryGet<{ id: string; active: boolean }>(
    db,
    sql`SELECT id, active FROM label_print_rules WHERE id = ${input.ruleId}`
  );
  if (!rule) throw new HTTPException(404, { message: "label_print_rule_not_found" });
  if (!rule.active) throw new HTTPException(409, { message: "label_print_rule_inactive" });

  // Re-validate against the order (rules may have changed since the client
  // fetched the matches); also 404s unknown orders.
  const { matches } = await resolveLabelPrintRulesForOrder(db, input.orderId);
  const match = matches.find((m) => m.ruleId === input.ruleId);
  if (!match) throw new HTTPException(409, { message: "label_rule_no_longer_matches" });
  if (match.labelSource !== "auto_machine") {
    throw new HTTPException(409, { message: "label_rule_not_auto_machine" });
  }

  const order = await getPickingOrderDetail(db, input.orderId, input.scope, input.username);
  const rows = await buildLinkedLabelPrintParams({ db, order, match });
  if (rows.length === 0) {
    throw new HTTPException(400, { message: "printing_params_required" });
  }

  const id = newId();
  await db.insert(autoLabelingJobs).values({
    id,
    pickingOrderId: input.orderId,
    machineId: null,
    payload: rows,
    orderSnapshot: orderSnapshot(order, await brandList(db, input.orderId)),
    scanSnapshot: scanSnapshot(order),
    status: "pending",
    createdBy: input.actorId,
    createdDate: now(),
    lastUpdateDate: now(),
  });

  return {
    id,
    pickingOrderId: input.orderId,
    machineId: null,
    status: "pending",
    statusNote: null,
    createdBy: input.actorId,
    fetchedDate: null,
    completedDate: null,
    createdDate: now(),
    lastUpdateDate: now(),
    labelCount: rows.length,
  };
}

function rowToResult(row: Record<string, unknown>): AutoLabelingJobRow {
  return {
    id: String(row.id),
    pickingOrderId: String(row.picking_order_id ?? row.pickingOrderId),
    machineId: (row.machine_id as string | null) ?? (row.machineId as string | null) ?? null,
    status: String(row.status),
    statusNote: (row.status_note as string | null) ?? (row.statusNote as string | null) ?? null,
    createdBy: String(row.created_by ?? row.createdBy),
    fetchedDate: (row.fetched_date as Date | null) ?? (row.fetchedDate as Date | null) ?? null,
    completedDate: (row.completed_date as Date | null) ?? (row.completedDate as Date | null) ?? null,
    createdDate: (row.created_date as Date) ?? (row.createdDate as Date),
    lastUpdateDate: (row.last_update_date as Date) ?? (row.lastUpdateDate as Date),
    labelCount: Array.isArray(row.payload) ? row.payload.length : 0,
  };
}

/** Machine-side claim. With `jobId`: re-claim a known printing/failed job
 *  (idempotent — the machine retries from the same payload). Otherwise the
 *  newest `pending` job visible to the machine (machine_id = machineId or
 *  NULL) → `printing` + fetched_date. */
export async function fetchAutoLabelingJob(
  db: DbOrTx,
  input: { machineId?: string; jobId?: string }
): Promise<AutoLabelingJobRow & { payload: unknown; orderSnapshot: unknown; scanSnapshot: unknown }> {
  if (input.jobId) {
    const row = await queryGet<Record<string, unknown>>(
      db,
      sql`
        UPDATE auto_labeling_jobs SET status = 'printing',
               machine_id = COALESCE(machine_id, ${input.machineId ?? null}),
               fetched_date = now(), last_update_date = now()
        WHERE id = ${input.jobId} AND status IN ('printing', 'failed')
        RETURNING *
      `
    );
    if (!row) throw new HTTPException(404, { message: "auto_labeling_no_pending_job" });
    return { ...rowToResult(row), payload: row.payload, orderSnapshot: row.order_snapshot, scanSnapshot: row.scan_snapshot };
  }

  const machineClause = input.machineId
    ? sql`(machine_id = ${input.machineId} OR machine_id IS NULL)`
    : sql`machine_id IS NULL`;
  const row = await queryGet<Record<string, unknown>>(
    db,
    sql`
      UPDATE auto_labeling_jobs SET status = 'printing', machine_id = ${input.machineId ?? null},
             fetched_date = now(), last_update_date = now()
      WHERE id = (
        SELECT id FROM auto_labeling_jobs
        WHERE status = 'pending' AND ${machineClause}
        ORDER BY created_date DESC, id DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `
  );
  if (!row) throw new HTTPException(404, { message: "auto_labeling_no_pending_job" });
  return { ...rowToResult(row), payload: row.payload, orderSnapshot: row.order_snapshot, scanSnapshot: row.scan_snapshot };
}

/** Machine-side result report: printing → completed | failed. A failed job
 *  may receive further failed reports (note updates) while the machine
 *  retries. */
export async function reportAutoLabelingJob(
  db: DbOrTx,
  input: { id: string; status: string; note?: string }
): Promise<AutoLabelingJobRow> {
  if (!VALID_STATUSES.has(input.status)) {
    throw new HTTPException(400, { message: "auto_labeling_status_invalid" });
  }
  const row = await queryGet<Record<string, unknown>>(
    db,
    sql`
      UPDATE auto_labeling_jobs SET
        status = ${input.status},
        status_note = ${input.note ?? null},
        completed_date = CASE WHEN ${input.status} = 'completed' THEN now() ELSE completed_date END,
        last_update_date = now()
      WHERE id = ${input.id} AND (
        (status = 'printing') OR (status = 'failed' AND ${input.status} = 'failed')
      )
      RETURNING *
    `
  );
  if (!row) {
    throw new HTTPException(409, { message: "auto_labeling_job_state" });
  }
  return rowToResult(row);
}

/** Latest job for a picking order (PDA status display). */
export async function latestAutoLabelingJobForOrder(
  db: DbOrTx,
  orderId: string
): Promise<AutoLabelingJobRow | null> {
  const rows = await queryAll<Record<string, unknown>>(
    db,
    sql`
      SELECT * FROM auto_labeling_jobs
      WHERE picking_order_id = ${orderId}
      ORDER BY created_date DESC, id DESC
      LIMIT 1
    `
  );
  return rows[0] ? rowToResult(rows[0]) : null;
}
