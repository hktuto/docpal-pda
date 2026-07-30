import { Hono } from "hono";
import { db } from "../db.js";
import { fetchSyncEventsSince } from "../db/sync-events.js";

// ---------------------------------------------------------------------------
// GET /sync-events?since=<id>&limit=<n> — poll endpoint for the external sync
// service over the sync_events table-change feed (catalog:
// docs/backend/event-catalog.md). Rows are returned oldest-first; the service
// keeps the last seen id as its cursor. Authenticated via the global
// middleware like every other route (the service logs in via /auth/login).
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export const syncEventsRoute = new Hono();

syncEventsRoute.get("/sync-events", async (c) => {
  let since = Number(c.req.query("since") ?? 0);
  if (!Number.isFinite(since) || since < 0) since = 0;
  let limit = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const rows = await fetchSyncEventsSince(db, since, limit);
  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      eventData: r.eventData,
      createdDate: r.createdDate,
    })),
  });
});
