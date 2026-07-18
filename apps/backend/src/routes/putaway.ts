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
import { allocateAll } from "../db/allocate.js";

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function requireActor(body: { actorId?: string }): string {
  if (!body.actorId) throw new HTTPException(400, { message: "actorId is required" });
  return body.actorId;
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

// One aggregate for the put-away detail screen: order + lots + staging scans
// + non-staging boxes with their items (replaces the old 3-call stitch).
putawayRoute.get("/receiving-orders/:id/put-away", async (c) => {
  return c.json(await getPutAwayAggregate(db, c.req.param("id")), 200);
});

// Record one staging scan (staging-box insert + batch-attr backfill on the
// item). 409 scanned_qty_exceeds_remaining when over the remaining qty.
putawayRoute.post("/receiving-orders/:id/put-away-scans", async (c) => {
  const body = await readJson<{
    actorId?: string;
    receivingInvoiceItemId?: string;
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
    boxId?: string;
  }>(c);
  const actorId = requireActor(body);
  if (!body.receivingInvoiceItemId) {
    throw new HTTPException(400, { message: "receivingInvoiceItemId is required" });
  }
  const row = await recordPutAwayScan(db, c.req.param("id"), {
    actorId,
    receivingInvoiceItemId: body.receivingInvoiceItemId,
    qty: body.qty as number,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
    boxId: body.boxId ?? null,
  });
  return c.json(row, 201);
});

// Create a real (non-staging) shelf box for an order.
putawayRoute.post("/shelf-boxes", async (c) => {
  const body = await readJson<{ receivingOrderId?: string; shelfCode?: string; actorId?: string }>(c);
  const actorId = requireActor(body);
  if (!body.receivingOrderId) throw new HTTPException(400, { message: "receivingOrderId is required" });
  if (!body.shelfCode) throw new HTTPException(400, { message: "shelfCode is required" });
  const box = await createShelfBox(db, {
    receivingOrderId: body.receivingOrderId,
    shelfCode: body.shelfCode,
    actorId,
  });
  return c.json(box, 201);
});

// Cancel an empty, open, non-staging box (hard delete + transition log).
putawayRoute.delete("/shelf-boxes/:id", async (c) => {
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  await cancelShelfBox(db, { shelfBoxId: c.req.param("id"), actorId });
  return c.json({ ok: true }, 200);
});

// Assign one staging scan into this box (materializes the lot + ledger).
putawayRoute.post("/shelf-boxes/:id/scans", async (c) => {
  const body = await readJson<{ scanId?: string; actorId?: string }>(c);
  const actorId = requireActor(body);
  if (!body.scanId) throw new HTTPException(400, { message: "scanId is required" });
  await assignScanToBox(db, { scanId: body.scanId, shelfBoxId: c.req.param("id"), actorId });
  await reallocateBestEffort("put-away assign");
  return c.json({ ok: true }, 200);
});

// Remove one scan from this box back to staging (reverses lot + ledger).
putawayRoute.delete("/shelf-boxes/:id/scans/:scanId", async (c) => {
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  await removeScanFromBox(db, { shelfBoxId: c.req.param("id"), scanId: c.req.param("scanId"), actorId });
  await reallocateBestEffort("put-away remove");
  return c.json({ ok: true }, 200);
});

// Delete a staged scan (mis-scan correction; boxed scans → remove-from-box).
putawayRoute.delete("/put-away-scans/:scanId", async (c) => {
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  await deleteStagedPutAwayScan(db, { scanId: c.req.param("scanId"), actorId });
  return c.json({ ok: true }, 200);
});

// Assign every staging scan of the box's order into the box.
putawayRoute.post("/shelf-boxes/:id/add-all-unboxed", async (c) => {
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  const result = await addAllUnboxedToBox(db, { shelfBoxId: c.req.param("id"), actorId });
  await reallocateBestEffort("put-away add-all-unboxed");
  return c.json(result, 200);
});

// Close a non-empty, open, non-staging box (+ auto-clear check).
putawayRoute.post("/shelf-boxes/:id/close", async (c) => {
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  await closeShelfBox(db, { shelfBoxId: c.req.param("id"), actorId });
  return c.json({ ok: true }, 200);
});
