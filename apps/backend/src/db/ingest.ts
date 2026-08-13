import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import {
  receivingOrders,
  receivingInvoices,
  receivingInvoiceItems,
  pickingOrders,
  pickingItems,
  parts,
  suppliers,
  supplierProfiles,
  subInventories,
} from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Ingest upserts (server-to-server sync; plan decision 6 — no ledger rows).
// Ported from apps/api/src/ingest/{receiving,picking}.ts: idempotent upserts
// keyed by the natural keys (receiving batch_no / picking order_no — no
// external_id), with the old O(n²) line scan replaced by business-key map
// reconciles (invoices by invoice_no, receiving items by part_no+po_no+po_line,
// picking items by part_no).
// Derived state (received_qty / picked_qty / put_away_qty / allocated_qty /
// mismatch flags) is never written here.
// ---------------------------------------------------------------------------

export interface IngestUpsertResult {
  id: string;
  created: boolean;
  changed: boolean;
  /** Order status after the upsert — the route uses it to decide on allocateAll. */
  orderStatus: string;
}

// --- payload types (camelCase, per the API conventions) ----------------------

export interface IngestReceivingOrder {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  supplierCode?: string | null;
  deliveryDate?: string | null;
  dateCode?: string | null;
  orgId?: number | null;
  /** Required — every receiving order goes into exactly one sub-inventory. */
  subInventoryCode: string;
}

export interface IngestReceivingItem {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  partNo: string;
  wclItemNo?: string | null;
  poNo?: string | null;
  poLine?: string | null;
  lineQty: number;
  ctnNo?: string | null;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
  additionalData?: unknown;
}

export interface IngestReceivingInvoice {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  invoiceNo: string;
  supplierCode?: string | null;
  wclCompanyName?: string | null;
  totalQty?: number | null;
  totalCtn?: number | null;
  deliveryDate?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
  items: IngestReceivingItem[];
}

export interface IngestReceivingBody {
  order: IngestReceivingOrder;
  invoices: IngestReceivingInvoice[];
}

export interface IngestPickingOrder {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  poNo?: string | null;
  shipTo?: string | null;
  customerCode?: string | null;
  deliveryDate?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
}

export interface IngestPickingItem {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  partNo: string;
  qty: number;
  lineId: number;
  lineNumber: number;
  shipmentNumber: number;
  additionalData?: unknown;
}

export interface IngestPickingBody {
  order: IngestPickingOrder;
  items: IngestPickingItem[];
}

// --- helpers -----------------------------------------------------------------

function toDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HTTPException(400, { message: "invalid_delivery_date" });
  return d;
}

/**
 * delivery_date compare in SQL: identical input strings serialize identically
 * on the wire, so this stays stable no matter how the JS driver round-trips
 * `timestamp without time zone` (host TZ would skew a JS-side getTime() diff).
 */
async function deliveryDateDiffers(
  tx: DbOrTx,
  table: "receiving_orders" | "receiving_invoices" | "picking_orders",
  id: string,
  deliveryDate: Date | null
): Promise<boolean> {
  const row = await queryGet<{ differs: boolean }>(
    tx,
    sql`SELECT NOT (delivery_date IS NOT DISTINCT FROM ${deliveryDate}) AS "differs"
        FROM ${sql.raw(table)} WHERE id = ${id}`
  );
  return row?.differs ?? false;
}

/** supplierCode → suppliers.code (400 unknown_supplier when it does not exist). */
async function assertSupplierCode(tx: DbOrTx, supplierCode: string | null | undefined): Promise<string | null> {
  if (!supplierCode) return null;
  const row = await queryGet<{ code: string }>(tx, sql`SELECT code FROM suppliers WHERE code = ${supplierCode}`);
  if (!row) throw new HTTPException(400, { message: `unknown_supplier: ${supplierCode}` });
  return row.code;
}

/** Parts are referenced by part_no; 400 unknown_part when it does not exist. */
async function assertPartNo(tx: DbOrTx, partNo: string | null | undefined): Promise<string> {
  if (!partNo) throw new HTTPException(400, { message: "partNo is required" });
  const row = await queryGet<{ partNo: string }>(tx, sql`SELECT part_no AS "partNo" FROM parts WHERE part_no = ${partNo}`);
  if (!row) throw new HTTPException(400, { message: `unknown_part: ${partNo}` });
  return row.partNo;
}

/** customerCode → customer_profiles.code (400 unknown_customer). */
async function resolveCustomerCode(tx: DbOrTx, customerCode: string | null | undefined): Promise<string | null> {
  if (!customerCode) return null;
  const row = await queryGet<{ code: string }>(
    tx,
    sql`SELECT code FROM customer_profiles WHERE code = ${customerCode}`
  );
  if (!row) throw new HTTPException(400, { message: `unknown_customer: ${customerCode}` });
  return row.code;
}

// Business keys (null-safe).
const receivingItemKey = (partNo: string, poNo: string | null, poLine: string | null) =>
  `${partNo}|${poNo ?? ""}|${poLine ?? ""}`;

// Permissive UUID shape (any version) for caller-supplied ids.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Caller-supplied id (DocPal sync) — 400 invalid_id when present but not a
 * non-empty UUID-shaped string. Checked up front in the validate* fns.
 */
function assertValidSuppliedId(id: string | undefined): void {
  if (id === undefined) return;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new HTTPException(400, { message: "invalid_id" });
  }
}

/**
 * INSERT path only: use the supplied id or mint a UUID v7. A supplied id that
 * already exists as another row's PK (different natural key) → 409
 * id_already_exists (pre-checked; the raw PK violation would be uglier).
 */
