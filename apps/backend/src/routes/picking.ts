import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  acquireWorkLock,
  addAllUnboxedToShippingBox,
  addPackageToBox,
  cancelShippingBox,
  claimShelfBox,
  closeShippingBox,
  createShippingBox,
  finishPickingOrder,
  getPickingOrderDetail,
  listPickingOrders,
  releaseWorkLock,
  removePackageFromBox,
  removeScannedPackage,
  reopenShippingBox,
  reorderPickingOrders,
  reportPickingOrderIssues,
  resolvePickingOrderIssue,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
  type PickingIssueEntry,
} from "../db/picking.js";
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

// Source-availability-changing mutations (scan / package removal) recalculate
// allocations after commit — best-effort, never roll back the mutation.
async function reallocateBestEffort(after: string): Promise<void> {
  try {
    await allocateAll(db);
  } catch (err) {
    console.error(`allocateAll after ${after} failed`, err);
  }
}

export const pickingRoute = new Hono();

// List with per-order item/qty counts; `?status=` is a pass-through filter.
pickingRoute.get("/picking-orders", async (c) => {
  return c.json(await listPickingOrders(db, c.req.query("status")), 200);
});

// Batch issue report (registered before /picking-orders/:id verbs — no path
// conflict, but kept first for clarity). Per-order entries.
pickingRoute.post("/picking-orders/report-issues", async (c) => {
  const body = await readJson<{ entries?: PickingIssueEntry[] }>(c);
  if (!Array.isArray(body.entries)) throw new HTTPException(400, { message: "entries is required" });
  const result = await reportPickingOrderIssues(db, { actorId: actorFrom(c).id, entries: body.entries });
  return c.json(result, 200);
});

// Admin reorder: { orderIds } in priority order → priority_seq 1..n, then
// re-allocate. Registered before /picking-orders/:id like report-issues.
pickingRoute.post("/picking-orders/reorder", async (c) => {
  const body = await readJson<{ orderIds?: string[] }>(c);
  if (!Array.isArray(body.orderIds)) throw new HTTPException(400, { message: "orderIds is required" });
  const result = await reorderPickingOrders(db, { actorId: actorFrom(c).id, orderIds: body.orderIds });
  await reallocateBestEffort("reorder");
  return c.json(result, 200);
});

// Nested detail: order + measuringTask + items (allocations, packages) + boxes.
pickingRoute.get("/picking-orders/:id", async (c) => {
  return c.json(await getPickingOrderDetail(db, c.req.param("id")), 200);
});

// The one canonical scan-to-pick: consumes the allocation's source into
// picking package(s) + PICK ledger rows, then recalculates allocations.
pickingRoute.post("/picking-items/:id/scan", async (c) => {
  const body = await readJson<{
    allocationId?: string;
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
  }>(c);
  if (!body.allocationId) throw new HTTPException(400, { message: "allocationId is required" });
  const result = await scanPickingItem(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    allocationId: body.allocationId,
    qty: body.qty as number,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
  });
  await reallocateBestEffort("pick scan");
  return c.json(result, 201);
});

// Remove an unboxed, unverified package (reverses source + allocation + ledger).
pickingRoute.delete("/packages/:id", async (c) => {
  await removeScannedPackage(db, { packageId: c.req.param("id"), actorId: actorFrom(c).id });
  await reallocateBestEffort("package removal");
  return c.json({ ok: true }, 200);
});

// Whole-box exact-match claim: reuse a shelf carton whose contents exactly
// equal the order's remaining demand as the (prefilled) shipping box.
pickingRoute.post("/picking-orders/:id/claim-shelf-box", async (c) => {
  const body = await readJson<{ shelfBoxId?: string }>(c);
  if (!body.shelfBoxId) throw new HTTPException(400, { message: "shelfBoxId is required" });
  const result = await claimShelfBox(db, {
    orderId: c.req.param("id"),
    shelfBoxId: body.shelfBoxId,
    actorId: actorFrom(c).id,
  });
  await reallocateBestEffort("whole-box claim");
  return c.json(result, 201);
});

