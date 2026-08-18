import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { allocateAll } from "../db/allocate.js";
import {
  deleteReceivingOrder,
  deletePickingOrder,
  applyItemSubInventoryDefault,
} from "../db/ingest.js";
import type { TableSync, Row } from "./consumer.js";

// ---------------------------------------------------------------------------
// Order-table sync (phase 4 of
// docs/superpowers/plans/2026-08-18-electric-sql-sync.md).
//
// Unlike master data (natural-key upserts through the ingest functions), order
// rows apply per-row keyed on the REMOTE id, adopted as the local PK
// (picking_orders.id is caller-supplied by design; receiving order/invoice/
// item rows of synced orders are created by this consumer, so their ids are
// always the remote ones). replica "default" suffices: the PK is always
// present and updates carry only changed columns.
//
// Error policy:
//  - ParentNotReadyError (child arrived before its parent — the five shapes
//    are independent streams) propagates: the batch fails, the checkpoint is
//    NOT saved, and the stream restarts and replays until the parent lands.
//  - Missing master data for an order header (supplier for receiving
//    orders/invoices, customer for picking orders) also throws
//    ParentNotReadyError: each shape streams independently, so the master
//    may arrive a batch later; retrying keeps the order instead of skipping
//    it permanently.
//  - Other poison messages (genuinely bad rows) are loud log + skip: a single
//    bad row must not stall the whole stream (checkpoint still advances).
//  - Deletes reuse the ingest guards: an order/line with work started is NOT
//    deleted — the change is logged and skipped (interim "reject + surface"
//    delete policy from the spec).
// ---------------------------------------------------------------------------

/** Thrown when a child row arrives before its parent is synced locally. */
export class ParentNotReadyError extends Error {}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** jsonb columns arrive parsed from the shape log; raw SQL needs a string. */
function jsonbOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

async function queryOne<T>(db: AppDb, q: ReturnType<typeof sql>): Promise<T | undefined> {
  const res = await db.execute(q);
  return (res as unknown as { rows?: T[] }).rows?.[0] ?? (Array.isArray(res) ? (res as T[])[0] : undefined);
}

/** Generic remote-id-keyed upsert over the remote-owned columns present in the row. */
async function upsertById(
  db: AppDb,
  table: string,
  row: Row,
  opts?: { insertExtras?: Record<string, unknown> }
): Promise<void> {
  const id = String(row.id);
  const cols = Object.keys(row).filter((c) => c !== "id");
  if (cols.length === 0 && !opts?.insertExtras) return;
  const insertCols = [...cols, ...Object.keys(opts?.insertExtras ?? {})];
  const colSql = sql.raw(insertCols.map((c) => `"${c}"`).join(", "));
  const valSql = sql.join(
    insertCols.map((c) =>
      c in row
        ? sql`${row[c]}`
        : sql`${(opts?.insertExtras as Record<string, unknown>)[c]}`
    ),
    sql`, `
  );
  const setSql = sql.join(
    cols.map((c) => sql.raw(`"${c}" = EXCLUDED."${c}"`)),
    sql`, `
  );
  await db.execute(sql`
    INSERT INTO ${sql.raw(table)} ("id", ${colSql}) VALUES (${id}, ${valSql})
    ON CONFLICT ("id") DO UPDATE SET ${setSql}`);
}

/** Throw ParentNotReadyError when the referenced parent row is not synced yet. */
async function requireParent(db: AppDb, table: string, id: string, label: string): Promise<void> {
  const found = await queryOne<{ id: string }>(
    db,
    sql`SELECT id FROM ${sql.raw(table)} WHERE id = ${id} LIMIT 1`
  );
  if (!found) throw new ParentNotReadyError(`${label} parent ${table} ${id} not synced yet`);
}

/**
 * Master-data references can arrive after their order because each Electric
 * shape streams independently. Treat a missing master as "not ready yet" so
 * the batch replays; otherwise we'd skip the order permanently.
 */
async function requireSupplier(db: AppDb, code: string): Promise<void> {
  const found = await queryOne<{ code: string }>(db, sql`SELECT code FROM suppliers WHERE code = ${code} LIMIT 1`);
  if (!found) throw new ParentNotReadyError(`supplier ${code} not synced yet`);
}

async function requireCustomer(db: AppDb, code: string): Promise<void> {
  const found = await queryOne<{ code: string }>(db, sql`SELECT code FROM customer_profiles WHERE code = ${code} LIMIT 1`);
  if (!found) throw new ParentNotReadyError(`customer ${code} not synced yet`);
}

// ---------------------------------------------------------------------------
// Allocation recompute: any order-table change marks the world dirty; the
// post-batch hook recomputes once per batch (best-effort, like the ingest
// routes' post-commit allocateAll).
// ---------------------------------------------------------------------------