async function insertId(tx: DbOrTx, table: string, supplied: string | undefined): Promise<string> {
  if (supplied !== undefined) {
    const clash = await queryGet<{ id: string }>(tx, sql`SELECT id FROM ${sql.raw(table)} WHERE id = ${supplied}`);
    if (clash) throw new HTTPException(409, { message: "id_already_exists" });
    return supplied;
  }
  return newId();
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function validateReceivingBody(body: IngestReceivingBody): void {
  if (!body?.order) throw new HTTPException(400, { message: "order is required" });
  if (!body.order.subInventoryCode) throw new HTTPException(400, { message: "order.subInventoryCode is required" });
  assertValidSuppliedId(body.order.id);
  if (!Array.isArray(body.invoices) || body.invoices.length === 0) {
    throw new HTTPException(400, { message: "invoices[] is required" });
  }
  for (const inv of body.invoices) {
    if (!inv.invoiceNo) throw new HTTPException(400, { message: "invoiceNo is required" });
    assertValidSuppliedId(inv.id);
    if (!Array.isArray(inv.items) || inv.items.length === 0) {
      throw new HTTPException(400, { message: `invoice ${inv.invoiceNo}: items[] required` });
    }
    for (const it of inv.items) {
      if (!it.partNo) throw new HTTPException(400, { message: "partNo is required" });
      assertValidSuppliedId(it.id);
      if (!Number.isInteger(it.lineQty) || it.lineQty < 0) {
        throw new HTTPException(400, { message: "lineQty must be a non-negative integer" });
      }
    }
  }
}

async function insertReceivingItem(tx: DbOrTx, invoiceId: string, it: IngestReceivingItem): Promise<void> {
  const partNo = await assertPartNo(tx, it.partNo);
  await tx.insert(receivingInvoiceItems).values({
    id: await insertId(tx, "receiving_invoice_items", it.id),
    receivingInvoiceId: invoiceId,
    partNo,
    wclItemNo: it.wclItemNo ?? null,
    poNo: it.poNo ?? null,
    poLine: it.poLine ?? null,
    lineQty: it.lineQty,
    ctnNo: it.ctnNo ?? null,
    dateCode: it.dateCode ?? null,
    lotCode: it.lotCode ?? null,
    coo: it.coo ?? null,
    cow: it.cow ?? null,
    orgId: it.orgId ?? 2,
    subInventoryCode: it.subInventoryCode ?? null,
    additionalData: it.additionalData ?? null,
  });
}

/** Invoice-level supplier wins over the order-level one (old upsertInvoice semantics). */
async function resolveInvoiceSupplierCode(
  tx: DbOrTx,
  inv: IngestReceivingInvoice,
  fallbackSupplierCode: string | null
): Promise<string | null> {
  return inv.supplierCode ? assertSupplierCode(tx, inv.supplierCode) : fallbackSupplierCode;
}

async function insertInvoiceWithItems(
  tx: DbOrTx,
  orderId: string,
  inv: IngestReceivingInvoice,
  fallbackSupplierCode: string | null
): Promise<string> {
  const supplierCode = await resolveInvoiceSupplierCode(tx, inv, fallbackSupplierCode);
  const invoiceId = await insertId(tx, "receiving_invoices", inv.id);
  await tx.insert(receivingInvoices).values({
    id: invoiceId,
    receivingOrderId: orderId,
    invoiceNo: inv.invoiceNo,
    supplierCode,
    wclCompanyName: inv.wclCompanyName ?? null,
    totalQty: inv.totalQty ?? null,
    totalCtn: inv.totalCtn ?? null,
    deliveryDate: toDate(inv.deliveryDate),
    orgId: inv.orgId ?? 2,
    subInventoryCode: inv.subInventoryCode ?? null,
  });
  for (const it of inv.items) {
    await insertReceivingItem(tx, invoiceId, it);
  }
  return invoiceId;
}

interface ExistingInvoiceRow {
  id: string;
  invoiceNo: string;
  supplierCode: string | null;
  wclCompanyName: string | null;
  totalQty: number | null;
  totalCtn: number | null;
  orgId: number;
  subInventoryCode: string | null;
}

interface ExistingReceivingItemRow {
  id: string;
  receivingInvoiceId: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  subInventoryCode: string | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocLinks: number;
}

function itemWorkStarted(it: Pick<ExistingReceivingItemRow, "allocLinks" | "receivedQty" | "pickedQty" | "putAwayQty">): boolean {
  return it.allocLinks > 0 || it.receivedQty > 0 || it.pickedQty > 0 || it.putAwayQty > 0;
}

/**
 * Idempotent upsert keyed by batch_no. No existing row → INSERT order +
 * invoices + items (status pending, org_id default 2; order.subInventoryCode
 * is required — every receiving order lands in exactly one sub-inventory).
 * A caller-supplied `id` (order/invoice/item) is used on this INSERT path
 * only; on reconcile it is ignored — existing rows keep their server ids and
 * matching stays on the natural keys. Existing row →
 * reconcile: order fields when different; invoices by invoice_no (add /
 * update / delete — delete cascades the items); items by business key
 * (part_no + po_no + po_line). Derived state is never touched; qty decreases
 * and line/invoice removals are guarded like the old ingest (blocked once the
 * order is past pending or work has started on the line).
 */
export async function upsertReceivingOrder(
  db: AppDb,
  batchNo: string,
  body: IngestReceivingBody
): Promise<IngestUpsertResult> {
  validateReceivingBody(body);
  return db.transaction(async (tx) => {
    const orderSupplierCode = await assertSupplierCode(tx, body.order.supplierCode);
    const orderDeliveryDate = toDate(body.order.deliveryDate);
    const existing = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM receiving_orders WHERE batch_no = ${batchNo} LIMIT 1`
    );

    if (!existing) {
      const orderId = await insertId(tx, "receiving_orders", body.order.id);
      await tx.insert(receivingOrders).values({
        id: orderId,
        batchNo,
        supplierCode: orderSupplierCode,
        deliveryDate: orderDeliveryDate,
        dateCode: body.order.dateCode ?? null,
        orgId: body.order.orgId ?? 2,
        subInventoryCode: body.order.subInventoryCode,
        status: "pending",
      });
      for (const inv of body.invoices) {
        await insertInvoiceWithItems(tx, orderId, inv, orderSupplierCode);
      }
      await emitEvent(tx, {
        type: "receiving_order.upserted",
        topics: ["/receiving-orders"],
        data: { id: orderId, batchNo },
      });
      return { id: orderId, created: true, changed: true, orderStatus: "pending" };
    }

    const orderId = existing.id;
    const status = existing.status;
    let changed = false;

    const ro = (await queryGet<{
      supplierCode: string | null;
      dateCode: string | null;
      orgId: number;
      subInventoryCode: string;
    }>(
      tx,
      sql`SELECT supplier_code AS "supplierCode", date_code AS "dateCode", org_id AS "orgId",
                 sub_inventory_code AS "subInventoryCode"
          FROM receiving_orders WHERE id = ${orderId}`
    ))!;
    const orderFields = {
      supplierCode: orderSupplierCode,
      deliveryDate: orderDeliveryDate,
      dateCode: body.order.dateCode ?? null,
      orgId: body.order.orgId ?? 2,
      subInventoryCode: body.order.subInventoryCode,
    };
    if (
      ro.supplierCode !== orderFields.supplierCode ||
      (await deliveryDateDiffers(tx, "receiving_orders", orderId, orderFields.deliveryDate)) ||
      ro.dateCode !== orderFields.dateCode ||
      ro.orgId !== orderFields.orgId ||
      ro.subInventoryCode !== orderFields.subInventoryCode
    ) {
      await queryRun(
        tx,
        sql`UPDATE receiving_orders SET supplier_code = ${orderFields.supplierCode},
              delivery_date = ${orderFields.deliveryDate}, date_code = ${orderFields.dateCode},
              org_id = ${orderFields.orgId}, sub_inventory_code = ${orderFields.subInventoryCode},
              last_update_date = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const locked = status !== "pending";
    const existingInvoices = await queryAll<ExistingInvoiceRow>(
      tx,
      sql`SELECT id, invoice_no AS "invoiceNo", supplier_code AS "supplierCode",
                 wcl_company_name AS "wclCompanyName", total_qty AS "totalQty", total_ctn AS "totalCtn",
                 org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM receiving_invoices WHERE receiving_order_id = ${orderId}`
    );
    const existingItems = await queryAll<ExistingReceivingItemRow>(
      tx,
      sql`SELECT rii.id, rii.receiving_invoice_id AS "receivingInvoiceId", rii.part_no AS "partNo",
                 rii.wcl_item_no AS "wclItemNo", rii.po_no AS "poNo", rii.po_line AS "poLine",
                 rii.line_qty AS "lineQty", rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow, rii.sub_inventory_code AS "subInventoryCode",
                 rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty", rii.put_away_qty AS "putAwayQty",
                 (SELECT COUNT(*)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id) AS "allocLinks"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${orderId}`
    );
    const invoicesByNo = new Map(existingInvoices.map((i) => [i.invoiceNo, i]));
    const itemsByInvoice = new Map<string, Map<string, ExistingReceivingItemRow>>();
    for (const it of existingItems) {
      let m = itemsByInvoice.get(it.receivingInvoiceId);
      if (!m) {
        m = new Map();
        itemsByInvoice.set(it.receivingInvoiceId, m);
      }
      m.set(receivingItemKey(it.partNo, it.poNo, it.poLine), it);
    }

    const seenInvoiceIds = new Set<string>();
    for (const inv of body.invoices) {
      const ex = invoicesByNo.get(inv.invoiceNo);
      if (!ex) {
        await insertInvoiceWithItems(tx, orderId, inv, orderSupplierCode);
        changed = true;
        continue;
      }
      seenInvoiceIds.add(ex.id);

      const invoiceSupplierCode = await resolveInvoiceSupplierCode(tx, inv, orderSupplierCode);
      const invFields = {
        supplierCode: invoiceSupplierCode,
        wclCompanyName: inv.wclCompanyName ?? null,
        totalQty: inv.totalQty ?? null,
        totalCtn: inv.totalCtn ?? null,
        deliveryDate: toDate(inv.deliveryDate),
        orgId: inv.orgId ?? 2,
        subInventoryCode: inv.subInventoryCode ?? null,
      };
      if (
        ex.supplierCode !== invFields.supplierCode ||
        ex.wclCompanyName !== invFields.wclCompanyName ||
        ex.totalQty !== invFields.totalQty ||
        ex.totalCtn !== invFields.totalCtn ||
        (await deliveryDateDiffers(tx, "receiving_invoices", ex.id, invFields.deliveryDate)) ||
        ex.orgId !== invFields.orgId ||
        ex.subInventoryCode !== invFields.subInventoryCode
      ) {
        await queryRun(
          tx,
          sql`UPDATE receiving_invoices SET supplier_code = ${invFields.supplierCode},
                wcl_company_name = ${invFields.wclCompanyName}, total_qty = ${invFields.totalQty},
                total_ctn = ${invFields.totalCtn}, delivery_date = ${invFields.deliveryDate},
                org_id = ${invFields.orgId}, sub_inventory_code = ${invFields.subInventoryCode},
                last_update_date = ${now()}
              WHERE id = ${ex.id}`
        );
        changed = true;
      }

      const byKey = itemsByInvoice.get(ex.id) ?? new Map<string, ExistingReceivingItemRow>();
      for (const it of inv.items) {
        const partNo = await assertPartNo(tx, it.partNo);
        const key = receivingItemKey(partNo, it.poNo ?? null, it.poLine ?? null);
        const exItem = byKey.get(key);
        if (!exItem) {
          await insertReceivingItem(tx, ex.id, it);
          changed = true;
          continue;
        }
        byKey.delete(key);
        if (it.lineQty < exItem.lineQty) {
          if (locked) throw new HTTPException(409, { message: `qty_may_only_increase_once_${status}` });
          if (itemWorkStarted(exItem)) {
            throw new HTTPException(409, { message: "cannot_decrease_qty_after_work_started" });
          }
        }
        const same =
          exItem.lineQty === it.lineQty &&
          (exItem.wclItemNo ?? null) === (it.wclItemNo ?? null) &&
          (exItem.ctnNo ?? null) === (it.ctnNo ?? null) &&
          (exItem.dateCode ?? null) === (it.dateCode ?? null) &&
          (exItem.lotCode ?? null) === (it.lotCode ?? null) &&
          (exItem.coo ?? null) === (it.coo ?? null) &&
          (exItem.cow ?? null) === (it.cow ?? null) &&
          (exItem.subInventoryCode ?? null) === (it.subInventoryCode ?? null);
        if (!same) {
          // Expected-side fields only — derived state stays untouched.
          await queryRun(
            tx,
            sql`UPDATE receiving_invoice_items SET line_qty = ${it.lineQty}, wcl_item_no = ${it.wclItemNo ?? null},
                  ctn_no = ${it.ctnNo ?? null}, date_code = ${it.dateCode ?? null}, lot_code = ${it.lotCode ?? null},
                  coo = ${it.coo ?? null}, cow = ${it.cow ?? null},
                  sub_inventory_code = ${it.subInventoryCode ?? null}
                WHERE id = ${exItem.id}`
          );
          changed = true;
        }
      }
      // Lines missing from the payload are removed (guarded).
      for (const leftover of byKey.values()) {
        if (locked) throw new HTTPException(409, { message: `cannot_remove_line_once_${status}` });
        if (itemWorkStarted(leftover)) {
          throw new HTTPException(409, { message: "cannot_remove_line_after_work_started" });
        }
        await queryRun(tx, sql`DELETE FROM receiving_invoice_items WHERE id = ${leftover.id}`);
        changed = true;
      }
    }

    // Invoices missing from the payload are removed (cascade deletes items).
    for (const ex of existingInvoices) {
      if (seenInvoiceIds.has(ex.id)) continue;
      if (locked) throw new HTTPException(409, { message: `cannot_remove_invoice_once_${status}` });
      const invItems = existingItems.filter((i) => i.receivingInvoiceId === ex.id);
      if (invItems.some(itemWorkStarted)) {
        throw new HTTPException(409, { message: "cannot_remove_invoice_after_work_started" });
      }
      await queryRun(tx, sql`DELETE FROM receiving_invoices WHERE id = ${ex.id}`);
      changed = true;
    }

    if (changed) {
      await queryRun(tx, sql`UPDATE receiving_orders SET last_update_date = ${now()} WHERE id = ${orderId}`);
      await emitEvent(tx, {
        type: "receiving_order.upserted",
        topics: ["/receiving-orders"],
        data: { id: orderId, batchNo },
      });
    }
    return { id: orderId, created: false, changed, orderStatus: status };
  });
}

/**
 * Whole-order delete (DocPal cancellation), keyed by batch_no. Only a pending
 * order with no work started on any line is deletable — same guards as the
 * reconcile line/invoice removals (pending + no work implies nothing
 * downstream exists). Children cascade (invoices, items, scan labels,
 * allocations.receiving_order_id, put_away_tasks). Returns the deleted id.
 */
export async function deleteReceivingOrder(db: AppDb, batchNo: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM receiving_orders WHERE batch_no = ${batchNo} LIMIT 1`
    );
    if (!order) throw new HTTPException(404, { message: "not_found" });
    if (order.status !== "pending") {
      throw new HTTPException(409, { message: `cannot_delete_once_${order.status}` });
    }
    const worked = await queryGet<{ n: number }>(
      tx,
      sql`SELECT COUNT(*)::int AS n
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${order.id}
            AND (rii.received_qty > 0 OR rii.picked_qty > 0 OR rii.put_away_qty > 0
                 OR EXISTS (SELECT 1 FROM allocations a WHERE a.receiving_invoice_item_id = rii.id)
                 OR EXISTS (SELECT 1 FROM receiving_scan_labels sl WHERE sl.receiving_invoice_item_id = rii.id))`
    );
    if (worked && worked.n > 0) {
      throw new HTTPException(409, { message: "cannot_delete_after_work_started" });
    }
    await queryRun(tx, sql`DELETE FROM receiving_orders WHERE id = ${order.id}`);
    await emitEvent(tx, {
      type: "receiving_order.deleted",
      topics: ["/receiving-orders"],
      data: { id: order.id, batchNo },
    });
    return { id: order.id };
  });
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

function validatePickingBody(body: IngestPickingBody): void {
  if (!body?.order) throw new HTTPException(400, { message: "order is required" });
  assertValidSuppliedId(body.order.id);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HTTPException(400, { message: "items[] is required" });
  }
  for (const it of body.items) {
    if (!it.partNo) throw new HTTPException(400, { message: "partNo is required" });
    assertValidSuppliedId(it.id);
    if (!Number.isInteger(it.qty) || it.qty < 0) {
      throw new HTTPException(400, { message: "qty must be a non-negative integer" });
    }
    for (const f of ["lineId", "lineNumber", "shipmentNumber"] as const) {
      if (!Number.isInteger(it[f])) {
        throw new HTTPException(400, { message: `${f} must be an integer` });
      }
    }
  }
}

async function insertPickingItem(tx: DbOrTx, orderId: string, it: IngestPickingItem): Promise<void> {
  const partNo = await assertPartNo(tx, it.partNo);
  await tx.insert(pickingItems).values({
    id: await insertId(tx, "picking_items", it.id),
    pickingOrderId: orderId,
    partNo,
    qty: it.qty,
    lineId: it.lineId,
    lineNumber: it.lineNumber,
    shipmentNumber: it.shipmentNumber,
    additionalData: it.additionalData ?? null,
  });
}

interface ExistingPickingItemRow {
  id: string;
  partNo: string;
  qty: number;
  pickedQty: number;
  allocCount: number;
  lineId: string;
  lineNumber: number;
  shipmentNumber: number;
}

/**
 * Idempotent upsert keyed by order_no (the upstream sync/dedup key), same
 * pattern as receiving: INSERT order + items when new, otherwise reconcile
 * order fields and items by business key (part_no). picked_qty /
 * allocated_qty on existing lines are never written; removals and
 * below-picked qty decreases are guarded like the old ingest.
 */
export async function upsertPickingOrder(
  db: AppDb,
  orderNo: string,
  body: IngestPickingBody
): Promise<IngestUpsertResult> {
  validatePickingBody(body);
  return db.transaction(async (tx) => {
    const customerCode = await resolveCustomerCode(tx, body.order.customerCode);
    const deliveryDate = toDate(body.order.deliveryDate);
    const existing = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM picking_orders WHERE order_no = ${orderNo}`
    );

    if (!existing) {
      const orderId = await insertId(tx, "picking_orders", body.order.id);
      // Slot the new order into the priority queue by (delivery_date ASC
      // NULLS LAST, order_no): bump open orders that sort at-or-after it and
      // take the freed position. Existing (incl. manually reordered) relative
      // order is preserved — everyone just shifts down.
      const pos = (
        await queryGet<{ p: number }>(
          tx,
          sql`SELECT COUNT(*)::int + 1 AS p
              FROM picking_orders
              WHERE status IN ('pending', 'picking')
                AND (
                  (${deliveryDate}::date IS NOT NULL AND delivery_date IS NOT NULL
                    AND (delivery_date, order_no) < (${deliveryDate}, ${orderNo}))
                  OR (${deliveryDate}::date IS NULL AND delivery_date IS NOT NULL)
                  OR (${deliveryDate}::date IS NULL AND delivery_date IS NULL AND order_no < ${orderNo})
                )`
        )
      )!.p;
      await tx.execute(
        sql`UPDATE picking_orders SET priority_seq = priority_seq + 1, last_update_date = ${now()}
            WHERE status IN ('pending', 'picking') AND priority_seq >= ${pos}`
      );
      await tx.insert(pickingOrders).values({
        id: orderId,
        orderNo,
        customerCode,
        poNo: body.order.poNo ?? null,
        shipTo: body.order.shipTo ?? null,
        deliveryDate,
        orgId: body.order.orgId ?? null,
        subInventoryCode: body.order.subInventoryCode ?? null,
        status: "pending",
        prioritySeq: pos,
      });
      for (const it of body.items) {
        await insertPickingItem(tx, orderId, it);
      }
      await emitEvent(tx, {
        type: "picking_order.created",
        topics: ["/picking-orders"],
        data: { id: orderId, orderNo },
      });
      return { id: orderId, created: true, changed: true, orderStatus: "pending" };
    }

    const orderId = existing.id;
    let changed = false;

    const po = (await queryGet<{
      customerCode: string | null;
      poNo: string | null;
      shipTo: string | null;
      orgId: number | null;
      subInventoryCode: string | null;
    }>(
      tx,
      sql`SELECT customer_code AS "customerCode", po_no AS "poNo", ship_to AS "shipTo",
                 org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM picking_orders WHERE id = ${orderId}`
    ))!;
    const orderFields = {
      customerCode,
      poNo: body.order.poNo ?? null,
      shipTo: body.order.shipTo ?? null,
      deliveryDate,
      orgId: body.order.orgId ?? null,
      subInventoryCode: body.order.subInventoryCode ?? null,
    };
    if (
      po.customerCode !== orderFields.customerCode ||
      po.poNo !== orderFields.poNo ||
      po.shipTo !== orderFields.shipTo ||
      (await deliveryDateDiffers(tx, "picking_orders", orderId, orderFields.deliveryDate)) ||
      po.orgId !== orderFields.orgId ||
      po.subInventoryCode !== orderFields.subInventoryCode
    ) {
      await queryRun(
        tx,
        sql`UPDATE picking_orders SET customer_code = ${orderFields.customerCode}, po_no = ${orderFields.poNo},
              ship_to = ${orderFields.shipTo}, delivery_date = ${orderFields.deliveryDate},
              org_id = ${orderFields.orgId}, sub_inventory_code = ${orderFields.subInventoryCode},
              last_update_date = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const existingItems = await queryAll<ExistingPickingItemRow>(
      tx,
      sql`SELECT pi.id, pi.part_no AS "partNo", pi.qty, pi.picked_qty AS "pickedQty",
                 pi.line_id AS "lineId", pi.line_number AS "lineNumber", pi.shipment_number AS "shipmentNumber",
                 (SELECT COUNT(*)::int FROM allocations a WHERE a.picking_item_id = pi.id) AS "allocCount"
          FROM picking_items pi WHERE pi.picking_order_id = ${orderId}`
    );
    const byKey = new Map(existingItems.map((e) => [e.partNo, e]));

    for (const it of body.items) {
      const partNo = await assertPartNo(tx, it.partNo);
      const ex = byKey.get(partNo);
      if (!ex) {
        await insertPickingItem(tx, orderId, it);
        changed = true;
        continue;
      }
      byKey.delete(partNo);
      if (it.qty < ex.pickedQty) {
        throw new HTTPException(409, { message: `qty_below_picked: ${it.qty} < ${ex.pickedQty}` });
      }
      if (
        ex.qty !== it.qty ||
        ex.lineId !== String(it.lineId) ||
        ex.lineNumber !== it.lineNumber ||
        ex.shipmentNumber !== it.shipmentNumber
      ) {
        // Expected-side fields only — picked_qty / allocated_qty stay untouched.
        await queryRun(
          tx,
          sql`UPDATE picking_items SET qty = ${it.qty}, line_id = ${it.lineId},
                line_number = ${it.lineNumber}, shipment_number = ${it.shipmentNumber},
                last_update_date = ${now()}
              WHERE id = ${ex.id}`
        );
        changed = true;
      }
    }
    // Lines missing from the payload are removed (guarded).
    for (const leftover of byKey.values()) {
      if (leftover.allocCount > 0 || leftover.pickedQty > 0) {
        throw new HTTPException(409, { message: "cannot_remove_line_after_work_started" });
      }
      await queryRun(tx, sql`DELETE FROM picking_items WHERE id = ${leftover.id}`);
      changed = true;
    }

    if (changed) {
      await queryRun(tx, sql`UPDATE picking_orders SET last_update_date = ${now()} WHERE id = ${orderId}`);
      await emitEvent(tx, {
        type: "picking_order.updated",
        topics: ["/picking-orders"],
        data: { id: orderId, orderNo },
      });
    }
    return { id: orderId, created: false, changed, orderStatus: existing.status };
  });
}

/**
 * Whole-order delete (DocPal cancellation), keyed by order_no. Only a pending
 * order with no work started (picked_qty > 0 or allocation links on any line)
 * is deletable — the guard implies no packages/shipping_boxes exist, so the
 * children all cascade (picking_items, picking_packages, allocations).
 * priority_seq is NOT compacted — gaps are harmless (ordering is by seq
 * value). Returns the deleted id.
 */
export async function deletePickingOrder(db: AppDb, orderNo: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM picking_orders WHERE order_no = ${orderNo} LIMIT 1`
    );
    if (!order) throw new HTTPException(404, { message: "not_found" });
    if (order.status !== "pending") {
      throw new HTTPException(409, { message: `cannot_delete_once_${order.status}` });
    }
    const worked = await queryGet<{ n: number }>(
      tx,
      sql`SELECT COUNT(*)::int AS n
          FROM picking_items pi
          WHERE pi.picking_order_id = ${order.id}
            AND (pi.picked_qty > 0
                 OR EXISTS (SELECT 1 FROM allocations a WHERE a.picking_item_id = pi.id))`
    );
    if (worked && worked.n > 0) {
      throw new HTTPException(409, { message: "cannot_delete_after_work_started" });
    }
    await queryRun(tx, sql`DELETE FROM picking_orders WHERE id = ${order.id}`);
    await emitEvent(tx, {
      type: "picking_order.deleted",
      topics: ["/picking-orders"],
      data: { id: order.id, orderNo },
    });
    return { id: order.id };
  });
}

