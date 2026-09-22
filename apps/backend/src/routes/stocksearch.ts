import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.js";
import { searchStock, stockSearchOptions, stockSearchSummary, type StockSearchFilters } from "../db/stocksearch.js";

export const stockSearchRoute = new Hono();

// Shared filter parsing: partNo is a single case-insensitive substring; the
// rest are multi-value (repeat the query param, any-of match): supplierCode
// (lot sources → receiving order's supplier), shelfCode, zone, brand,
// subInventoryCode, orgId (integer). dateCodeFrom/dateCodeTo are single WWYY
// range bounds.
function stockSearchFilters(c: Context): StockSearchFilters {
  const orgIds = c.req
    .queries("orgId")
    ?.map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return {
    supplierCode: c.req.queries("supplierCode"),
    partNo: c.req.query("partNo"),
    shelfCode: c.req.queries("shelfCode"),
    zone: c.req.queries("zone"),
    brand: c.req.queries("brand"),
    orgId: orgIds?.length ? orgIds : undefined,
    subInventoryCode: c.req.queries("subInventoryCode"),
    dateCodeFrom: c.req.query("dateCodeFrom"),
    dateCodeTo: c.req.query("dateCodeTo"),
  };
}

// One aggregate stock-search read (replaces the old 3-call cascade:
// suppliers → parts → lots). Read-only; all filters optional and ANDed.
stockSearchRoute.get("/stock-search", async (c) => {
  return c.json(await searchStock(db, stockSearchFilters(c)), 200);
});

// Distinct filter values present in the current stock (brands, zones,
// shelves, org/sub-inventory locations) for searchable filter dropdowns.
stockSearchRoute.get("/stock-search/options", async (c) => {
  return c.json(await stockSearchOptions(db), 200);
});

// Stock totals for the admin summary header — follows the same filters as
// /stock-search (no params = overall totals).
stockSearchRoute.get("/stock-search/summary", async (c) => {
  return c.json(await stockSearchSummary(db, stockSearchFilters(c)), 200);
});
