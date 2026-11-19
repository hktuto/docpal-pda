import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import { getMeasuringBoxDetail, listMeasuringBoxes, scanItemCompleteBox } from "../db/measuring.js";
import { actorFrom, visibilityUsername } from "../auth/middleware.js";

export const measuringRoute = new Hono();

// Measuring work list (box-scoped): open boxes that contain packages whose
// picking orders are all picking-complete, grouped by picking order.
measuringRoute.get("/measuring-boxes", async (c) => {
  return c.json(await listMeasuringBoxes(db, visibilityUsername(c)), 200);
});

// Box detail: box fields + packages (part identity) + suggestedNetWeightKg.
measuringRoute.get("/measuring-boxes/:id", async (c) => {
  return c.json(await getMeasuringBoxDetail(db, c.req.param("id"), visibilityUsername(c)), 200);
});

// Quick item scan (spec 2026-11-18): one order's boxes; the single remaining
// part's box gets fully credited when no label-mode/carton matching applies.
measuringRoute.post("/measuring-boxes/scan-item", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    mode?: string;
    orderKey?: string;
    partNo?: string;
    wclItemNo?: string;
    raw?: string;
  } | null;
  if ((body?.mode !== "measuring" && body?.mode !== "verify") || !body.orderKey?.trim()) {
    throw new HTTPException(400, { message: "invalid_scan_item_input" });
  }
  const result = await scanItemCompleteBox(db, {
    mode: body.mode,
    orderKey: body.orderKey.trim(),
    partNo: body.partNo,
    wclItemNo: body.wclItemNo,
    raw: body.raw,
    actorId: actorFrom(c).id,
    username: visibilityUsername(c),
  });
  if (!result) throw new HTTPException(404, { message: "scan_item_no_match" });
  return c.json(result, 200);
});