// ---------------------------------------------------------------------------
// Master data (parts / suppliers / supplier_profiles / sub_inventories)
// ---------------------------------------------------------------------------
// Same upsert/delete pattern as the order ingests, keyed by the master rows'
// natural keys. No app_events — the admin master-data CRUD (routes/admin/
// crud.ts) emits none either; the sync_events DB triggers already record these
// writes for the external sync service.

export interface MasterDataUpsertResult {
  id: string;
  created: boolean;
  changed: boolean;
}

export interface IngestPart {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  brand: string;
  wclItemNo?: string | null;
  description?: string | null;
  defaultCoo?: string | null;
}

export interface IngestSupplier {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  name: string;
  shortName?: string | null;
}

export interface IngestSupplierProfile {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  name?: string | null;
  qrTemplate?: string | null;
  qrTemplateConfig?: unknown;
  qrType?: string | null;
  qtyEncoding?: string | null;
  remark?: string | null;
}

export interface IngestSubInventory {
  /** Optional caller-supplied UUID — used on the INSERT path only. */
  id?: string;
  subinvDescription?: string | null;
  officeCode?: string | null;
  organizationId?: number | null;
  customerCode?: string | null;
}

/** Postgres FK violation (23503) on a master-data delete → 409 cannot_delete_referenced. */
function mapFkViolation(e: unknown): never {
  const err = e as { code?: string; cause?: { code?: string } };
  if ((err?.code ?? err?.cause?.code) === "23503") {
    throw new HTTPException(409, { message: "cannot_delete_referenced" });
  }
  throw e;
}

