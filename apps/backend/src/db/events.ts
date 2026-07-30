import { gt, lt, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import type { DbOrTx } from "./query.js";
import { appEvents } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Transactional outbox for SSE (GET /events; design:
// docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md).
// Mutations insert a row via emitEvent inside the same transaction as the
// domain change (same pattern as transaction_logs), so a rollback drops the
// event with it. The SSE route polls fetchEventsSince and streams new rows;
// pruneEvents keeps the table small (server boot + fire-and-forget on each
// new SSE connection).
// ---------------------------------------------------------------------------

export type AppEventRow = typeof appEvents.$inferSelect;

/** Insert one event row; call inside the domain transaction so rollbacks drop it. */
export async function emitEvent(
  dbOrTx: DbOrTx,
  e: { type: string; topics: string[]; data?: Record<string, unknown> }
): Promise<void> {
  await dbOrTx.insert(appEvents).values({
    type: e.type,
    topics: e.topics,
    data: e.data ?? {},
    createdDate: now(),
  });
}

/** Rows after `since`, oldest first — the SSE poller query. */
export async function fetchEventsSince(db: AppDb, since: number, limit = 200): Promise<AppEventRow[]> {
  return db.select().from(appEvents).where(gt(appEvents.id, since)).orderBy(appEvents.id).limit(limit);
}

/** Drop rows older than 3 days (events are best-effort notifications, not a command log). */
export async function pruneEvents(db: AppDb): Promise<void> {
  await db.delete(appEvents).where(lt(appEvents.createdDate, sql`now() - interval '3 days'`));
}
