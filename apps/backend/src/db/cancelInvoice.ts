import { sql, inArray } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { emitEvent } from "./events.js";
import { logTransition, releaseAllocationsForItemsTx } from "./picking.js";
import { refreshAllocationStatus } from "./allocate.js";

// ---------------------------------------------------------------------------
// Cancel-invoice ingest (spec docs/superpowers/specs/2026-11-07-cancel-invoice-
// putback-design.md). The upstream writes the externally-managed
// public.cancel_invoice / public.cancel_invoice_tn tables (like
// wcl_part_drawno — no schema/migration, may be absent). Each row says an
// invoice or one TN line was cancelled upstream:
//   cancel_invoice   → pi_invoice_num   = picking_orders.order_no, whole order
//   cancel_invoice_tn→ tn_number + tn_line_id = order_no + picking_items.line_id
// We never read/write the upstream state/update_logs columns.
// cancel_records is our idempotent ingest log (dedupe on source + source_id,
// watermark = max(source_ts) over done records).
// ---------------------------------------------------------------------------

export type CancelSource = "cancel_invoice" | "cancel_invoice_tn";

export const CANCEL_SOURCES: readonly CancelSource[] = ["cancel_invoice", "cancel_invoice_tn"];

/** Outcome vocabulary stored in cancel_records.outcome. */
export const CANCEL_OUTCOMES = ["cancelled", "cancelled_with_putback", "ignored", "no_match", "error"] as const;

export interface CancelSourceRow {
  id: string;
  piInvoiceNum: string | null;
  tnNumber: string | null;
  tnLineId: number | null;
  orgId: number | null;
  sourceTs: Date;
}

/** Postgres GREATEST swallows NULLs — COALESCE the two nullable upstream stamps. */
const SOURCE_TS = sql`COALESCE(GREATEST(COALESCE(c.created_date, c.last_update_date), COALESCE(c.last_update_date, c.created_date)), 'epoch'::timestamp)`;

/**
 * New / re-updated / error-retry rows of one source, oldest first.
 * cancel_records IS the watermark (the user's "latest sync time" table, keyed
 * per row instead of one global stamp — same data, but a row that syncs in
 * late with an OLD created_date is still picked up, which a global
 * `ts >= max(source_ts)` cutoff would miss). Full scan of a small table per
 * pass, deduped by the unique (source, source_id) join.
 * shortcut: LIMIT 200/pass assumes cancellations arrive slowly; raise or
 * loop-until-empty if the upstream ever backfills thousands at once.
 */
export async function fetchCancelRows(
  db: AppDb,
  source: CancelSource,
  limit = 200
): Promise<CancelSourceRow[]> {
  const table = source === "cancel_invoice" ? sql`cancel_invoice` : sql`cancel_invoice_tn`;
  const cols =
    source === "cancel_invoice"
      ? sql`c.id, c.pi_invoice_num AS "piInvoiceNum", NULL::text AS "tnNumber", NULL::int AS "tnLineId", c.organization_id::int AS "orgId"`
      : sql`c.id, NULL::text AS "piInvoiceNum", c.tn_number AS "tnNumber", c.tn_line_id::int AS "tnLineId", c.org_id::int AS "orgId"`;
  return queryAll<CancelSourceRow>(
    db,
    sql`SELECT ${cols}, ${SOURCE_TS} AS "sourceTs"
        FROM ${table} c
        LEFT JOIN cancel_records r ON r.source = ${source} AND r.source_id = c.id
        WHERE r.id IS NULL
           OR r.status = 'error'
           -- compare at millisecond precision: source_ts is written from a JS
           -- Date, so a µs upstream stamp would look "updated" on every pass
           OR (r.status = 'done' AND date_trunc('milliseconds', ${SOURCE_TS}) > r.source_ts)
        ORDER BY ${SOURCE_TS}, c.id
        LIMIT ${limit}`
  );
}


/** Apply one source row in its own tx; records the outcome inside the same tx.
 *  Throws on any failure (the cron catches per row and logs an 'error' record). */
