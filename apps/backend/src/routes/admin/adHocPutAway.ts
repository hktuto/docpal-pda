import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import {
  listAdHocPutAways,
  getAdHocPutAwayDetail,
} from "../../db/adhocPutaway.js";

export const adHocPutAwayRoute = new Hono();

// List ad-hoc put-away batches with optional filters.
// Query params: page, pageSize, supplierCode, shelfCode, from, to
adHocPutAwayRoute.get("/", async (c) => {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize")) || 20));
  const supplierCode = c.req.query("supplierCode")?.trim() || undefined;
  const shelfCode = c.req.query("shelfCode")?.trim() || undefined;
  const from = c.req.query("from")?.trim() || undefined;
  const to = c.req.query("to")?.trim() || undefined;

  const result = await listAdHocPutAways(db, {
    page,
    pageSize,
    supplierCode,
    shelfCode,
    from,
    to,
  });
  return c.json(result);
});

// Get a single ad-hoc put-away batch with its items.
adHocPutAwayRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const detail = await getAdHocPutAwayDetail(db, id);
  if (!detail) throw new HTTPException(404, { message: "not found" });
  return c.json(detail);
});
