import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./index.js";
import { db } from "./db.js";
import { pruneEvents } from "./db/events.js";

const port = Number(process.env.PORT ?? 3002);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`backend listening on http://localhost:${info.port}`);
});

// Housekeeping at boot (local/pm2 only — this file never runs on Vercel, where
// pruneEvents runs fire-and-forget on each new SSE connection instead).
void pruneEvents(db).catch((err) => console.error("pruneEvents at boot failed", err));
