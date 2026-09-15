import { Hono } from "hono";
import { db } from "../db.js";
import { searchStock, stockSearchOptions } from "../db/stocksearch.js";

export const stockSearchRoute = new Hono();

// One aggregate stock-search read (replaces the old 3-call cascade:
// suppliers → parts → lots). Read-only; all filters optional and ANDed.
// partNo is a single case-insensitive substring; the rest are multi-value
// (repeat the query param, any-of match): supplierCode (lot sources →
// receiving order's supplier), shelfCode, zone, brand, subInventoryCode,
// orgId (integer).
stockSearchRoute.get("/stock-search", async (c) => {
  const orgIds = c.req
    .queries("orgId")
    ?.map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return c.json(
    await searchStock(db, {
      supplierCode: c.req.queries("supplierCode"),
      partNo: c.req.query("partNo"),
      shelfCode: c.req.queries("shelfCode"),
      zone: c.req.queries("zone"),
      brand: c.req.queries("brand"),
      orgId: orgIds?.length ? orgIds : undefined,
      subInventoryCode: c.req.queries("subInventoryCode"),
    }),
    200
  );
});

// Distinct filter values present in the current stock (brands, zones,
// shelves, org/sub-inventory locations) for searchable filter dropdowns.
stockSearchRoute.get("/stock-search/options", async (c) => {
  return c.json(await stockSearchOptions(db), 200);
});