/** jsonb param for raw SQL: JSON-stringified (null stays null). */
function jsonbParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Idempotent upsert keyed by part_no. A supplied id is INSERT-only. */
export async function upsertPart(db: AppDb, partNo: string, body: IngestPart): Promise<MasterDataUpsertResult> {
  if (!body?.brand) throw new HTTPException(400, { message: "brand is required" });
  assertValidSuppliedId(body.id);
  return db.transaction(async (tx) => {
    const fields = {
      brand: body.brand,
      wclItemNo: body.wclItemNo ?? null,
      description: body.description ?? null,
      defaultCoo: body.defaultCoo ?? null,
    };
    const existing = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id,
                 NOT (brand IS NOT DISTINCT FROM ${fields.brand}) AS "dBrand",
                 NOT (wcl_item_no IS NOT DISTINCT FROM ${fields.wclItemNo}) AS "dWcl",
                 NOT (description IS NOT DISTINCT FROM ${fields.description}) AS "dDesc",
                 NOT (default_coo IS NOT DISTINCT FROM ${fields.defaultCoo}) AS "dCoo"
          FROM parts WHERE part_no = ${partNo}`
    );
    if (!existing) {
      const id = await insertId(tx, "parts", body.id);
      await tx.insert(parts).values({ id, partNo, ...fields });
      return { id, created: true, changed: true };
    }
    const d = existing as unknown as Record<string, unknown>;
    if (d.dBrand || d.dWcl || d.dDesc || d.dCoo) {
      await queryRun(
        tx,
        sql`UPDATE parts SET brand = ${fields.brand}, wcl_item_no = ${fields.wclItemNo},
                  description = ${fields.description}, default_coo = ${fields.defaultCoo},
                  last_update_date = ${now()}
            WHERE id = ${existing.id}`
      );
      return { id: existing.id, created: false, changed: true };
    }
    return { id: existing.id, created: false, changed: false };
  });
}

/** Delete keyed by part_no; 23503 (referenced anywhere) → 409 cannot_delete_referenced. */
export async function deletePart(db: AppDb, partNo: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM parts WHERE part_no = ${partNo}`);
    if (!row) throw new HTTPException(404, { message: "not_found" });
    try {
      await queryRun(tx, sql`DELETE FROM parts WHERE id = ${row.id}`);
    } catch (e) {
      mapFkViolation(e);
    }
    return { id: row.id };
  });
}

