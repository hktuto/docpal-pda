import { handle } from "hono/vercel";
import { app } from "../src/index.js";

// Vercel serverless entry (all paths rewritten here via vercel.json).
// The long-running node server (src/server.ts) remains the local/PM2 entry.
export default handle(app);
