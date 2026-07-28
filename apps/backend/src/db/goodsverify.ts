import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { isStepEnabled } from "../config.js";

// ---------------------------------------------------------------------------
// Goods verify flow (concept 7 — daily cycle count).
//
// Day-end generation: one goods_verify_tasks row per inventory lot with
// movement in inventory_transactions on that day (distinct inventory_lot_id,
// txn_at::date = day). expected_qty snapshots the lot's total_qty at
// generation time; shelf/box/part are copied from the lot. The
// (task_date, inventory_lot_id) unique index makes re-runs idempotent
// (ON CONFLICT DO NOTHING).
//
// Verify: pending task → 'verified' (+ transition log). When countedQty is
// given and differs from expected_qty, the lot's total_qty is corrected and
// an ADJUST (on_hand) ledger row records the delta — the caller then runs
// allocateAll after commit, best-effort. When the task carries a box_id that
// resolves to a shelf_boxes row, that box's items are marked verified and the
// box transitions 'closed' → 'verified' (mirroring the Android
// mark-box-verified flow); an 'open' box means put-away may still be in
// progress, so verifying is rejected (409 shelf_box_not_closed) — a later
// stock change would reset the flags anyway (markBoxStockChanged).
//
// Date handling: txn_at is `timestamp without time zone` holding UTC
// wall-clock and the DB session runs in UTC, so "today" is the database
// server's CURRENT_DATE (DB-consistent); an explicit `date` ('YYYY-MM-DD')
// always wins.
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
// Generation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Day-end generation (concept 7): one pending task per lot moved in
 * inventory_transactions on `date` (default: the database server's
 * CURRENT_DATE — see header). Lots already tasked that day are skipped by the
 * unique index, so `created` counts only newly inserted rows; the INNER JOIN
 * skips ledger rows whose lot no longer exists. `actorId` is accepted for the
 * system-job caller but not required (nothing actor-stamped is written).
 * When the goods-verify flow step is disabled (FLOW_STEPS_DISABLED) this is a
 * no-op — it gates both POST /goods-verify-tasks/generate and the nightly job.
 */
