import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { receivingRoute } from "./routes/receiving.js";
import { pickingRoute } from "./routes/picking.js";
import { pickingExecutionRoute } from "./routes/pickingExecution.js";
import { measuringRoute } from "./routes/measuring.js";

export const app = new Hono();

const origins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost,capacitor://localhost"
).split(",");

app.use("*", cors({ origin: origins }));
app.route("/", healthRoute);
app.route("/", receivingRoute);
app.route("/", pickingRoute);
app.route("/", pickingExecutionRoute);
app.route("/", measuringRoute);
