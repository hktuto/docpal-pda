import { Hono } from "hono";
import { db } from "../db.js";
import { searchStock } from "../db/stocksearch.js";

export const stockSearchRoute = new Hono();

// One aggregate stock-search read (replaces the old 3-call cascade:
// suppliers → parts → lots). Read-only; all filters optional and ANDed
// (partNo case-insensitive substring, shelfCode exact, supplierId via lot
// sources → receiving order's supplier).
stockSearchRoute.get("/stock-search", async (c) => {
  return c.json(
    await searchStock(db, {
      supplierId: c.req.query("supplierId"),
      partNo: c.req.query("partNo"),
      shelfCode: c.req.query("shelfCode"),
    }),
    200
  );
});