let allocationDirty = false;

async function flushAllocation(db: AppDb): Promise<void> {
  if (!allocationDirty) return;
  allocationDirty = false;
  try {
    await allocateAll(db);
  } catch (e) {
    console.error("[sync] allocateAll after synced order change failed", e);
  }
}

// ---------------------------------------------------------------------------

export const ORDER_TABLE_SYNCS: TableSync[] = [
  {
    remoteTable: "demo.wms_receiving_orders",
    replica: "default",
    columns: ["id", "batch_no", "supplier_code", "delivery_date", "org_id", "date_code"],
    afterBatch: flushAllocation,
    upsert: async (db, r) => {
      allocationDirty = true;
      if (r.supplier_code) await requireSupplier(db, String(r.supplier_code));
      await upsertById(db, "receiving_orders", {
        id: strOrNull(r.id),
        batch_no: strOrNull(r.batch_no),
        supplier_code: strOrNull(r.supplier_code),
        delivery_date: strOrNull(r.delivery_date),
        org_id: numOrNull(r.org_id) ?? 2,
        date_code: strOrNull(r.date_code),
      });
    },
    remove: async (db, r) => {
      allocationDirty = true;
      // Delete messages carry only the PK (replica default) — resolve the
      // natural key first, then reuse the guarded ingest delete (404/409 →
      // log + skip = the interim reject-and-surface policy).
      const row = await queryOne<{ batch_no: string }>(
        db,
        sql`SELECT batch_no FROM receiving_orders WHERE id = ${String(r.id)} LIMIT 1`
      );
      if (!row) return;
      try {
        await deleteReceivingOrder(db, row.batch_no);
      } catch (e) {
        console.warn(`[sync] wms_receiving_orders delete skipped: ${(e as Error).message}`);
      }
    },
  },
  {
    remoteTable: "demo.wms_receiving_invoices",
    replica: "default",
    columns: [
      "id", "receiving_order_id", "invoice_no", "supplier_code", "wcl_company_name",
      "total_qty", "total_ctn", "delivery_date", "org_id",
    ],
    upsert: async (db, r) => {
      if (r.receiving_order_id !== undefined) {
        await requireParent(db, "receiving_orders", String(r.receiving_order_id), "invoice");
      }
      if (r.supplier_code) await requireSupplier(db, String(r.supplier_code));
      await upsertById(db, "receiving_invoices", {
        id: strOrNull(r.id),
        ...(r.receiving_order_id !== undefined ? { receiving_order_id: strOrNull(r.receiving_order_id) } : {}),
        invoice_no: strOrNull(r.invoice_no),
        supplier_code: strOrNull(r.supplier_code),
        wcl_company_name: strOrNull(r.wcl_company_name),
        total_qty: numOrNull(r.total_qty),
        total_ctn: numOrNull(r.total_ctn),
        delivery_date: strOrNull(r.delivery_date),
        org_id: numOrNull(r.org_id) ?? 2,
      });
    },
    remove: async (db, r) => {
      // Guard: refuse when any item has work started (mirrors the ingest
      // whole-order guard at line level).
      const worked = await queryOne<{ n: number }>(
        db,
        sql`SELECT COUNT(*)::int AS n FROM receiving_invoice_items
            WHERE receiving_invoice_id = ${String(r.id)}
              AND (received_qty > 0 OR picked_qty > 0 OR put_away_qty > 0)`
      );
      if (worked && worked.n > 0) {
        console.warn(`[sync] wms_receiving_invoices delete skipped: work started (${String(r.id)})`);
        return;
      }
      await db.execute(sql`DELETE FROM receiving_invoices WHERE id = ${String(r.id)}`);
    },
  },
  {
    remoteTable: "demo.wms_receiving_invoice_items",
    replica: "default",
    columns: [
      "id", "receiving_invoice_id", "part_no", "wcl_item_no", "po_no", "po_line",
      "line_qty", "ctn_no", "date_code", "lot_code", "coo", "cow",
      "org_id", "sub_inventory_code", "additional_data", "order_data",
    ],
    afterBatch: flushAllocation,
    upsert: async (db, r) => {
      allocationDirty = true;
      if (r.receiving_invoice_id !== undefined) {
        await requireParent(db, "receiving_invoices", String(r.receiving_invoice_id), "item");
      }
      // Sub-inventory defaulting rule hook (real rule owned by Sean; stub
      // warns on NULL pairs today). Runs on every apply so a later rule can
      // also repair existing rows.
      const defaulted = applyItemSubInventoryDefault({
        orgId: numOrNull(r.org_id),
        subInventoryCode: strOrNull(r.sub_inventory_code),
      } as Parameters<typeof applyItemSubInventoryDefault>[0]);
      await upsertById(db, "receiving_invoice_items", {
        id: strOrNull(r.id),
        ...(r.receiving_invoice_id !== undefined ? { receiving_invoice_id: strOrNull(r.receiving_invoice_id) } : {}),
        part_no: strOrNull(r.part_no),
        wcl_item_no: strOrNull(r.wcl_item_no),
        po_no: strOrNull(r.po_no),
        po_line: strOrNull(r.po_line),
        line_qty: numOrNull(r.line_qty),
        ctn_no: strOrNull(r.ctn_no),
        date_code: strOrNull(r.date_code),
        lot_code: strOrNull(r.lot_code),
        coo: strOrNull(r.coo),
        cow: strOrNull(r.cow),
        org_id: defaulted.orgId ?? 2,
        sub_inventory_code: defaulted.subInventoryCode ?? null,
        additional_data: jsonbOrNull(r.additional_data),
        order_data: jsonbOrNull(r.order_data),
      });
    },
    remove: async (db, r) => {
      allocationDirty = true;
      const item = await queryOne<{ received_qty: number; picked_qty: number; put_away_qty: number }>(
        db,
        sql`SELECT received_qty, picked_qty, put_away_qty FROM receiving_invoice_items WHERE id = ${String(r.id)} LIMIT 1`
      );
      if (!item) return;
      if (item.received_qty > 0 || item.picked_qty > 0 || item.put_away_qty > 0) {
        console.warn(`[sync] wms_receiving_invoice_items delete skipped: work started (${String(r.id)})`);
        return;
      }
      await db.execute(sql`DELETE FROM receiving_invoice_items WHERE id = ${String(r.id)}`);
    },
  },
  {
    remoteTable: "demo.wms_picking_orders",
    replica: "default",
    columns: [
      "id", "order_no", "delivery_date", "po_no", "ship_to", "customer_code",
      "org_id", "sub_inventory_code", "commodity_inspection",
    ],
    afterBatch: flushAllocation,
    upsert: async (db, r) => {
      allocationDirty = true;
      if (r.customer_code) await requireCustomer(db, String(r.customer_code));
      // priority_seq is local-owned (admin-reorderable) — new synced orders
      // append at the end; the remote value is ignored.
      await upsertById(
        db,
        "picking_orders",
        {
          id: strOrNull(r.id),
          order_no: strOrNull(r.order_no),
          delivery_date: strOrNull(r.delivery_date),
          po_no: strOrNull(r.po_no),
          ship_to: strOrNull(r.ship_to),
          customer_code: strOrNull(r.customer_code),
          org_id: numOrNull(r.org_id),
          sub_inventory_code: strOrNull(r.sub_inventory_code),
          commodity_inspection: strOrNull(r.commodity_inspection),
        },
        {
          insertExtras: {
            priority_seq: sql`(SELECT COALESCE(MAX(priority_seq) + 1, 0) FROM picking_orders)`,
          },
        }
      );
    },
    remove: async (db, r) => {
      allocationDirty = true;
      try {
        await deletePickingOrder(db, String(r.id));
      } catch (e) {
        console.warn(`[sync] wms_picking_orders delete skipped: ${(e as Error).message}`);
      }
    },
  },
  {
    remoteTable: "demo.wms_picking_items",
    replica: "default",
    columns: [
      "id", "picking_order_id", "part_no", "qty", "line_id", "line_number",
      "shipment_number", "additional_data",
    ],
    afterBatch: flushAllocation,
    upsert: async (db, r) => {
      allocationDirty = true;
      if (r.picking_order_id !== undefined) {
        await requireParent(db, "picking_orders", String(r.picking_order_id), "picking item");
      }
      await upsertById(db, "picking_items", {
        id: strOrNull(r.id),
        ...(r.picking_order_id !== undefined ? { picking_order_id: strOrNull(r.picking_order_id) } : {}),
        part_no: strOrNull(r.part_no),
        qty: numOrNull(r.qty),
        line_id: numOrNull(r.line_id),
        line_number: numOrNull(r.line_number),
        shipment_number: numOrNull(r.shipment_number),
        additional_data: jsonbOrNull(r.additional_data),
      });
    },
    remove: async (db, r) => {
      allocationDirty = true;
      const item = await queryOne<{ picked_qty: number }>(
        db,
        sql`SELECT picked_qty FROM picking_items WHERE id = ${String(r.id)} LIMIT 1`
      );
      if (!item) return;
      if (item.picked_qty > 0) {
        console.warn(`[sync] wms_picking_items delete skipped: already picked (${String(r.id)})`);
        return;
      }
      await db.execute(sql`DELETE FROM picking_items WHERE id = ${String(r.id)}`);
    },
  },
];