export async function processCancelSourceRow(db: AppDb, source: CancelSource, row: CancelSourceRow): Promise<void> {
  await db.transaction(async (tx) => {
    const res = await applyCancel(tx, source, row);
    await upsertCancelRecord(tx, source, row, res.outcome, res.message, res.orderId, res.itemId, "done");
    await emitEvent(tx, {
      type: "cancel_record.processed",
      topics: ["/cancel-records"],
      data: { source, sourceId: row.id, outcome: res.outcome },
    });
  });
}

/** Record a processing failure (the main tx rolled back — this runs outside it). */
export async function recordCancelError(db: AppDb, source: CancelSource, row: CancelSourceRow, message: string): Promise<void> {
  await upsertCancelRecord(db, source, row, "error", message, null, null, "error");
}

interface ApplyResult {
  outcome: (typeof CANCEL_OUTCOMES)[number];
  message: string | null;
  orderId: string | null;
  itemId: string | null;
}

async function applyCancel(tx: DbOrTx, source: CancelSource, row: CancelSourceRow): Promise<ApplyResult> {
  const key = source === "cancel_invoice" ? row.piInvoiceNum : row.tnNumber;
  if (!key) return { outcome: "no_match", message: "missing lookup key", orderId: null, itemId: null };
  const ledgerReason = source === "cancel_invoice" ? "cancel invoice" : "cancel TN line";

  const orders = await queryAll<{ id: string; orderNo: string; status: string; orgId: number | null; subInventoryCode: string | null }>(
    tx,
    sql`SELECT id, order_no AS "orderNo", status, org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM picking_orders WHERE order_no = ${key}`
  );
  if (orders.length === 0) return { outcome: "no_match", message: `picking order not found: ${key}`, orderId: null, itemId: null };

  let applied = false;
  let hadPutback = false;
  let sawOpen = false;
  let sawTerminal = false;
  let outcome: (typeof CANCEL_OUTCOMES)[number] = "ignored";
  let message: string | null = null;
  let firstOrderId: string | null = null;
  let firstItemId: string | null = null;

  // order_no is NOT unique upstream; every matching order is handled.
  for (const order of orders) {
    // Record the matched order even when nothing is applied (ignored rows) —
    // the admin ingest log links the invoice/TN straight to the order detail.
    firstOrderId = firstOrderId ?? order.id;
    if (order.status === "cancelled" || order.status === "shipped") {
      sawTerminal = true;
      message = message ?? `order ${order.orderNo} already ${order.status}`;
      continue;
    }
    sawOpen = true;
    const items =
      source === "cancel_invoice"
        ? await queryAll<{ id: string }>(
            tx,
            sql`SELECT id FROM picking_items WHERE picking_order_id = ${order.id} AND status <> 'cancelled'`
          )
        : row.tnLineId === null
          ? []
          : await queryAll<{ id: string }>(
              tx,
              sql`SELECT id FROM picking_items WHERE picking_order_id = ${order.id} AND line_id = ${row.tnLineId} AND status <> 'cancelled'`
            );
    if (items.length === 0) {
      message = message ?? (source === "cancel_invoice" ? `no open items on ${order.orderNo}` : `tn line ${row.tnLineId} not found on ${order.orderNo}`);
      continue;
    }
    const itemIds = items.map((i) => i.id);
    firstItemId = firstItemId ?? itemIds[0] ?? null;
    applied = true;

    await releaseAllocationsForItemsTx(tx, itemIds, null, ledgerReason);

    // Packages of the cancelled items are the put-back material (one task
    // item each), EXCEPT those in a shipped box — that stock is gone; leave
    // its rows and box untouched. Un-boxing mirrors removePackageFromBox and
    // emptied boxes are deleted like cancelShippingBox.
    const pkgs = await queryAll<PutBackPackageRow>(
      tx,
      sql`SELECT pp.id, pp.picking_item_id AS "pickingItemId", pi.part_no AS "partNo", pp.qty,
                 pp.scanned_wcl_item_no AS "wclItemNo",
                 COALESCE(pp.scanned_date_code, pp.date_code) AS "dateCode",
                 COALESCE(pp.scanned_lot_code, pp.lot_code) AS "lotCode",
                 COALESCE(pp.scanned_coo, pp.coo) AS "coo",
                 COALESCE(pp.scanned_cow, pp.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 COALESCE(il.org_id, po.org_id) AS "orgId",
                 COALESCE(il.sub_inventory_code, po.sub_inventory_code) AS "subInventoryCode",
                 pp.shipping_box_id AS "shippingBoxId"
          FROM picking_packages pp
          JOIN picking_items pi ON pi.id = pp.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          LEFT JOIN inventory_lots il ON pp.source_type = 'inventory_lot' AND il.id = pp.source_id
          LEFT JOIN shipping_boxes sb ON sb.id = pp.shipping_box_id
          WHERE ${inArray(sql`pp.picking_item_id`, itemIds)}
            AND (pp.shipping_box_id IS NULL OR sb.shipped_at IS NULL)`
    );

    if (pkgs.length > 0) {
      const taskItemId = source === "cancel_invoice_tn" ? itemIds[0] : "";
      const task = await queryGet<{ id: string }>(
        tx,
        sql`INSERT INTO put_back_tasks (id, cancel_source, cancel_source_id, picking_order_id, picking_item_id, status, created_date, last_update_date)
            VALUES (${newId()}, ${source}, ${row.id}, ${order.id}, ${taskItemId}, 'pending', ${now()}, ${now()})
            ON CONFLICT (cancel_source, cancel_source_id, picking_order_id, picking_item_id)
            DO UPDATE SET last_update_date = ${now()}
            RETURNING id`
      );
      if (task) {
        for (const p of pkgs) {
          await queryRun(
            tx,
            sql`INSERT INTO put_back_task_items (id, put_back_task_id, picking_package_id, part_no, wcl_item_no, qty,
                    date_code, lot_code, coo, cow, shelf_code, org_id, sub_inventory_code, status, created_date, last_update_date)
                VALUES (${newId()}, ${task.id}, ${p.id}, ${p.partNo}, ${p.wclItemNo}, ${p.qty},
                    ${p.dateCode}, ${p.lotCode}, ${p.coo}, ${p.cow}, ${p.shelfCode}, ${p.orgId}, ${p.subInventoryCode},
                    'pending', ${now()}, ${now()})
                ON CONFLICT (picking_package_id) DO NOTHING`
          );
        }
        await emitEvent(tx, {
          type: "put_back_task.created",
          topics: ["/put-back-tasks"],
          data: { taskId: task.id, pickingOrderId: order.id, orderNo: order.orderNo },
        });
      }
      // Un-box the returned packages, then drop boxes left empty.
      const boxIds = [...new Set(pkgs.map((p) => p.shippingBoxId).filter((b): b is string => !!b))];
      await queryRun(tx, sql`UPDATE picking_packages SET shipping_box_id = NULL WHERE ${inArray(sql`id`, pkgs.map((p) => p.id))}`);
      for (const boxId of boxIds) {
        const left = await queryGet<{ c: number }>(
          tx,
          sql`SELECT COUNT(*)::int AS c FROM picking_packages WHERE shipping_box_id = ${boxId}`
        );
        if (!left || left.c === 0) {
          const box = await queryGet<{ status: string; pickingOrderId: string | null }>(
            tx,
            sql`SELECT status, picking_order_id AS "pickingOrderId" FROM shipping_boxes WHERE id = ${boxId}`
          );
          if (box) {
            await logTransition(tx, {
              entityType: "shipping_box",
              entityId: boxId,
              fromState: box.status,
              toState: "cancelled",
              actorId: null,
              metadata: { picking_order: box.pickingOrderId, reason: ledgerReason },
            });
            await queryRun(tx, sql`DELETE FROM shipping_boxes WHERE id = ${boxId}`);
          }
        }
      }
      hadPutback = true;
    }

    await queryRun(
      tx,
      sql`UPDATE picking_items SET status = 'cancelled', last_update_date = ${now()}
          WHERE ${inArray(sql`id`, itemIds)}`
    );

    // Whole order closes when nothing but cancelled items is left.
    const remaining = await queryGet<{ c: number }>(
      tx,
      sql`SELECT COUNT(*)::int AS c FROM picking_items WHERE picking_order_id = ${order.id} AND status <> 'cancelled'`
    );
    if (!remaining || remaining.c === 0) {
      await queryRun(
        tx,
        sql`UPDATE picking_orders SET status = 'cancelled', working_by = NULL, working_at = NULL,
                  labeling_pending = false, label_printing_pending = false, last_update_date = ${now()}
            WHERE id = ${order.id} AND status NOT IN ('cancelled', 'shipped')`
      );
      await logTransition(tx, {
        entityType: "picking_order",
        entityId: order.id,
        fromState: order.status,
        toState: "cancelled",
        actorId: null,
        metadata: { cancel_source: source, key, source_id: row.id },
      });
      await emitEvent(tx, {
        type: "picking_order.updated",
        topics: ["/picking-orders"],
        data: { id: order.id, orderNo: order.orderNo, cancelled: true },
      });
    }
    message = message ?? `${source === "cancel_invoice" ? "order" : "line"} cancelled on ${order.orderNo}`;
  }

  await refreshAllocationStatus(tx);
  if (applied) outcome = hadPutback ? "cancelled_with_putback" : "cancelled";
  else outcome = sawOpen || sawTerminal ? "ignored" : "no_match";
  return { outcome, message, orderId: firstOrderId, itemId: firstItemId };
}

