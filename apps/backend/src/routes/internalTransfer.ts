import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import { actorFrom } from "../auth/middleware.js";
import {
  listInternalTransferQueue,
  getInternalTransferPickingDetail,
  acquireInternalTransferWorkLock,
  releaseInternalTransferWorkLock,
  scanInternalTransferItem,
  scanInternalTransferLabel,
  removeInternalTransferPackage,
  reportInternalTransferIssue,
  finishInternalTransferOrder,
  shelveInternalTransferPackages,
} from "../db/internalTransferPicking.js";

// PDA internal-transfer flow (spec
// docs/superpowers/specs/2026-11-10-internal-transfer-pda-picking-design.md):
// queue (pickable + put-away-pending), work-locked pick scans, package
// removal, issue reporting, finish branches, and the native shelving step
// for the unlinked branch. No boxes/verify/shipping — transfers never ship.

export const internalTransferRoute = new Hono();

internalTransferRoute.get("/internal-transfer-orders", async (c) => {
  return c.json(await listInternalTransferQueue(db), 200);
});

internalTransferRoute.get("/internal-transfer-orders/:id", async (c) => {
  const detail = await getInternalTransferPickingDetail(db, c.req.param("id"));
  return detail ? c.json(detail, 200) : c.json({ error: "transfer_order_not_found" }, 404);
});

// 10-min work lock, same semantics as picking (404 transfer_order_not_found,
// 409 transfer_order_not_open outside allocated/picking/issue, 409 lock_held).
internalTransferRoute.post("/internal-transfer-orders/:id/work-lock", async (c) => {
  return c.json(await acquireInternalTransferWorkLock(db, { orderId: c.req.param("id"), actorId: actorFrom(c).id }), 200);
});

internalTransferRoute.delete("/internal-transfer-orders/:id/work-lock", async (c) => {
  await releaseInternalTransferWorkLock(db, { orderId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ released: true }, 200);
});

// The one canonical scan-to-pick (mirror of POST /picking-items/:id/scan,
// minus box/verify): consumes the allocation's source into
// internal_transfer_packages + a PICK ledger pair, shrinks the allocation in
// the same tx — no recompute. Body {allocationId, qty, dateCode?, lotCode?,
// coo?, cow?, shelfCode?, boxId?}. 404 transfer_item_not_found /
// allocation_not_found / inventory_lot_not_found; 409
// scanned_qty_exceeds_allocation / scan_qty_exceeds_required /
// transfer_not_confirmed / transfer_already_finished / shelf_scan_required /
// insufficient_lot_qty / receiving_source_qty_not_available.
internalTransferRoute.post("/internal-transfer-items/:id/scan", async (c) => {
  const body = await c.req.json<{
    allocationId?: string;
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
    shelfCode?: string;
    boxId?: string;
  }>();
  if (!body.allocationId) throw new HTTPException(400, { message: "allocationId is required" });
  const result = await scanInternalTransferItem(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    allocationId: body.allocationId,
    qty: body.qty as number,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
    shelfCode: body.shelfCode ?? null,
    boxId: body.boxId ?? null,
  });
  return c.json(result, 201);
});

// Item-QR-label scan (no prompt — the label's qty IS the pick qty): consumes
// the item's remaining allocation rows FIFO, SPANNING rows when one label
// crosses two lots (50000 as two 25000 labels over 30000+20000 rows). Body
// {qty, dateCode?, lotCode?, coo?, cow?, shelfCode?, boxId?}. Same guards as
// the guidance-row scan; 409 scanned_qty_exceeds_allocation when the
// reservations cannot cover the label qty.
internalTransferRoute.post("/internal-transfer-items/:id/scan-label", async (c) => {
  const body = await c.req.json<{
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
    shelfCode?: string;
    boxId?: string;
  }>();
  const result = await scanInternalTransferLabel(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    qty: body.qty as number,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
    shelfCode: body.shelfCode ?? null,
    boxId: body.boxId ?? null,
  });
  return c.json(result, 201);
});

// Un-pick one package (reverses source + allocation + ledger). 404
// package_not_found; 409 package_already_shelved / transfer_not_writable.
internalTransferRoute.delete("/internal-transfer-packages/:id", async (c) => {
  await removeInternalTransferPackage(db, { packageId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ removed: true }, 200);
});

// Record a shortage (issue_* columns, status → issue; informational —
// picking continues, a recorded issue satisfies the finish guard). Body
// {reason: insufficient_stock|cannot_divide|other, qty?, note?}.
internalTransferRoute.post("/internal-transfer-orders/:id/report-issue", async (c) => {
  const body = await c.req.json<{ reason?: string; qty?: number; note?: string }>();
  if (!body.reason) throw new HTTPException(400, { message: "reason is required" });
  await reportInternalTransferIssue(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    reason: body.reason,
    qty: body.qty,
    note: body.note ?? null,
  });
  return c.json({ reported: true }, 200);
});

// Explicit finish. Linked branch: packages materialize as unshelved lots at
// the to_ partition and the delegated order's allocation re-runs awaited
// (confirm-arrival sequencing; `allocation` null when the scoped run failed).
// Unlinked: one put_away_tasks row for the native shelve flow. 409
// transfer_order_could_not_be_finished / not_all_items_picked (unless an
// issue is recorded) / no_items_to_pick / transfer_has_no_destination_org.
internalTransferRoute.post("/internal-transfer-orders/:id/finish", async (c) => {
  const result = await finishInternalTransferOrder(db, c.req.param("id"), actorFrom(c).id);
  return c.json(result, 200);
});

// Native shelving for the unlinked branch: shelve unshelved packages of a
// finished transfer onto a scanned shelf. Body {partNo, qty?, dateCode?,
// shelfCode}. 409 transfer_not_finished / transfer_is_linked /
// no_unshelved_packages_for_part / no_package_fits_qty; 404 shelf_not_found.
internalTransferRoute.post("/internal-transfer-orders/:id/shelve", async (c) => {
  const body = await c.req.json<{ partNo?: string; qty?: number; dateCode?: string; shelfCode?: string }>();
  if (!body.partNo) throw new HTTPException(400, { message: "partNo is required" });
  if (!body.shelfCode) throw new HTTPException(400, { message: "shelfCode is required" });
  const result = await shelveInternalTransferPackages(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    partNo: body.partNo,
    qty: body.qty,
    dateCode: body.dateCode ?? null,
    shelfCode: body.shelfCode,
  });
  return c.json(result, 200);
});
