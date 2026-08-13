import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  upsertReceivingOrder,
  upsertPickingOrder,
  deleteReceivingOrder,
  deletePickingOrder,
  upsertPart,
  deletePart,
  upsertSupplier,
  deleteSupplier,
  upsertSupplierProfile,
  deleteSupplierProfile,
  upsertSubInventory,
  deleteSubInventory,
  type IngestReceivingBody,
  type IngestPickingBody,
  type IngestPart,
  type IngestSupplier,
  type IngestSupplierProfile,
  type IngestSubInventory,
} from "../db/ingest.js";
import { allocateAll } from "../db/allocate.js";

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const ingestRoute = new Hono();

// PUT /receiving-orders/:batchNo — idempotent ingest upsert keyed by the
// natural batch_no. 201 on create, 200 on reconcile (`changed` reports whether
// anything differed). Changed expected qtys on an order past pending move
// allocation demand → best-effort allocateAll after commit (a new pending
// order needs no trigger, plan phase 7).
ingestRoute.put("/receiving-orders/:batchNo", async (c) => {
  const body = await readJson<IngestReceivingBody>(c);
  const result = await upsertReceivingOrder(db, c.req.param("batchNo"), body);
  if (result.changed && result.orderStatus !== "pending") {
    try {
      await allocateAll(db);
    } catch (err) {
      console.error("allocateAll after receiving upsert failed", err);
    }
  }
  return c.json(
    { id: result.id, created: result.created, changed: result.changed },
    result.created ? 201 : 200
  );
});

// DELETE /receiving-orders/:batchNo — whole-order delete (DocPal
// cancellation). Pending + no work started only; children cascade. Removing a
// dock-stock source changes allocation → best-effort allocateAll after commit.
ingestRoute.delete("/receiving-orders/:batchNo", async (c) => {
  const result = await deleteReceivingOrder(db, c.req.param("batchNo"));
  try {
    await allocateAll(db);
  } catch (err) {
    console.error("allocateAll after receiving delete failed", err);
  }
  return c.json({ id: result.id, deleted: true }, 200);
});

// PUT /picking-orders/:orderNo — same upsert pattern for picking orders
// (order_no is the upstream sync/dedup key). Any change to an open
// (pending/picking) order → best-effort allocateAll after commit.
ingestRoute.put("/picking-orders/:orderNo", async (c) => {
  const body = await readJson<IngestPickingBody>(c);
  const result = await upsertPickingOrder(db, c.req.param("orderNo"), body);
  if (result.changed && (result.orderStatus === "pending" || result.orderStatus === "picking")) {
    try {
      await allocateAll(db);
    } catch (err) {
      console.error("allocateAll after picking upsert failed", err);
    }
  }
  return c.json(
    { id: result.id, created: result.created, changed: result.changed },
    result.created ? 201 : 200
  );
});

// DELETE /picking-orders/:orderNo — whole-order delete (DocPal cancellation).
// Pending + no work started only; children cascade, priority_seq is not
// compacted. Removing a demand changes allocation → best-effort allocateAll.
ingestRoute.delete("/picking-orders/:orderNo", async (c) => {
  const result = await deletePickingOrder(db, c.req.param("orderNo"));
  try {
    await allocateAll(db);
  } catch (err) {
    console.error("allocateAll after picking delete failed", err);
  }
  return c.json({ id: result.id, deleted: true }, 200);
});

// ---------------------------------------------------------------------------
// Master-data ingest (parts / suppliers / supplier_profiles / sub_inventories)
// — same upsert/delete pattern, keyed by the master rows' natural keys. No
// allocateAll (master rows move no stock); no app_events (the admin CRUD
// emits none either — the sync_events DB triggers record these writes).
// ---------------------------------------------------------------------------

// PUT /parts/:partNo — upsert keyed by part_no → {id, created, changed}.
ingestRoute.put("/parts/:partNo", async (c) => {
  const body = await readJson<IngestPart>(c);
  const result = await upsertPart(db, c.req.param("partNo"), body);
  return c.json(result, result.created ? 201 : 200);
});

// DELETE /parts/:partNo — 404 not_found; 409 cannot_delete_referenced (FK).
ingestRoute.delete("/parts/:partNo", async (c) => {
  const result = await deletePart(db, c.req.param("partNo"));
  return c.json({ id: result.id, deleted: true }, 200);
});

// PUT /suppliers/:code — upsert keyed by code.
ingestRoute.put("/suppliers/:code", async (c) => {
  const body = await readJson<IngestSupplier>(c);
  const result = await upsertSupplier(db, c.req.param("code"), body);
  return c.json(result, result.created ? 201 : 200);
});

// DELETE /suppliers/:code — 404 not_found; 409 cannot_delete_referenced (FK).
ingestRoute.delete("/suppliers/:code", async (c) => {
  const result = await deleteSupplier(db, c.req.param("code"));
  return c.json({ id: result.id, deleted: true }, 200);
});

// PUT /supplier-profiles/:supplierCode — upsert keyed by supplier_code
// (400 unknown_supplier when the supplier row does not exist).
ingestRoute.put("/supplier-profiles/:supplierCode", async (c) => {
  const body = await readJson<IngestSupplierProfile>(c);
  const result = await upsertSupplierProfile(db, c.req.param("supplierCode"), body);
  return c.json(result, result.created ? 201 : 200);
});

// DELETE /supplier-profiles/:supplierCode — 404 not_found.
ingestRoute.delete("/supplier-profiles/:supplierCode", async (c) => {
  const result = await deleteSupplierProfile(db, c.req.param("supplierCode"));
  return c.json({ id: result.id, deleted: true }, 200);
});

// PUT /sub-inventories/:orgId/:code — upsert keyed by (org_id,
// secondary_inventory_name); 400 invalid_org_id / unknown_customer.
ingestRoute.put("/sub-inventories/:orgId/:code", async (c) => {
  const body = await readJson<IngestSubInventory>(c);
  const result = await upsertSubInventory(db, c.req.param("orgId"), c.req.param("code"), body);
  return c.json(result, result.created ? 201 : 200);
});

// DELETE /sub-inventories/:orgId/:code — 404 not_found; 409
// cannot_delete_referenced (stock/doc composite FKs).
ingestRoute.delete("/sub-inventories/:orgId/:code", async (c) => {
  const result = await deleteSubInventory(db, c.req.param("orgId"), c.req.param("code"));
  return c.json({ id: result.id, deleted: true }, 200);
});
