import { gt } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { syncEvents } from "./schema/index.js";

// ---------------------------------------------------------------------------
// Read side of the sync_events table-change feed (writes come from the
// sync_events_notify() trigger, not application code). Catalog:
// docs/backend/event-catalog.md.
// ---------------------------------------------------------------------------

export type SyncEventRow = typeof syncEvents.$inferSelect;

/** Rows after `since`, oldest first — the sync service's poll query. */
export async function fetchSyncEventsSince(db: AppDb, since: number, limit = 200): Promise<SyncEventRow[]> {
  return db.select().from(syncEvents).where(gt(syncEvents.id, since)).orderBy(syncEvents.id).limit(limit);
}