interface PutBackPackageRow {
  id: string;
  pickingItemId: string;
  partNo: string;
  qty: number;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  shippingBoxId: string | null;
}

async function upsertCancelRecord(
  dbOrTx: DbOrTx,
  source: CancelSource,
  row: CancelSourceRow,
  outcome: string,
  message: string | null,
  orderId: string | null,
  itemId: string | null,
  status: "done" | "error"
): Promise<void> {
  await queryRun(
    dbOrTx,
    sql`INSERT INTO cancel_records (id, source, source_id, pi_invoice_num, tn_number, tn_line_id, org_id,
            picking_order_id, picking_item_id, outcome, message, source_ts, status, created_date, last_update_date)
        VALUES (${newId()}, ${source}, ${row.id}, ${row.piInvoiceNum}, ${row.tnNumber}, ${row.tnLineId}, ${row.orgId},
            ${orderId}, ${itemId}, ${outcome}, ${message}, ${row.sourceTs}, ${status}, ${now()}, ${now()})
        ON CONFLICT (source, source_id) DO UPDATE SET
            outcome = ${outcome}, message = ${message},
            picking_order_id = ${orderId}, picking_item_id = ${itemId},
            source_ts = ${row.sourceTs}, status = ${status}, last_update_date = ${now()}`
  );
}