/** Idempotent upsert keyed by code. A supplied id is INSERT-only. */
export async function upsertSupplier(db: AppDb, code: string, body: IngestSupplier): Promise<MasterDataUpsertResult> {
  if (!body?.name) throw new HTTPException(400, { message: "name is required" });
  assertValidSuppliedId(body.id);
  return db.transaction(async (tx) => {
    const fields = { name: body.name, shortName: body.shortName ?? null };
    const existing = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id,
                 NOT (name IS NOT DISTINCT FROM ${fields.name}) AS "dName",
                 NOT (short_name IS NOT DISTINCT FROM ${fields.shortName}) AS "dShort"
          FROM suppliers WHERE code = ${code}`
    );
    if (!existing) {
      const id = await insertId(tx, "suppliers", body.id);
      await tx.insert(suppliers).values({ id, code, ...fields });
      return { id, created: true, changed: true };
    }
    const d = existing as unknown as Record<string, unknown>;
    if (d.dName || d.dShort) {
      await queryRun(
        tx,
        sql`UPDATE suppliers SET name = ${fields.name}, short_name = ${fields.shortName},
                  last_update_date = ${now()}
            WHERE id = ${existing.id}`
      );
      return { id: existing.id, created: false, changed: true };
    }
    return { id: existing.id, created: false, changed: false };
  });
}

/** Delete keyed by code; 23503 (orders/profile reference it) → 409 cannot_delete_referenced. */
export async function deleteSupplier(db: AppDb, code: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM suppliers WHERE code = ${code}`);
    if (!row) throw new HTTPException(404, { message: "not_found" });
    try {
      await queryRun(tx, sql`DELETE FROM suppliers WHERE id = ${row.id}`);
    } catch (e) {
      mapFkViolation(e);
    }
    return { id: row.id };
  });
}

