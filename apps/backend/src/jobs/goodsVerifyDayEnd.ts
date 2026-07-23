import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryGet } from "../db/query.js";
import { generateGoodsVerifyTasks } from "../db/goodsverify.js";

// ---------------------------------------------------------------------------
// Nightly goods-verify generation (design:
// docs/superpowers/specs/2026-07-23-goods-verify-nightly-cron-design.md).
// Runs generateGoodsVerifyTasks for DB CURRENT_DATE-1 and CURRENT_DATE at
// local 00:00 — movements are bucketed by the DB server's date while the fire
// time is local midnight, so the just-ended business day can span two DB
// dates; both generations are idempotent via the (task_date,
// inventory_lot_id) unique index. Disable with GOODS_VERIFY_CRON=off.
// ---------------------------------------------------------------------------

/** Generate day-end tasks for the day that just ended (idempotent). */
export async function runGoodsVerifyDayEnd(db: AppDb): Promise<{ created: number; dates: string[] }> {
  const row = await queryGet<{ today: string; yesterday: string }>(
    db,
    sql`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday`
  );
  const dates = [row!.yesterday, row!.today];
  let created = 0;
  for (const date of dates) {
    created += (await generateGoodsVerifyTasks(db, { date })).created;
  }
  return { created, dates };
}

/** Fire at every local 00:00 (+ once at boot as catch-up). Log-only failures. */
export function startGoodsVerifyDayEndCron(db: AppDb): void {
  if (process.env.GOODS_VERIFY_CRON === "off") return;

  async function run(): Promise<void> {
    try {
      const res = await runGoodsVerifyDayEnd(db);
      console.log(`goods-verify day-end: created ${res.created} task(s) for ${res.dates.join(", ")}`);
    } catch (err) {
      console.error("goods-verify day-end run failed", err);
    }
  }

  function schedule(): void {
    const next = new Date();
    next.setHours(24, 0, 0, 0); // next local midnight
    const timer = setTimeout(() => void run().finally(schedule), next.getTime() - Date.now());
    timer.unref();
  }

  schedule();
  void run(); // boot catch-up: safe (idempotent) if the server was off at 00:00
}
