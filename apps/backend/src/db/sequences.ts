import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { seqCounters } from "./schema/index.js";
import { now } from "./now.js";

// Keyed sequence counters (plan docs/superpowers/plans/2026-11-12-seq-counters.md):
// atomic gap-free integer blocks for label serials. Reset is lazy — evaluated
// on each nextSeqValues call against last_reset_on, no cron. The counter knows
// nothing about label formatting (zero-padding stays with the consumer) and
// never wraps.

export type ResetSchedule = "never" | "weekly" | "monthly" | "days";

export const MAX_SEQ_BLOCK = 10_000;

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Current period start ("YYYY-MM-DD") for a reset schedule, in server-local
 * time. `anchor` is the counter's last_reset_on (only the 'days' schedule
 * needs it). Returns null for 'never' / misconfigured rows.
 * - weekly: interval 1–7 = weekday (1=Mon … 7=Sun); most recent occurrence
 *   of that weekday, today included.
 * - monthly: interval 1–28 = day of month (capped at 28 so February can't
 *   skip a reset); this month's occurrence, or last month's when it hasn't
 *   arrived yet.
 * - days: interval N≥1; anchor + k·N for the largest k with the result ≤
 *   today (null without an anchor — the first call stamps one).
 */
export function periodStartFor(
  schedule: string,
  interval: number | null,
  today: Date,
  anchor: string | null
): string | null {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (schedule === "weekly" && interval !== null && interval >= 1 && interval <= 7) {
    const target = interval % 7; // JS getDay: 0=Sun … 6=Sat
    const diff = (day.getDay() - target + 7) % 7;
    return fmt(new Date(day.getFullYear(), day.getMonth(), day.getDate() - diff));
  }
  if (schedule === "monthly" && interval !== null && interval >= 1 && interval <= 28) {
    const thisMonth = new Date(day.getFullYear(), day.getMonth(), interval);
    if (thisMonth <= day) return fmt(thisMonth);
    return fmt(new Date(day.getFullYear(), day.getMonth() - 1, interval));
  }
  if (schedule === "days" && interval !== null && interval >= 1 && anchor !== null) {
    const [y, m, d] = anchor.split("-").map(Number);
    const anchorDay = new Date(y, m - 1, d);
    const elapsed = Math.round((day.getTime() - anchorDay.getTime()) / 86_400_000);
    if (elapsed < 0) return null;
    const k = Math.floor(elapsed / interval);
    return fmt(new Date(y, m - 1, d + k * interval));
  }
  return null;
}

/**
 * Issue the next `count` values for `key` as one contiguous block. Single
 * tx: SELECT … FOR UPDATE on the counter row, lazy reset when the current
 * period start is newer than last_reset_on (first-ever call just stamps the
 * anchor, value untouched), then value += count. Returns the raw block —
 * `{start, count}` means serials start … start+count−1.
 * 400 invalid_payload (bad key / count outside 1..MAX_SEQ_BLOCK),
 * 404 unknown_seq_key (rows are seeded, never auto-created).
 */
export async function nextSeqValues(
  db: AppDb,
  key: unknown,
  count: unknown
): Promise<{ key: string; start: number; count: number }> {
  if (typeof key !== "string" || key.trim() === "") {
    throw new HTTPException(400, { message: "invalid_payload: key must be a non-empty string" });
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_SEQ_BLOCK) {
    throw new HTTPException(400, { message: `invalid_payload: count must be an integer 1..${MAX_SEQ_BLOCK}` });
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(seqCounters)
      .where(eq(seqCounters.key, key))
      .for("update");
    if (!row) throw new HTTPException(404, { message: "unknown_seq_key" });

    let value = row.value;
    let lastResetOn = row.lastResetOn;
    const periodStart = periodStartFor(row.resetSchedule, row.resetInterval, now(), lastResetOn);
    if (periodStart !== null) {
      if (lastResetOn === null) {
        lastResetOn = periodStart; // first use: stamp the anchor, keep the value
      } else if (periodStart > lastResetOn) {
        value = 0;
        lastResetOn = periodStart;
      }
    }

    const start = value + 1;
    await tx
      .update(seqCounters)
      .set({ value: value + count, lastResetOn, lastUpdateDate: now() })
      .where(eq(seqCounters.id, row.id));
    return { key, start, count };
  });
}