export async function generateGoodsVerifyTasks(
  db: AppDb,
  input: { date?: string; actorId?: string }
): Promise<{ created: number; date: string }> {
  if (input.date !== undefined && !DATE_RE.test(input.date)) {
    throw new HTTPException(400, { message: "invalid_date" });
  }
  const date =
    input.date ?? (await queryGet<{ d: string }>(db, sql`SELECT CURRENT_DATE::text AS d`))!.d;
  if (!isStepEnabled("goods-verify")) return { created: 0, date };
  const at = now();
  const res = await queryRun(
    db,
    sql`
      INSERT INTO goods_verify_tasks
        (id, task_date, inventory_lot_id, shelf_code, box_id, part_no, expected_qty, status, created_at)
      SELECT gen_random_uuid()::text, ${date}::date, il.id, il.shelf_code, il.box_id, il.part_no,
             il.total_qty, 'pending', ${at}
      FROM (
        SELECT DISTINCT inventory_lot_id
        FROM inventory_transactions
        WHERE inventory_lot_id IS NOT NULL AND txn_at::date = ${date}::date
      ) moved
      JOIN inventory_lots il ON il.id = moved.inventory_lot_id
      ON CONFLICT (task_date, inventory_lot_id) DO NOTHING
    `
  );
  // Single statement (no tx) — emit right after the insert; re-runs absorbed
  // by the unique index create nothing and stay silent.
  if (res.changes > 0) {
    await emitEvent(db, {
      type: "goods_verify.tasks_created",
      topics: ["/goods-verify-tasks"],
      data: { date, count: res.changes },
    });
  }
  return { created: res.changes, date };
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface GoodsVerifyTaskQueueRow {
  id: string;
  taskDate: string; // task_date cast to text (YYYY-MM-DD)
  shelfCode: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  expectedQty: number;
  status: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

export interface GoodsVerifyTaskFilters {
  id?: string;
  date?: string;
  status?: string;
  shelfCode?: string;
}

/** The work queue: tasks joined to parts for part identity; filters pass through. */
export async function listGoodsVerifyTasks(
  db: AppDb,
  filters: GoodsVerifyTaskFilters = {}
): Promise<GoodsVerifyTaskQueueRow[]> {
  const conditions: ReturnType<typeof sql>[] = [];
  if (filters.id) conditions.push(sql`gvt.id = ${filters.id}`);
  if (filters.date) conditions.push(sql`gvt.task_date = ${filters.date}::date`);
  if (filters.status) conditions.push(sql`gvt.status = ${filters.status}`);
  if (filters.shelfCode) conditions.push(sql`gvt.shelf_code = ${filters.shelfCode}`);
  let where = sql``;
  conditions.forEach((cond, i) => {
    where = sql`${where}${i === 0 ? sql`WHERE ` : sql` AND `}${cond}`;
  });
  return queryAll<GoodsVerifyTaskQueueRow>(
    db,
    sql`
      SELECT
        gvt.id, gvt.task_date::text AS "taskDate",
        gvt.shelf_code AS "shelfCode", gvt.box_id AS "boxId",
        gvt.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
        gvt.expected_qty AS "expectedQty", gvt.status,
        gvt.verified_by AS "verifiedBy", gvt.verified_at AS "verifiedAt"
      FROM goods_verify_tasks gvt
      JOIN parts p ON p.part_no = gvt.part_no
      ${where}
      ORDER BY gvt.shelf_code, gvt.box_id, p.part_no
    `
  );
}

/** One queue row by id (the verify response shape). */
export async function getGoodsVerifyTaskRow(db: AppDb, taskId: string): Promise<GoodsVerifyTaskQueueRow> {
  const row = (await listGoodsVerifyTasks(db, { id: taskId }))[0];
  if (!row) throw new HTTPException(404, { message: "goods_verify_task_not_found" });
  return row;
}

export interface GoodsVerifyTaskDetailRow extends GoodsVerifyTaskQueueRow {
  inventoryLotId: string;
  description: string | null;
  createdAt: Date;
}

export interface GoodsVerifyLotRow {
  id: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  /** Stamped from the shelf at put-away (the lot's location pair). */
  orgId: number | null;
  subInventoryCode: string | null;
}

export interface GoodsVerifyBoxItemRow {
  id: string;
  partNo: string;
  qty: number;
  verified: boolean | null;
  verifiedAt: Date | null;
}

export interface GoodsVerifyTaskDetail {
  task: GoodsVerifyTaskDetailRow;
  lot: GoodsVerifyLotRow;
  box: { id: string; status: string; items: GoodsVerifyBoxItemRow[] } | null;
}

/**
 * Task + the lot it counts + the shelf box with its items. `box` is null when
 * the task has no box_id or the id does not resolve to a shelf_boxes row
 * (e.g. legacy box ids on seeded lots).
 */
export async function getGoodsVerifyTaskDetail(db: AppDb, taskId: string): Promise<GoodsVerifyTaskDetail> {
  const task = await queryGet<GoodsVerifyTaskDetailRow>(
    db,
    sql`
      SELECT
        gvt.id, gvt.task_date::text AS "taskDate", gvt.inventory_lot_id AS "inventoryLotId",
        gvt.shelf_code AS "shelfCode", gvt.box_id AS "boxId",
        gvt.part_no AS "partNo", p.wcl_item_no AS "wclItemNo",
        p.description,
        gvt.expected_qty AS "expectedQty", gvt.status,
        gvt.verified_by AS "verifiedBy", gvt.verified_at AS "verifiedAt",
        gvt.created_at AS "createdAt"
      FROM goods_verify_tasks gvt
      JOIN parts p ON p.part_no = gvt.part_no
      WHERE gvt.id = ${taskId}
    `
  );
  if (!task) throw new HTTPException(404, { message: "goods_verify_task_not_found" });

  const lot = (await queryGet<GoodsVerifyLotRow>(
    db,
    sql`
      SELECT
        il.id, il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
        il.shelf_code AS "shelfCode", il.box_id AS "boxId",
        il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty", il.available_qty AS "availableQty",
        il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode"
      FROM inventory_lots il
      WHERE il.id = ${task.inventoryLotId}
    `
  ))!; // FK guarantees the lot exists

  let box: GoodsVerifyTaskDetail["box"] = null;
  if (task.boxId) {
    const boxRow = await queryGet<{ id: string; status: string }>(
      db,
      sql`SELECT id, status FROM shelf_boxes WHERE id = ${task.boxId}`
    );
    if (boxRow) {
      const items = await queryAll<GoodsVerifyBoxItemRow>(
        db,
        sql`
          SELECT
            sbi.id, sbi.part_no AS "partNo", sbi.qty,
            sbi.verified, sbi.verified_at AS "verifiedAt"
          FROM shelf_box_items sbi
          WHERE sbi.shelf_box_id = ${boxRow.id}
          ORDER BY sbi.part_no, sbi.id
        `
      );
      box = { id: boxRow.id, status: boxRow.status, items };
    }
  }

  return { task, lot, box };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface VerifyGoodsVerifyTaskInput {
  taskId: string;
  actorId: string;
  countedQty?: number;
}

/**
 * Verify one pending task. countedQty (when provided) is the physical count:
 * a difference from expected_qty corrects the lot's total_qty (guarded
 * against allocated_qty so the generated available_qty never goes negative)
 * and writes an ADJUST on_hand ledger row referencing the task; the caller
 * runs allocateAll after commit when `adjusted` is true. Box handling per the
 * header: 'closed' → items verified + box 'verified' (+ transition log);
 * 'open' → 409; 'verified' (another task for the same box got there first) or
 * an unresolvable box_id → nothing to do.
 */
export async function verifyGoodsVerifyTask(
  db: AppDb,
  input: VerifyGoodsVerifyTaskInput
): Promise<{ adjusted: boolean }> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; boxId: string | null; inventoryLotId: string; expectedQty: number; status: string }>(
      tx,
      sql`SELECT id, box_id AS "boxId", inventory_lot_id AS "inventoryLotId",
                 expected_qty AS "expectedQty", status
          FROM goods_verify_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "goods_verify_task_not_found" });
    await assertActor(tx, input.actorId);
    if (task.status !== "pending") throw new HTTPException(409, { message: "goods_verify_task_not_pending" });
    if (input.countedQty !== undefined && (!Number.isInteger(input.countedQty) || input.countedQty < 0)) {
      throw new HTTPException(400, { message: "counted_qty_must_be_non_negative_integer" });
    }

    const at = now();
    let adjusted = false;

    if (input.countedQty !== undefined && input.countedQty !== task.expectedQty) {
      const lot = await queryGet<{
        id: string;
        partNo: string;
        shelfCode: string | null;
        boxId: string | null;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
        allocatedQty: number;
      }>(
        tx,
        sql`SELECT id, part_no AS "partNo", shelf_code AS "shelfCode", box_id AS "boxId",
                   date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
                   allocated_qty AS "allocatedQty"
            FROM inventory_lots WHERE id = ${task.inventoryLotId}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      if (input.countedQty < lot.allocatedQty) {
        throw new HTTPException(409, { message: "counted_qty_below_allocated" });
      }
      await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = ${input.countedQty} WHERE id = ${lot.id}`);
      await tx.insert(inventoryTransactions).values({
        id: randomUUID(),
        inventoryLotId: lot.id,
        partNo: lot.partNo,
        shelfCode: lot.shelfCode,
        boxId: lot.boxId,
        txnType: "ADJUST",
        qtyType: "on_hand",
        qtyDelta: input.countedQty - task.expectedQty,
        dateCode: lot.dateCode,
        lotCode: lot.lotCode,
        coo: lot.coo,
        cow: lot.cow,
        referenceType: "goods_verify_task",
        referenceId: task.id,
        actorId: input.actorId,
        txnReason: "cycle count adjustment",
        txnAt: at,
      });
      adjusted = true;
    }

    if (task.boxId) {
      const box = await queryGet<{ id: string; status: string }>(
        tx,
        sql`SELECT id, status FROM shelf_boxes WHERE id = ${task.boxId}`
      );
      if (box) {
        if (box.status === "open") throw new HTTPException(409, { message: "shelf_box_not_closed" });
        if (box.status === "closed") {
          await queryRun(
            tx,
            sql`UPDATE shelf_box_items SET verified = true, verified_at = ${at} WHERE shelf_box_id = ${box.id}`
          );
          await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'verified' WHERE id = ${box.id}`);
          await logTransition(tx, {
            entityType: "shelf_box",
            entityId: box.id,
            fromState: "closed",
            toState: "verified",
            actorId: input.actorId,
          });
        }
      }
    }

    await queryRun(
      tx,
      sql`UPDATE goods_verify_tasks
          SET status = 'verified', verified_by = ${input.actorId}, verified_at = ${at}
          WHERE id = ${task.id}`
    );
    await logTransition(tx, {
      entityType: "goods_verify_task",
      entityId: task.id,
      fromState: "pending",
      toState: "verified",
      actorId: input.actorId,
      metadata: input.countedQty !== undefined ? { countedQty: input.countedQty } : {},
    });

    return { adjusted };
  });
}
