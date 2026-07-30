import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db.js";
import { fetchEventsSince, pruneEvents } from "../db/events.js";

// ---------------------------------------------------------------------------
// GET /events — SSE stream over the app_events outbox (design:
// docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md).
// Cursor = ?since= (falling back to the Last-Event-ID header), default 0.
// On connect the backlog is replayed (capped at 500), then the table is
// polled every 1.5 s; an SSE comment heartbeat every 25 s keeps proxies from
// idling the connection out. Each frame carries `event: <type>`,
// `id: <row id>`, and `data: <JSON of {id,type,topics,data,createdDate}>`.
// Authenticated via the global middleware — the only route where `?token=`
// is accepted (EventSource cannot set an Authorization header).
// ---------------------------------------------------------------------------

const POLL_MS = 1500;
const HEARTBEAT_MS = 25_000;
const BACKLOG_LIMIT = 500;
const POLL_LIMIT = 200;

export const eventsRoute = new Hono();

eventsRoute.get("/events", (c) => {
  const raw = c.req.query("since") ?? c.req.header("last-event-id");
  let cursor = Number(raw ?? 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  // Fire-and-forget housekeeping — must never break the stream.
  void pruneEvents(db).catch((err) => console.error("pruneEvents failed", err));

  return streamSSE(c, async (stream) => {
    let lastHeartbeat = Date.now();
    let limit = BACKLOG_LIMIT; // first pass replays the backlog, then poll in pages
    while (!stream.aborted && !stream.closed) {
      const rows = await fetchEventsSince(db, cursor, limit);
      limit = POLL_LIMIT;
      for (const row of rows) {
        await stream.writeSSE({
          event: row.type,
          data: JSON.stringify({
            id: row.id,
            type: row.type,
            topics: row.topics,
            data: row.data,
            createdDate: row.createdDate,
          }),
          id: String(row.id),
        });
        cursor = row.id;
      }
      const nowMs = Date.now();
      if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
        await stream.write(": ping\n\n");
        lastHeartbeat = nowMs;
      }
      await stream.sleep(POLL_MS);
    }
  });
});
