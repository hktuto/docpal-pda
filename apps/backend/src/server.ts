import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./index.js";
import { db } from "./db.js";
import { pruneEvents } from "./db/events.js";
import { startGoodsVerifyDayEndCron } from "./jobs/goodsVerifyDayEnd.js";
import { docpalBaseUrl } from "./config.js";
import { logDocpalConnectivity } from "./auth/docpal.js";
const port = Number(process.env.PORT ?? 3002);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`backend listening on http://localhost:${info.port}`);
  console.log(`[auth] login mode: ${docpalBaseUrl() ? `DocPal-delegated (${docpalBaseUrl()})` : "local scrypt (DOCPAL_URL not set)"}`);
});

// Probe DocPal reachability once at boot so container → DocPal network
// problems show up in the log before the first login attempt.
void logDocpalConnectivity();

// Housekeeping at boot (pruneEvents also runs fire-and-forget on each new
// SSE connection).
void pruneEvents(db).catch((err) => console.error("pruneEvents at boot failed", err));

// Nightly goods-verify day-end generation at local 00:00 (GOODS_VERIFY_CRON=off
// to disable).
startGoodsVerifyDayEndCron(db);
