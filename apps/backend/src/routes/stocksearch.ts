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
    drawingNo: c.req.query("drawingNo"),
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
// Opt-in paging: ?page= (1-based, with optional pageSize/sort/dir) switches
// the response to { rows, total }; without `page` the legacy full
// { parts, lots } response is returned (the PDA consumes that shape).
stockSearchRoute.get("/stock-search", async (c) => {
  const pageParam = c.req.query("page");
  if (pageParam === undefined) return c.json(await searchStock(db, stockSearchFilters(c)), 200);
  const rawDir = c.req.query("dir");
  const dir = rawDir === "asc" || rawDir === "desc" ? rawDir : undefined;
  return c.json(
    await searchStock(db, stockSearchFilters(c), {
      page: Math.max(1, Number(pageParam) || 1),
      pageSize: Math.min(200, Math.max(1, Number(c.req.query("pageSize")) || 50)),
      sort: c.req.query("sort"),
      dir,
    }),
    200
  );
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
