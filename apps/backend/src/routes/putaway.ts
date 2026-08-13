import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  addAllUnboxedToBox,
  assignScanToBox,
  cancelShelfBox,
  closeShelfBox,
  createShelfBox,
  getPutAwayAggregate,
  listPutAwayCandidates,
  recordPutAwayScan,
  removeScanFromBox,
  deleteStagedPutAwayScan,
} from "../db/putaway.js";
import { getPutAwayTaskDetail, listPutAwayTasks } from "../db/putawaytasks.js";
import { allocateAll } from "../db/allocate.js";
import { actorFrom } from "../auth/middleware.js";

// Empty bodies parse as {} — after the auth migration several mutations no
// longer carry any body fields (the actor comes from the token).
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

// Lot/put-away-qty-changing mutations recalculate allocations after commit —
// best-effort, never roll back the mutation (concept 5).
async function reallocateBestEffort(after: string): Promise<void> {
  try {
    await allocateAll(db);
  } catch (err) {
    console.error(`allocateAll after ${after} failed`, err);
  }
}

export const putawayRoute = new Hono();

// Receivable orders (in_hand / provisional_received) with per-order
// received/unboxed item counts.
putawayRoute.get("/put-away/candidates", async (c) => {
  return c.json(await listPutAwayCandidates(db), 200);
});

// Put-away task queue (auto-created on arrival when FLOW_CONFIG
// steps.put-away.autoCreateTasks is on), oldest first. ?status= filters.
putawayRoute.get("/put-away-tasks", async (c) => {
  return c.json(await listPutAwayTasks(db, c.req.query("status")), 200);
});

// Task detail: the per-order put-away aggregate (with per-item shelf hints)
// plus the task row.
putawayRoute.get("/put-away-tasks/:id", async (c) => {
  return c.json(await getPutAwayTaskDetail(db, c.req.param("id")), 200);
});

// One aggregate for the put-away detail screen: order + lots + staging scans
// + non-staging boxes with their items (replaces the old 3-call stitch), with
// per-item shelf suggestions (unless FLOW_CONFIG steps.put-away.suggestShelf=off).
putawayRoute.get("/receiving-orders/:id/put-away", async (c) => {
  return c.json(await getPutAwayAggregate(db, c.req.param("id")), 200);
});

// Record one staging scan (staging-box insert + batch-attr backfill on the
// item). 409 scanned_qty_exceeds_remaining when over the remaining qty.
putawayRoute.post("/receiving-orders/:id/put-away-scans", async (c) => {
  const body = await readJson<{
    receivingInvoiceItemId?: string;
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
    shelfBoxId?: string;
  }>(c);
  if (!body.receivingInvoiceItemId) {
    throw new HTTPException(400, { message: "receivingInvoiceItemId is required" });
  }
  const row = await recordPutAwayScan(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    receivingInvoiceItemId: body.receivingInvoiceItemId,
    qty: body.qty as number,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
    shelfBoxId: body.shelfBoxId ?? null,
  });
  // A scan straight into a box moves stock (dock → on_hand): re-run allocation.
  if (body.shelfBoxId) await reallocateBestEffort("put-away scan-to-box");
  return c.json(row, 201);
});

// Create a real (non-staging) shelf box for an order. Optional boxId = scanned
// physical box QR (reuse open same-order box; 409 box_id_already_exists).
putawayRoute.post("/shelf-boxes", async (c) => {
  const body = await readJson<{ receivingOrderId?: string; shelfCode?: string; boxId?: string }>(c);
  if (!body.receivingOrderId) throw new HTTPException(400, { message: "receivingOrderId is required" });
  if (!body.shelfCode) throw new HTTPException(400, { message: "shelfCode is required" });
  const box = await createShelfBox(db, {
    receivingOrderId: body.receivingOrderId,
    shelfCode: body.shelfCode,
    actorId: actorFrom(c).id,
    boxId: body.boxId ?? null,
  });
  return c.json(box, 201);
});

// Cancel an empty, open, non-staging box (hard delete + transition log).
putawayRoute.delete("/shelf-boxes/:id", async (c) => {
  await cancelShelfBox(db, { shelfBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

// Assign one staging scan into this box (materializes the lot + ledger).
putawayRoute.post("/shelf-boxes/:id/scans", async (c) => {
  const body = await readJson<{ scanId?: string }>(c);
  if (!body.scanId) throw new HTTPException(400, { message: "scanId is required" });
  await assignScanToBox(db, { scanId: body.scanId, shelfBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  await reallocateBestEffort("put-away assign");
  return c.json({ ok: true }, 200);
});

// Remove one scan from this box back to staging (reverses lot + ledger).
putawayRoute.delete("/shelf-boxes/:id/scans/:scanId", async (c) => {
  await removeScanFromBox(db, {
    shelfBoxId: c.req.param("id"),
    scanId: c.req.param("scanId"),
    actorId: actorFrom(c).id,
  });
  await reallocateBestEffort("put-away remove");
  return c.json({ ok: true }, 200);
});

// Delete a staged scan (mis-scan correction; boxed scans → remove-from-box).
putawayRoute.delete("/put-away-scans/:scanId", async (c) => {
  await deleteStagedPutAwayScan(db, { scanId: c.req.param("scanId"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

// Assign every staging scan of the box's order into the box.
putawayRoute.post("/shelf-boxes/:id/add-all-unboxed", async (c) => {
  const result = await addAllUnboxedToBox(db, { shelfBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  await reallocateBestEffort("put-away add-all-unboxed");
  return c.json(result, 200);
});

// Close a non-empty, open, non-staging box (+ auto-clear check).
putawayRoute.post("/shelf-boxes/:id/close", async (c) => {
  await closeShelfBox(db, { shelfBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});
