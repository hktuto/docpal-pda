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
  finishLabeling,
  getPickingOrderDetail,
  getPickingShelfStock,
  listLabelingOrders,
  listPickingOrders,
  releaseWorkLock,
  removePackageFromBox,
  removeScannedPackage,
  reopenShippingBox,
  reorderPickingOrders,
  reportPickingOrderIssues,
  resolvePickingOrderIssue,
  scanIntoShippingBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
  type PickingIssueEntry,
} from "../db/picking.js";
import { scheduleAllocateAll } from "../db/allocate.js";
import { resolveLabelPrintRulesForOrder } from "../db/labelPrint.js";
import { actorFrom } from "../auth/middleware.js";
import { getUserScope } from "../db/user-scope.js";

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

// Priority/status-changing mutations (admin reorder / issue resolve)
// recalculate allocations after commit — scheduled in the background, never
// rolled back into the mutation response. Pick scans and package removal
// deliberately do NOT: a pick consumes exactly what its allocation reserved
// (reduceAllocation shrinks the row in the same tx, and scans are capped at
// the allocation qty), so the fleet-wide invariant is preserved without a
// rebuild — the old per-scan allocateAll only reshuffled priorities at the
// cost of a multi-second full-fleet transaction blocking every concurrent
// scan/finish on the same rows.
function reallocateBestEffort(after: string): void {
  scheduleAllocateAll(db, after);
}

export const pickingRoute = new Hono();

// List with per-order item/qty counts. `?status=`/`?allocation=`/`?type=`
// accept comma-separated lists; `?search=` + `?limit=`/`?offset=` page
// server-side; `?sort=`/`?dir=` sort by a whitelisted column key.
pickingRoute.get("/picking-orders", async (c) => {
  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));
  const scope = await getUserScope(db, actorFrom(c).username);
  return c.json(
    await listPickingOrders(db, {
      status: c.req.query("status"),
      allocation: c.req.query("allocation"),
      type: c.req.query("type"),
      search: c.req.query("search"),
      limit: Number.isNaN(limit) ? undefined : limit,
      offset: Number.isNaN(offset) ? undefined : offset,
      sort: c.req.query("sort"),
      dir: c.req.query("dir") === "desc" ? "desc" : "asc",
      deliveryDateFrom: c.req.query("deliveryDateFrom"),
      deliveryDateTo: c.req.query("deliveryDateTo"),
      scope,
    }),
    200
  );
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
  reallocateBestEffort("reorder");
  return c.json(result, 200);
});

// Nested detail: order + items (allocations, packages) + boxes.
pickingRoute.get("/picking-orders/:id", async (c) => {
  const scope = await getUserScope(db, actorFrom(c).username);
  return c.json(await getPickingOrderDetail(db, c.req.param("id"), scope), 200);
});

// Label-print rules matching this order (picking-finish print prompt):
// first active rule by ascending priority per label_type.
pickingRoute.get("/picking-orders/:id/label-print-rules", async (c) => {
  return c.json(await resolveLabelPrintRulesForOrder(db, c.req.param("id")), 200);
});

// Shelf presence check (flow config pickingShelfScan require-match): stock of
// a part at a shelf/box — the scan page calls it once per (shelf, part) and
// rejects item labels with no stock on the pending shelf. Optional orderId
// scopes the lookup server-side from the order + item (transfer-aware);
// orgId/subInventoryCode are the legacy client-supplied scope.
pickingRoute.get("/picking-shelf-stock", async (c) => {
  const orgId = Number(c.req.query("orgId"));
  return c.json(
    await getPickingShelfStock(db, {
      partNo: c.req.query("partNo") || undefined,
      wclItemNo: c.req.query("wclItemNo") || undefined,
      shelfCode: c.req.query("shelfCode") || undefined,
      boxId: c.req.query("boxId") || undefined,
      orgId: Number.isInteger(orgId) ? orgId : undefined,
      subInventoryCode: c.req.query("subInventoryCode") || undefined,
      orderId: c.req.query("orderId") || undefined,
    }),
    200
  );
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
    barcode?: string;
    scannedPartNo?: string;
    scannedWclItemNo?: string;
    scannedDateCode?: string;
    scannedLotCode?: string;
    scannedCoo?: string;
    scannedCow?: string;
    shelfCode?: string;
    boxId?: string;
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
    barcode: body.barcode ?? null,
    scannedPartNo: body.scannedPartNo ?? null,
    scannedWclItemNo: body.scannedWclItemNo ?? null,
    scannedDateCode: body.scannedDateCode ?? null,
    scannedLotCode: body.scannedLotCode ?? null,
    scannedCoo: body.scannedCoo ?? null,
    scannedCow: body.scannedCow ?? null,
    shelfCode: body.shelfCode ?? null,
    boxId: body.boxId ?? null,
  });
  // No allocation recompute: the pick consumed exactly what the allocation
  // reserved (see reallocateBestEffort's comment).
  return c.json(result, 201);
});

