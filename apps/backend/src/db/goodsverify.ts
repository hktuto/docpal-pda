import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { isStepEnabled } from "../config.js";


// ---------------------------------------------------------------------------
// Goods verify flow (concept 7, redesigned 2026-10-17 — shelf summary).
//
// Day-end generation: one goods_verify_tasks row per SHELF with net on-hand
// movement in inventory_transactions that day. The `movements` jsonb carries
// the per-part summary: [{ partNo, wclItemNo, description, qtyChange,
// currentTotal }]. Only parts with a non-zero net delta are included.
// The (task_date, shelf_code) unique index makes re-runs idempotent
// (ON CONFLICT DO NOTHING).
//
// Verify: pending task → 'verified' (+ transition log). Pure confirmation —
// no countedQty, no adjustment. If the user finds a discrepancy they fix it
// elsewhere (adjust stock, re-scan, etc.).
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
    id: newId(),
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
// Generation
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MovementItem {
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  qtyChange: number;
  currentTotal: number;
}

/**
 * Day-end generation (redesigned): one pending task per shelf with net
 * on-hand movement in inventory_transactions on `date`. The per-part summary
 * is stored in the `movements` jsonb column. Shelves with no net on-hand
 * change produce no task. Idempotent via the (task_date, shelf_code) unique
 * index. When the goods-verify flow step is disabled (FLOW_STEPS_DISABLED)
 * this is a no-op.
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

  // Aggregate net on-hand delta per shelf + part for the day
  const movements = await queryAll<{
    shelfCode: string;
    partNo: string;
    wclItemNo: string | null;
    description: string | null;
    qtyChange: number;
  }>(
    db,
    sql`
      SELECT
        it.shelf_code AS "shelfCode",
        it.part_no AS "partNo",
        p.wcl_item_no AS "wclItemNo",
        p.description,
        SUM(it.qty_delta)::int AS "qtyChange"
      FROM inventory_transactions it
      JOIN parts p ON p.part_no = it.part_no
      WHERE it.txn_at::date = ${date}::date
        AND it.shelf_code IS NOT NULL
        AND it.qty_type = 'on_hand'
      GROUP BY it.shelf_code, it.part_no, p.wcl_item_no, p.description
      HAVING SUM(it.qty_delta) != 0
      ORDER BY it.shelf_code, it.part_no
    `
  );

  if (movements.length === 0) return { created: 0, date };

  // Group by shelf
  const byShelf = new Map<string, typeof movements>();
  for (const m of movements) {
    const list = byShelf.get(m.shelfCode) ?? [];
    list.push(m);
    byShelf.set(m.shelfCode, list);
  }

  // For each shelf, compute currentTotal per part and build the movements JSONB
  let created = 0;
  for (const [shelfCode, parts] of byShelf) {
    const items: MovementItem[] = [];
    for (const p of parts) {
      const lot = await queryGet<{ total: number }>(
        db,
        sql`SELECT SUM(total_qty)::int AS total FROM inventory_lots
            WHERE shelf_code = ${shelfCode} AND part_no = ${p.partNo}`
      );
      items.push({
        partNo: p.partNo,
        wclItemNo: p.wclItemNo,
        description: p.description,
        qtyChange: p.qtyChange,
        currentTotal: lot?.total ?? 0,
      });
    }

    const res = await queryRun(
      db,
      sql`
        INSERT INTO goods_verify_tasks
          (id, task_date, shelf_code, movements, status, created_date)
        VALUES
          (app_uuid_v7(), ${date}::date, ${shelfCode}, ${JSON.stringify(items)}::jsonb, 'pending', ${at})
        ON CONFLICT (task_date, shelf_code) DO NOTHING
      `
    );
    created += res.changes;
  }

  if (created > 0) {
    await emitEvent(db, {
      type: "goods_verify.tasks_created",
      topics: ["/goods-verify-tasks"],
      data: { date, count: created },
    });
  }
  return { created, date };
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface GoodsVerifyTaskQueueRow {
  id: string;
  taskDate: string; // task_date cast to text (YYYY-MM-DD)
  shelfCode: string;
  status: string;
  movements: MovementItem[];
  movementsCount: number;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

export interface GoodsVerifyTaskFilters {
  id?: string;
  date?: string;
  status?: string;
  shelfCode?: string;
}

/** The work queue: shelf-level tasks with their movement summaries. */
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
        gvt.shelf_code AS "shelfCode", gvt.status,
        COALESCE(gvt.movements, '[]'::jsonb) AS "movements",
        COALESCE(jsonb_array_length(gvt.movements), 0) AS "movementsCount",
        gvt.verified_by AS "verifiedBy", gvt.verified_at AS "verifiedAt"
      FROM goods_verify_tasks gvt
      ${where}
      ORDER BY gvt.shelf_code
    `
  );
}

/** One queue row by id (the verify response shape). */
export async function getGoodsVerifyTaskRow(db: AppDb, taskId: string): Promise<GoodsVerifyTaskQueueRow> {
  const row = (await listGoodsVerifyTasks(db, { id: taskId }))[0];
  if (!row) throw new HTTPException(404, { message: "goods_verify_task_not_found" });
  return row;
}

export interface GoodsVerifyTaskDetail {
  task: GoodsVerifyTaskQueueRow & {
    createdDate: Date;
  };
}

/** Task with its full movement summary. */
export async function getGoodsVerifyTaskDetail(db: AppDb, taskId: string): Promise<GoodsVerifyTaskDetail> {
  const task = await queryGet<GoodsVerifyTaskQueueRow & { createdDate: Date }>(
    db,
    sql`
      SELECT
        gvt.id, gvt.task_date::text AS "taskDate",
        gvt.shelf_code AS "shelfCode", gvt.status,
        COALESCE(gvt.movements, '[]'::jsonb) AS "movements",
        COALESCE(jsonb_array_length(gvt.movements), 0) AS "movementsCount",
        gvt.verified_by AS "verifiedBy", gvt.verified_at AS "verifiedAt",
        gvt.created_date AS "createdDate"
      FROM goods_verify_tasks gvt
      WHERE gvt.id = ${taskId}
    `
  );
  if (!task) throw new HTTPException(404, { message: "goods_verify_task_not_found" });
  return { task };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface VerifyGoodsVerifyTaskInput {
  taskId: string;
  actorId: string;
}

/**
 * Verify one pending task — pure confirmation. No countedQty, no adjustment.
 * Just marks the task as verified with a transition log entry.
 */
export async function verifyGoodsVerifyTask(
  db: AppDb,
  input: VerifyGoodsVerifyTaskInput
): Promise<{ adjusted: boolean }> {
  return db.transaction(async (tx) => {
    const task = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM goods_verify_tasks WHERE id = ${input.taskId}`
    );
    if (!task) throw new HTTPException(404, { message: "goods_verify_task_not_found" });
    await assertActor(tx, input.actorId);
    if (task.status !== "pending") throw new HTTPException(409, { message: "goods_verify_task_not_pending" });

    const at = now();
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
    });

    return { adjusted: false };
  });
}
