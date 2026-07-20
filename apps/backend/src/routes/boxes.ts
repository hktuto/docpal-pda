import { Hono } from "hono";
import { db } from "../db.js";
import { searchBoxes } from "../db/boxes.js";

export const boxesRoute = new Hono();

// Cross-flow box lookup (shipping + shelf boxes) by id substring — backs the
// web /box QR page. Read-only; blank q returns the latest 50 boxes.
boxesRoute.get("/boxes", async (c) => {
  return c.json(await searchBoxes(db, c.req.query("q") ?? ""), 200);
});