// Measuring-time package verification (boxed, open box, pending task).
pickingRoute.post("/packages/:id/verify", async (c) => {
  await verifyPackage(db, { packageId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

// Create an open shipping box for the order. Optional `boxId` adopts a
// pre-printed label id (409 box_id_exists when taken).
pickingRoute.post("/picking-orders/:id/boxes", async (c) => {
  const body = await readJson<{ boxId?: string }>(c);
  const box = await createShippingBox(db, {
    pickingOrderId: c.req.param("id"),
    actorId: actorFrom(c).id,
    boxId: body.boxId,
  });
  return c.json(box, 201);
});

// Edit box size / weights (kg) / destination country; open boxes only.
pickingRoute.patch("/shipping-boxes/:id", async (c) => {
  const body = await readJson<{
    boxSize?: string | null;
    netWeightKg?: number | string | null;
    grossWeightKg?: number | string | null;
    destinationCountry?: string | null;
  }>(c);
  const box = await updateShippingBox(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    boxSize: body.boxSize,
    netWeightKg: body.netWeightKg,
    grossWeightKg: body.grossWeightKg,
    destinationCountry: body.destinationCountry,
  });
  return c.json(box, 200);
});

// Box membership: add one package / remove one package / add all unboxed.
pickingRoute.post("/shipping-boxes/:id/packages", async (c) => {
  const body = await readJson<{ packageId?: string }>(c);
  if (!body.packageId) throw new HTTPException(400, { message: "packageId is required" });
  await addPackageToBox(db, {
    shippingBoxId: c.req.param("id"),
    packageId: body.packageId,
    actorId: actorFrom(c).id,
  });
  return c.json({ ok: true }, 200);
});

pickingRoute.delete("/shipping-boxes/:id/packages/:packageId", async (c) => {
  await removePackageFromBox(db, {
    shippingBoxId: c.req.param("id"),
    packageId: c.req.param("packageId"),
    actorId: actorFrom(c).id,
  });
  return c.json({ ok: true }, 200);
});

pickingRoute.post("/shipping-boxes/:id/add-all-unboxed", async (c) => {
  const result = await addAllUnboxedToShippingBox(db, {
    shippingBoxId: c.req.param("id"),
    actorId: actorFrom(c).id,
  });
  return c.json(result, 200);
});

// Cancel (empty + open, hard delete) / close (verified + measured) a box.
pickingRoute.post("/shipping-boxes/:id/cancel", async (c) => {
  await cancelShippingBox(db, { shippingBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

pickingRoute.post("/shipping-boxes/:id/close", async (c) => {
  await closeShippingBox(db, { shippingBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

// Verify-step reopen: closed box → open + packages un-verified, so the worker
// can re-measure (409 unless the order has a pending verify task).
pickingRoute.post("/shipping-boxes/:id/reopen", async (c) => {
  await reopenShippingBox(db, { shippingBoxId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});

// Admin resolve of an open issue: back to pending (issue fields cleared),
// then re-allocate so the order takes part in allocation again.
pickingRoute.post("/picking-orders/:id/resolve-issue", async (c) => {
  const body = await readJson<{ resolutionNote?: string }>(c);
  const result = await resolvePickingOrderIssue(db, {
    orderId: c.req.param("id"),
    actorId: actorFrom(c).id,
    resolutionNote: body.resolutionNote ?? null,
  });
  await reallocateBestEffort("issue resolve");
  return c.json(result, 200);
});

// Explicit finish: all items fully boxed → order finished + measuring task.
pickingRoute.post("/picking-orders/:id/finish", async (c) => {
  const task = await finishPickingOrder(db, { pickingOrderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json(task, 200);
});

// Page-driven work lock: acquire/refresh while the order page is open
// (409 lock_held with holder info when another user holds a fresh lock).
pickingRoute.post("/picking-orders/:id/work-lock", async (c) => {
  const lock = await acquireWorkLock(db, { orderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json(lock, 200);
});

// Best-effort release on page leave (sendBeacon — no body parsing needed).
pickingRoute.delete("/picking-orders/:id/work-lock", async (c) => {
  await releaseWorkLock(db, { orderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});
