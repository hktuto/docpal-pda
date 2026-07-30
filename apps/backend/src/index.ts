import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware, type AuthVariables } from "./auth/middleware.js";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { adminRoute } from "./routes/admin/index.js";
import { receivingRoute } from "./routes/receiving.js";
import { putawayRoute } from "./routes/putaway.js";
import { pickingRoute } from "./routes/picking.js";
import { measuringRoute } from "./routes/measuring.js";
import { verifyRoute } from "./routes/verify.js";
import { shippingRoute } from "./routes/shipping.js";
import { configRoute } from "./routes/config.js";
import { goodsVerifyRoute } from "./routes/goodsverify.js";
import { stockSearchRoute } from "./routes/stocksearch.js";
import { boxesRoute } from "./routes/boxes.js";
import { scanTemplatesRoute } from "./routes/scantemplates.js";
import { ingestRoute } from "./routes/ingest.js";
import { eventsRoute } from "./routes/events.js";
import { syncEventsRoute } from "./routes/sync-events.js";
import { devRoute } from "./routes/dev.js";

export const app = new Hono<{ Variables: AuthVariables }>();

const origins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost:3100,http://localhost,http://127.0.0.1:3000,http://127.0.0.1,capacitor://localhost"
).split(",");

app.use("*", cors({ origin: origins, allowHeaders: ["Content-Type", "Last-Event-ID", "Authorization"] }));
// Everything below requires a bearer token except /health, POST /auth/login
// and /dev/* (allowlist inside the middleware; GET /events also accepts
// ?token= for EventSource clients).
app.use("*", authMiddleware);
app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/admin", adminRoute);
app.route("/", receivingRoute);
app.route("/", putawayRoute);
app.route("/", pickingRoute);
app.route("/", measuringRoute);
app.route("/", verifyRoute);
app.route("/", shippingRoute);
app.route("/", configRoute);
app.route("/", goodsVerifyRoute);
app.route("/", stockSearchRoute);
app.route("/", boxesRoute);
app.route("/", scanTemplatesRoute);
app.route("/", ingestRoute);
app.route("/", eventsRoute);
app.route("/", syncEventsRoute);
// Demo-only routes (/dev/reset, /dev/allocate); disable with DEV_ROUTES=off.
if (process.env.DEV_ROUTES !== "off") {
  app.route("/", devRoute);
}