// Remove an unboxed, unverified package (reverses source + allocation + ledger).
pickingRoute.delete("/packages/:id", async (c) => {
  await removeScannedPackage(db, { packageId: c.req.param("id"), actorId: actorFrom(c).id });
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
  // The claim guard (box_not_fully_available) guarantees no other order
  // reserves these lots, and the order's own allocations are released
  // in-tx — no fleet recompute needed.
  return c.json(result, 201);
});

// Package verify-scan: credits body.qty (default: the package's remaining)
// onto rescanned_qty. Open box → measuring-time `verified`; closed box with
// a pending verify task → verify-step `verify_verified`. When the measuring
// step is disabled the verify pass runs on the still-open box (the finish
// spawned the task; verify completion closes the box).
pickingRoute.post("/packages/:id/verify", async (c) => {
  const body = await readJson<{ qty?: number }>(c);
  await verifyPackage(db, { packageId: c.req.param("id"), actorId: actorFrom(c).id, qty: body.qty });
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

// Scan-into-box (cross-order packing): resolve the barcode to the one open
// picking item + allocation it could mean across ALL orders, pick it straight
// into this box (404 no_matching_picking_item / 409 ambiguous_picking_item).
pickingRoute.post("/shipping-boxes/:id/scan", async (c) => {
  const body = await readJson<{ barcode?: string; qty?: number; shelfCode?: string; boxId?: string; dateCode?: string }>(c);
  if (!body.barcode) throw new HTTPException(400, { message: "barcode is required" });
  const result = await scanIntoShippingBox(db, {
    shippingBoxId: c.req.param("id"),
    barcode: body.barcode,
    qty: body.qty,
    actorId: actorFrom(c).id,
    shelfCode: body.shelfCode ?? null,
    boxId: body.boxId ?? null,
    dateCode: body.dateCode ?? null,
  });
  // Same as the pick scan: consumes only what the allocation reserved.
  return c.json(result, 201);
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
// can re-measure (409 unless THIS box has a pending verify task).
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
  reallocateBestEffort("issue resolve");
  return c.json(result, 200);
});

// Explicit finish: all items fully boxed → order picking_finished → {id, status}.
pickingRoute.post("/picking-orders/:id/finish", async (c) => {
  const result = await finishPickingOrder(db, { pickingOrderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json(result, 200);
});

// Labeling finish (spec 2026-10-28-picking-labeling-step-design.md): clears
// the order's labeling stage and runs the deferred post-finish progression.
pickingRoute.post("/picking-orders/:id/labeling-finish", async (c) => {
  const result = await finishLabeling(db, { pickingOrderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json(result, 200);
});

// Labeling queue: picking-finished orders still pending labeling, scoped like
// the picking list; ?search= + ?limit=/?offset= page server-side.
pickingRoute.get("/labeling-orders", async (c) => {
  const limit = Number(c.req.query("limit"));
  const offset = Number(c.req.query("offset"));
  const scope = await getUserScope(db, actorFrom(c).username);
  return c.json(
    await listLabelingOrders(db, {
      search: c.req.query("search"),
      limit: Number.isNaN(limit) ? undefined : limit,
      offset: Number.isNaN(offset) ? undefined : offset,
      scope,
    }),
    200
  );
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
