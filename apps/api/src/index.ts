import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { receivingRoute } from "./routes/receiving.js";
import { pickingRoute } from "./routes/picking.js";
import { pickingExecutionRoute } from "./routes/pickingExecution.js";
import { measuringRoute } from "./routes/measuring.js";
import { boxesRoute } from "./routes/boxes.js";
import { verificationRoute } from "./routes/verification.js";
import { putAwayRoute } from "./routes/putAway.js";
import { goodsVerifyRoute } from "./routes/goodsVerify.js";
import { mismatchRoute } from "./routes/mismatch.js";
import { devRoute } from "./routes/dev.js";

export const app = new Hono();

const origins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost,capacitor://localhost"
).split(",");

app.use("*", cors({ origin: origins }));
app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/", receivingRoute);
app.route("/", pickingRoute);
app.route("/", pickingExecutionRoute);
app.route("/", measuringRoute);
app.route("/", boxesRoute);
app.route("/", verificationRoute);
app.route("/", putAwayRoute);
app.route("/", goodsVerifyRoute);
app.route("/", mismatchRoute);
app.route("/", devRoute);