/** Admin list of the ingest log (newest first). Rows that matched nothing
 *  (`no_match`) are deliberately hidden — they are cron audit trail only, the
 *  admin page shows what the cancel-ingest actually had to take care of. */
export async function listCancelRecords(
  db: DbOrTx,
  filter?: { source?: string; outcome?: string }
): Promise<unknown[]> {
  return queryAll(
    db,
    sql`SELECT r.id, r.source, r.source_id AS "sourceId",
               COALESCE(r.pi_invoice_num, r.tn_number) AS "invoiceNum",
               r.tn_line_id::int AS "tnLineId",
               po.order_no AS "orderNo", r.picking_order_id AS "pickingOrderId",
               r.outcome, r.message, r.status,
               r.source_ts AS "sourceTs", r.created_date AS "createdDate", r.last_update_date AS "lastUpdateDate",
               (SELECT COUNT(*)::int FROM put_back_tasks t WHERE t.cancel_source = r.source AND t.cancel_source_id = r.source_id) AS "putBackTasks"
        FROM cancel_records r
        LEFT JOIN picking_orders po ON po.id = r.picking_order_id
        WHERE r.outcome <> 'no_match'
          AND (${filter?.source ?? null}::text IS NULL OR r.source = ${filter?.source ?? null})
          AND (${filter?.outcome ?? null}::text IS NULL OR r.outcome = ${filter?.outcome ?? null})
        ORDER BY r.created_date DESC
        LIMIT 500`
  );
}