/**
 * Idempotent upsert keyed by supplier_code (FK → suppliers.code; 400
 * unknown_supplier when the supplier does not exist). A supplied id is
 * INSERT-only.
 */
export async function upsertSupplierProfile(
  db: AppDb,
  supplierCode: string,
  body: IngestSupplierProfile
): Promise<MasterDataUpsertResult> {
  assertValidSuppliedId(body?.id);
  return db.transaction(async (tx) => {
    // supplierCode comes from the path — assertSupplierCode returns it or throws.
    const code = (await assertSupplierCode(tx, supplierCode))!;
    const cfg = jsonbParam(body.qrTemplateConfig);
    const existing = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id,
                 NOT (name IS NOT DISTINCT FROM ${body.name ?? null}) AS "dName",
                 NOT (qr_template IS NOT DISTINCT FROM ${body.qrTemplate ?? null}) AS "dTpl",
                 NOT (qr_template_config IS NOT DISTINCT FROM ${cfg}::jsonb) AS "dCfg",
                 NOT (qr_type IS NOT DISTINCT FROM ${body.qrType ?? null}) AS "dType",
                 NOT (qty_encoding IS NOT DISTINCT FROM ${body.qtyEncoding ?? null}) AS "dQty",
                 NOT (remark IS NOT DISTINCT FROM ${body.remark ?? null}) AS "dRemark"
          FROM supplier_profiles WHERE supplier_code = ${code}`
    );
    if (!existing) {
      const id = await insertId(tx, "supplier_profiles", body.id);
      await tx.insert(supplierProfiles).values({
        id,
        supplierCode: code,
        name: body.name ?? null,
        qrTemplate: body.qrTemplate ?? null,
        qrTemplateConfig: body.qrTemplateConfig ?? null,
        qrType: body.qrType ?? null,
        qtyEncoding: body.qtyEncoding ?? null,
        remark: body.remark ?? null,
      });
      return { id, created: true, changed: true };
    }
    const d = existing as unknown as Record<string, unknown>;
    if (d.dName || d.dTpl || d.dCfg || d.dType || d.dQty || d.dRemark) {
      await queryRun(
        tx,
        sql`UPDATE supplier_profiles SET name = ${body.name ?? null}, qr_template = ${body.qrTemplate ?? null},
                  qr_template_config = ${cfg}::jsonb, qr_type = ${body.qrType ?? null},
                  qty_encoding = ${body.qtyEncoding ?? null}, remark = ${body.remark ?? null},
                  last_update_date = ${now()}
            WHERE id = ${existing.id}`
      );
      return { id: existing.id, created: false, changed: true };
    }
    return { id: existing.id, created: false, changed: false };
  });
}

/** Delete keyed by supplier_code; 404 when no profile exists. */
export async function deleteSupplierProfile(db: AppDb, supplierCode: string): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const row = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM supplier_profiles WHERE supplier_code = ${supplierCode}`
    );
    if (!row) throw new HTTPException(404, { message: "not_found" });
    try {
      await queryRun(tx, sql`DELETE FROM supplier_profiles WHERE id = ${row.id}`);
    } catch (e) {
      mapFkViolation(e);
    }
    return { id: row.id };
  });
}

