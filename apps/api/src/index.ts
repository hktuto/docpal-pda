import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { receivingRoute } from "./routes/receiving.js";

export const app = new Hono();

const origins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:3000,http://localhost,capacitor://localhost"
).split(",");

app.use("*", cors({ origin: origins }));
app.route("/", healthRoute);
app.route("/", receivingRoute);
