import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApplyOcrPickRequest, IngestUpsertResponse, PickingPutBody, ScanResponse } from "@warehouse/shared";
import { db } from "../db.js";
import { upsertPickingOrder } from "../ingest/picking.js";
import { allocatePickingOrder } from "../db/allocate.js";
import { reportPickingOrderIssues, type PickingIssueReason } from "../db/pickingIssues.js";
import { applyOcrPick } from "../db/ocrPick.js";

export const pickingRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function requireActorId(body: { actor_id?: unknown }): string {
  const actorId = body.actor_id;
  if (typeof actorId !== "string" || actorId.trim() === "") {
    throw new HTTPException(400, { message: "actor_id is required" });
  }
  return actorId;
}

const pickingIssueReasons: readonly string[] = ["insufficient_stock", "cannot_divide", "merge", "other"];

pickingRoute.put("/picking-orders/:external_id", async (c) => {
  const externalId = c.req.param("external_id");
  let body: PickingPutBody;
  try {
    body = await c.req.json<PickingPutBody>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const result = db.transaction((tx) => upsertPickingOrder(tx, externalId, body));
  // Allocation is best-effort and recomputable; it must never misreport a committed upsert.
  if (result.changed) {
    try {
      allocatePickingOrder(db, result.orderId);
    } catch (err) {
      console.error("allocatePickingOrder after picking upsert failed", err);
    }
  }
  const res: IngestUpsertResponse = { id: result.orderId, external_id: externalId, created: result.created, changed: result.changed };
  return c.json(res, result.created ? 201 : 200);
});

pickingRoute.post("/picking-orders/report-issues", async (c) => {
  const body = await readJson<{
    picking_order_ids?: unknown; reason?: string; qty?: number | null; pack_size?: number | null;
    remark?: string | null; actor_id?: string;
  }>(c);
  const actorId = requireActorId(body);
  if (!Array.isArray(body.picking_order_ids) || body.picking_order_ids.length === 0 || body.picking_order_ids.some((id) => typeof id !== "string")) {
    throw new HTTPException(400, { message: "picking_order_ids is required" });
  }
  if (typeof body.reason !== "string" || !pickingIssueReasons.includes(body.reason)) {
    throw new HTTPException(400, { message: "unhandled_issue_reason" });
  }
  const result = db.transaction((tx) =>
    reportPickingOrderIssues(tx, {
      pickingOrderIds: body.picking_order_ids as string[],
      reason: body.reason as PickingIssueReason,
      qty: body.qty ?? null,
      packSize: body.pack_size ?? null,
      remark: body.remark ?? null,
      actorId,
    })
  );
  return c.json(result, 200);
});

// NOTE: :id is the RECEIVING order id here (the scan targets a picking item but
// sources from this receiving order), matching the web's applyOcrPick signature.
pickingRoute.post("/picking-orders/:id/ocr-pick", async (c) => {
  const receivingOrderId = c.req.param("id");
  const body = await readJson<ApplyOcrPickRequest>(c);
  if (typeof body.picking_item_id !== "string" || body.picking_item_id.trim() === "") {
    throw new HTTPException(400, { message: "picking_item_id is required" });
  }
  const result = db.transaction((tx) =>
    applyOcrPick(tx, receivingOrderId, {
      pickingItemId: body.picking_item_id,
      qty: body.qty,
      actorId: body.actor_id ?? null,
    })
  );
  const res: ScanResponse = { package_ids: result.packageIds };
  return c.json(res, 200);
});