/**
 * Idempotent upsert keyed by the path pair (orgId, code) →
 * (org_id, secondary_inventory_name). customerCode resolves to
 * customer_profiles.code (400 unknown_customer). A supplied id is INSERT-only.
 */
export async function upsertSubInventory(
  db: AppDb,
  orgIdParam: string,
  code: string,
  body: IngestSubInventory
): Promise<MasterDataUpsertResult> {
  const orgId = Number(orgIdParam);
  if (!Number.isInteger(orgId)) throw new HTTPException(400, { message: "invalid_org_id" });
  if (!code) throw new HTTPException(400, { message: "code is required" });
  assertValidSuppliedId(body?.id);
  if (body.organizationId !== undefined && body.organizationId !== null && !Number.isInteger(body.organizationId)) {
    throw new HTTPException(400, { message: "organizationId must be an integer" });
  }
  return db.transaction(async (tx) => {
    const customerCode = await resolveCustomerCode(tx, body.customerCode);
    const fields = {
      subinvDescription: body.subinvDescription ?? null,
      officeCode: body.officeCode ?? null,
      organizationId: body.organizationId ?? null,
      customerCode,
    };
    const existing = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id,
                 NOT (subinv_description IS NOT DISTINCT FROM ${fields.subinvDescription}) AS "dDesc",
                 NOT (office_code IS NOT DISTINCT FROM ${fields.officeCode}) AS "dOffice",
                 NOT (organization_id IS NOT DISTINCT FROM ${fields.organizationId}) AS "dOrg",
                 NOT (customer_code IS NOT DISTINCT FROM ${fields.customerCode}) AS "dCust"
          FROM sub_inventories WHERE org_id = ${orgId} AND secondary_inventory_name = ${code}`
    );
    if (!existing) {
      const id = await insertId(tx, "sub_inventories", body.id);
      await tx.insert(subInventories).values({
        id,
        orgId,
        secondaryInventoryName: code,
        ...fields,
      });
      return { id, created: true, changed: true };
    }
    const d = existing as unknown as Record<string, unknown>;
    if (d.dDesc || d.dOffice || d.dOrg || d.dCust) {
      await queryRun(
        tx,
        sql`UPDATE sub_inventories SET subinv_description = ${fields.subinvDescription},
                  office_code = ${fields.officeCode}, organization_id = ${fields.organizationId},
                  customer_code = ${fields.customerCode}, last_update_date = ${now()}
            WHERE id = ${existing.id}`
      );
      return { id: existing.id, created: false, changed: true };
    }
    return { id: existing.id, created: false, changed: false };
  });
}

/** Delete keyed by (orgId, code); 23503 (stock/doc FKs) → 409 cannot_delete_referenced. */
export async function deleteSubInventory(db: AppDb, orgIdParam: string, code: string): Promise<{ id: string }> {
  const orgId = Number(orgIdParam);
  if (!Number.isInteger(orgId)) throw new HTTPException(400, { message: "invalid_org_id" });
  return db.transaction(async (tx) => {
    const row = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM sub_inventories WHERE org_id = ${orgId} AND secondary_inventory_name = ${code}`
    );
    if (!row) throw new HTTPException(404, { message: "not_found" });
    try {
      await queryRun(tx, sql`DELETE FROM sub_inventories WHERE id = ${row.id}`);
    } catch (e) {
      mapFkViolation(e);
    }
    return { id: row.id };
  });
}
