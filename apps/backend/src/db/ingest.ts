import { randomUUID } from "node:crypto";
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
} from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Ingest upserts (server-to-server sync; plan decision 6 — no ledger rows).
// Ported from apps/api/src/ingest/{receiving,picking}.ts: idempotent upserts
// keyed by external_id, with the old O(n²) line scan replaced by business-key
// map reconciles (invoices by invoice_no, receiving items by
// part+po_no+po_line, picking items by part+required_date_code).
// Derived state (received_qty / picked_qty / put_away_qty / allocated_qty /
// mismatch flags) is never written here.
// ---------------------------------------------------------------------------

export interface IngestUpsertResult {
  id: string;
  externalId: string;
  created: boolean;
  changed: boolean;
  /** Order status after the upsert — the route uses it to decide on allocateAll. */
  orderStatus: string;
}

// --- payload types (camelCase, per the API conventions) ----------------------

export interface IngestReceivingOrder {
  refNo: string;
  supplierCode?: string | null;
  supplierId?: string | null;
  deliveryDate?: string | null;
  dateCode?: string | null;
  warehouseSectionCode?: string | null;
  subInventoryCode: string;
}

export interface IngestReceivingItem {
  partNo?: string | null;
  partId?: string | null;
  wclItemNo?: string | null;
  poNo?: string | null;
  poLine?: string | null;
  qty: number;
  boxId?: string | null;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

export interface IngestReceivingInvoice {
  invoiceNo: string;
  supplierCode?: string | null;
  supplierId?: string | null;
  wclCompanyName?: string | null;
  totalQty?: number | null;
  totalCtn?: number | null;
  deliveryDate?: string | null;
  orgId?: number | null;
  warehouseSectionCode?: string | null;
  subInventoryCode?: string | null;
  items: IngestReceivingItem[];
}

export interface IngestReceivingBody {
  order: IngestReceivingOrder;
  invoices: IngestReceivingInvoice[];
}

export interface IngestPickingOrder {
  refNo: string;
  poNo?: string | null;
  shipTo?: string | null;
  destinationCountry?: string | null;
  customerCode?: string | null;
  requiredDateCodeNotice?: string | null;
  deliveryDate?: string | null;
  warehouseSectionCode?: string | null;
  subInventoryCode?: string | null;
  supplierCode?: string | null;
  supplierId?: string | null;
}

export interface IngestPickingItem {
  partNo?: string | null;
  partId?: string | null;
  qty: number;
  requiredDateCode?: string | null;
  sourceShelfCode?: string | null;
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

/** supplierId given directly wins; otherwise resolve supplierCode → suppliers.id. */
async function resolveSupplierId(
  tx: DbOrTx,
  supplierId: string | null | undefined,
  supplierCode: string | null | undefined
): Promise<string | null> {
  if (supplierId) {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM suppliers WHERE id = ${supplierId}`);
    if (!row) throw new HTTPException(400, { message: `unknown_supplier: ${supplierId}` });
    return row.id;
  }
  if (supplierCode) {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM suppliers WHERE code = ${supplierCode}`);
    if (!row) throw new HTTPException(400, { message: `unknown_supplier: ${supplierCode}` });
    return row.id;
  }
  return null;
}

/** partId given directly wins; otherwise resolve partNo → parts.id. */
async function resolvePartId(
  tx: DbOrTx,
  partId: string | null | undefined,
  partNo: string | null | undefined
): Promise<string> {
  if (partId) {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM parts WHERE id = ${partId}`);
    if (!row) throw new HTTPException(400, { message: `unknown_part: ${partId}` });
    return row.id;
  }
  if (partNo) {
    const row = await queryGet<{ id: string }>(tx, sql`SELECT id FROM parts WHERE part_no = ${partNo}`);
    if (!row) throw new HTTPException(400, { message: `unknown_part: ${partNo}` });
    return row.id;
  }
  throw new HTTPException(400, { message: "partNo or partId is required" });
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
const receivingItemKey = (partId: string, poNo: string | null, poLine: string | null) =>
  `${partId}|${poNo ?? ""}|${poLine ?? ""}`;
const pickingItemKey = (partId: string, requiredDateCode: string | null) =>
  `${partId}|${requiredDateCode ?? ""}`;

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function validateReceivingBody(body: IngestReceivingBody): void {
  if (!body?.order?.refNo) throw new HTTPException(400, { message: "order.refNo is required" });
  if (!body.order.subInventoryCode) throw new HTTPException(400, { message: "order.subInventoryCode is required" });
  if (!Array.isArray(body.invoices) || body.invoices.length === 0) {
    throw new HTTPException(400, { message: "invoices[] is required" });
  }
  for (const inv of body.invoices) {
    if (!inv.invoiceNo) throw new HTTPException(400, { message: "invoiceNo is required" });
    if (!Array.isArray(inv.items) || inv.items.length === 0) {
      throw new HTTPException(400, { message: `invoice ${inv.invoiceNo}: items[] required` });
    }
    for (const it of inv.items) {
      if (!it.partNo && !it.partId) throw new HTTPException(400, { message: "partNo or partId is required" });
      if (!Number.isInteger(it.qty) || it.qty < 0) {
        throw new HTTPException(400, { message: "qty must be a non-negative integer" });
      }
    }
  }
}

async function insertReceivingItem(tx: DbOrTx, invoiceId: string, it: IngestReceivingItem): Promise<void> {
  const partId = await resolvePartId(tx, it.partId, it.partNo);
  await tx.insert(receivingInvoiceItems).values({
    id: randomUUID(),
    receivingInvoiceId: invoiceId,
    partId,
    wclItemNo: it.wclItemNo ?? null,
    poNo: it.poNo ?? null,
    poLine: it.poLine ?? null,
    qty: it.qty,
    boxId: it.boxId ?? null,
    dateCode: it.dateCode ?? null,
    lotCode: it.lotCode ?? null,
    coo: it.coo ?? null,
    cow: it.cow ?? null,
  });
}

/** Invoice-level supplier wins over the order-level one (old upsertInvoice semantics). */
async function resolveInvoiceSupplierId(
  tx: DbOrTx,
  inv: IngestReceivingInvoice,
  fallbackSupplierId: string | null
): Promise<string | null> {
  return inv.supplierId || inv.supplierCode
    ? resolveSupplierId(tx, inv.supplierId, inv.supplierCode)
    : fallbackSupplierId;
}

async function insertInvoiceWithItems(
  tx: DbOrTx,
  orderId: string,
  inv: IngestReceivingInvoice,
  fallbackSupplierId: string | null
): Promise<string> {
  const supplierId = await resolveInvoiceSupplierId(tx, inv, fallbackSupplierId);
  const invoiceId = randomUUID();
  await tx.insert(receivingInvoices).values({
    id: invoiceId,
    receivingOrderId: orderId,
    invoiceNo: inv.invoiceNo,
    supplierId,
    wclCompanyName: inv.wclCompanyName ?? null,
    totalQty: inv.totalQty ?? null,
    totalCtn: inv.totalCtn ?? null,
    deliveryDate: toDate(inv.deliveryDate),
    orgId: inv.orgId ?? 2,
    warehouseSectionCode: inv.warehouseSectionCode ?? null,
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
  supplierId: string | null;
  wclCompanyName: string | null;
  totalQty: number | null;
  totalCtn: number | null;
  orgId: number;
  warehouseSectionCode: string | null;
  subInventoryCode: string | null;
}

interface ExistingReceivingItemRow {
  id: string;
  receivingInvoiceId: string;
  partId: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  qty: number;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocLinks: number;
}

function itemWorkStarted(it: Pick<ExistingReceivingItemRow, "allocLinks" | "receivedQty" | "pickedQty" | "putAwayQty">): boolean {
  return it.allocLinks > 0 || it.receivedQty > 0 || it.pickedQty > 0 || it.putAwayQty > 0;
}

/**
 * Idempotent upsert keyed by external_id. No existing row → INSERT order +
 * invoices + items (status pending, warehouse_code from the schema default).
 * Existing row → reconcile: order fields when different; invoices by
 * invoice_no (add / update / delete — delete cascades the items); items by
 * business key (part_id + po_no + po_line). Derived state is never touched;
 * qty decreases and line/invoice removals are guarded like the old ingest
 * (blocked once the order is past pending or work has started on the line).
 */
export async function upsertReceivingOrder(
  db: AppDb,
  externalId: string,
  body: IngestReceivingBody
): Promise<IngestUpsertResult> {
  validateReceivingBody(body);
  return db.transaction(async (tx) => {
    const orderSupplierId = await resolveSupplierId(tx, body.order.supplierId, body.order.supplierCode);
    const orderDeliveryDate = toDate(body.order.deliveryDate);
    const existing = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM receiving_orders WHERE external_id = ${externalId}`
    );

    if (!existing) {
      const orderId = randomUUID();
      await tx.insert(receivingOrders).values({
        id: orderId,
        externalId,
        refNo: body.order.refNo,
        supplierId: orderSupplierId,
        deliveryDate: orderDeliveryDate,
        dateCode: body.order.dateCode ?? null,
        warehouseSectionCode: body.order.warehouseSectionCode ?? null,
        subInventoryCode: body.order.subInventoryCode,
        status: "pending",
      });
      for (const inv of body.invoices) {
        await insertInvoiceWithItems(tx, orderId, inv, orderSupplierId);
      }
      return { id: orderId, externalId, created: true, changed: true, orderStatus: "pending" };
    }

    const orderId = existing.id;
    const status = existing.status;
    let changed = false;

    const ro = (await queryGet<{
      refNo: string;
      supplierId: string | null;
      dateCode: string | null;
      warehouseSectionCode: string | null;
      subInventoryCode: string;
    }>(
      tx,
      sql`SELECT ref_no AS "refNo", supplier_id AS "supplierId",
                 date_code AS "dateCode", warehouse_section_code AS "warehouseSectionCode",
                 sub_inventory_code AS "subInventoryCode"
          FROM receiving_orders WHERE id = ${orderId}`
    ))!;
    const orderFields = {
      refNo: body.order.refNo,
      supplierId: orderSupplierId,
      deliveryDate: orderDeliveryDate,
      dateCode: body.order.dateCode ?? null,
      warehouseSectionCode: body.order.warehouseSectionCode ?? null,
      subInventoryCode: body.order.subInventoryCode,
    };
    if (
      ro.refNo !== orderFields.refNo ||
      ro.supplierId !== orderFields.supplierId ||
      (await deliveryDateDiffers(tx, "receiving_orders", orderId, orderFields.deliveryDate)) ||
      ro.dateCode !== orderFields.dateCode ||
      ro.warehouseSectionCode !== orderFields.warehouseSectionCode ||
      ro.subInventoryCode !== orderFields.subInventoryCode
    ) {
      await queryRun(
        tx,
        sql`UPDATE receiving_orders SET ref_no = ${orderFields.refNo}, supplier_id = ${orderFields.supplierId},
              delivery_date = ${orderFields.deliveryDate}, date_code = ${orderFields.dateCode},
              warehouse_section_code = ${orderFields.warehouseSectionCode},
              sub_inventory_code = ${orderFields.subInventoryCode}, updated_at = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const locked = status !== "pending";
    const existingInvoices = await queryAll<ExistingInvoiceRow>(
      tx,
      sql`SELECT id, invoice_no AS "invoiceNo", supplier_id AS "supplierId",
                 wcl_company_name AS "wclCompanyName", total_qty AS "totalQty", total_ctn AS "totalCtn",
                 org_id AS "orgId",
                 warehouse_section_code AS "warehouseSectionCode", sub_inventory_code AS "subInventoryCode"
          FROM receiving_invoices WHERE receiving_order_id = ${orderId}`
    );
    const existingItems = await queryAll<ExistingReceivingItemRow>(
      tx,
      sql`SELECT rii.id, rii.receiving_invoice_id AS "receivingInvoiceId", rii.part_id AS "partId",
                 rii.wcl_item_no AS "wclItemNo", rii.po_no AS "poNo", rii.po_line AS "poLine",
                 rii.qty, rii.box_id AS "boxId", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow,
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
      m.set(receivingItemKey(it.partId, it.poNo, it.poLine), it);
    }

    const seenInvoiceIds = new Set<string>();
    for (const inv of body.invoices) {
      const ex = invoicesByNo.get(inv.invoiceNo);
      if (!ex) {
        await insertInvoiceWithItems(tx, orderId, inv, orderSupplierId);
        changed = true;
        continue;
      }
      seenInvoiceIds.add(ex.id);

      const invoiceSupplierId = await resolveInvoiceSupplierId(tx, inv, orderSupplierId);
      const invFields = {
        supplierId: invoiceSupplierId,
        wclCompanyName: inv.wclCompanyName ?? null,
        totalQty: inv.totalQty ?? null,
        totalCtn: inv.totalCtn ?? null,
        deliveryDate: toDate(inv.deliveryDate),
        orgId: inv.orgId ?? 2,
        warehouseSectionCode: inv.warehouseSectionCode ?? null,
        subInventoryCode: inv.subInventoryCode ?? null,
      };
      if (
        ex.supplierId !== invFields.supplierId ||
        ex.wclCompanyName !== invFields.wclCompanyName ||
        ex.totalQty !== invFields.totalQty ||
        ex.totalCtn !== invFields.totalCtn ||
        (await deliveryDateDiffers(tx, "receiving_invoices", ex.id, invFields.deliveryDate)) ||
        ex.orgId !== invFields.orgId ||
        ex.warehouseSectionCode !== invFields.warehouseSectionCode ||
        ex.subInventoryCode !== invFields.subInventoryCode
      ) {
        await queryRun(
          tx,
          sql`UPDATE receiving_invoices SET supplier_id = ${invFields.supplierId},
                wcl_company_name = ${invFields.wclCompanyName}, total_qty = ${invFields.totalQty},
                total_ctn = ${invFields.totalCtn}, delivery_date = ${invFields.deliveryDate},
                org_id = ${invFields.orgId}, warehouse_section_code = ${invFields.warehouseSectionCode},
                sub_inventory_code = ${invFields.subInventoryCode}, updated_at = ${now()}
              WHERE id = ${ex.id}`
        );
        changed = true;
      }

      const byKey = itemsByInvoice.get(ex.id) ?? new Map<string, ExistingReceivingItemRow>();
      for (const it of inv.items) {
        const partId = await resolvePartId(tx, it.partId, it.partNo);
        const key = receivingItemKey(partId, it.poNo ?? null, it.poLine ?? null);
        const exItem = byKey.get(key);
        if (!exItem) {
          await insertReceivingItem(tx, ex.id, it);
          changed = true;
          continue;
        }
        byKey.delete(key);
        if (it.qty < exItem.qty) {
          if (locked) throw new HTTPException(409, { message: `qty_may_only_increase_once_${status}` });
          if (itemWorkStarted(exItem)) {
            throw new HTTPException(409, { message: "cannot_decrease_qty_after_work_started" });
          }
        }
        const same =
          exItem.qty === it.qty &&
          (exItem.wclItemNo ?? null) === (it.wclItemNo ?? null) &&
          (exItem.boxId ?? null) === (it.boxId ?? null) &&
          (exItem.dateCode ?? null) === (it.dateCode ?? null) &&
          (exItem.lotCode ?? null) === (it.lotCode ?? null) &&
          (exItem.coo ?? null) === (it.coo ?? null) &&
          (exItem.cow ?? null) === (it.cow ?? null);
        if (!same) {
          // Expected-side fields only — derived state stays untouched.
          await queryRun(
            tx,
            sql`UPDATE receiving_invoice_items SET qty = ${it.qty}, wcl_item_no = ${it.wclItemNo ?? null},
                  box_id = ${it.boxId ?? null}, date_code = ${it.dateCode ?? null}, lot_code = ${it.lotCode ?? null},
                  coo = ${it.coo ?? null}, cow = ${it.cow ?? null}
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

    if (changed) await queryRun(tx, sql`UPDATE receiving_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
    return { id: orderId, externalId, created: false, changed, orderStatus: status };
  });
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

function validatePickingBody(body: IngestPickingBody): void {
  if (!body?.order?.refNo) throw new HTTPException(400, { message: "order.refNo is required" });
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HTTPException(400, { message: "items[] is required" });
  }
  for (const it of body.items) {
    if (!it.partNo && !it.partId) throw new HTTPException(400, { message: "partNo or partId is required" });
    if (!Number.isInteger(it.qty) || it.qty < 0) {
      throw new HTTPException(400, { message: "qty must be a non-negative integer" });
    }
  }
}

async function insertPickingItem(tx: DbOrTx, orderId: string, it: IngestPickingItem): Promise<void> {
  const partId = await resolvePartId(tx, it.partId, it.partNo);
  await tx.insert(pickingItems).values({
    id: randomUUID(),
    pickingOrderId: orderId,
    partId,
    qty: it.qty,
    requiredDateCode: it.requiredDateCode ?? null,
    sourceShelfCode: it.sourceShelfCode ?? null,
  });
}

interface ExistingPickingItemRow {
  id: string;
  partId: string;
  qty: number;
  pickedQty: number;
  requiredDateCode: string | null;
  sourceShelfCode: string | null;
  allocCount: number;
}

/**
 * Idempotent upsert keyed by external_id, same pattern as receiving: INSERT
 * order + items when new, otherwise reconcile order fields and items by
 * business key (part_id + required_date_code). picked_qty / allocated_qty on
 * existing lines are never written; removals and below-picked qty decreases
 * are guarded like the old ingest.
 */
export async function upsertPickingOrder(
  db: AppDb,
  externalId: string,
  body: IngestPickingBody
): Promise<IngestUpsertResult> {
  validatePickingBody(body);
  return db.transaction(async (tx) => {
    const supplierId = await resolveSupplierId(tx, body.order.supplierId, body.order.supplierCode);
    const customerCode = await resolveCustomerCode(tx, body.order.customerCode);
    const deliveryDate = toDate(body.order.deliveryDate);
    const existing = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM picking_orders WHERE external_id = ${externalId}`
    );

    if (!existing) {
      const orderId = randomUUID();
      await tx.insert(pickingOrders).values({
        id: orderId,
        externalId,
        refNo: body.order.refNo,
        supplierId,
        customerCode,
        poNo: body.order.poNo ?? null,
        shipTo: body.order.shipTo ?? null,
        destinationCountry: body.order.destinationCountry ?? null,
        requiredDateCodeNotice: body.order.requiredDateCodeNotice ?? null,
        deliveryDate,
        warehouseSectionCode: body.order.warehouseSectionCode ?? null,
        subInventoryCode: body.order.subInventoryCode ?? null,
        status: "pending",
      });
      for (const it of body.items) {
        await insertPickingItem(tx, orderId, it);
      }
      return { id: orderId, externalId, created: true, changed: true, orderStatus: "pending" };
    }

    const orderId = existing.id;
    let changed = false;

    const po = (await queryGet<{
      refNo: string;
      supplierId: string | null;
      customerCode: string | null;
      poNo: string | null;
      shipTo: string | null;
      destinationCountry: string | null;
      requiredDateCodeNotice: string | null;
      warehouseSectionCode: string | null;
      subInventoryCode: string | null;
    }>(
      tx,
      sql`SELECT ref_no AS "refNo", supplier_id AS "supplierId", customer_code AS "customerCode",
                 po_no AS "poNo", ship_to AS "shipTo", destination_country AS "destinationCountry",
                 required_date_code_notice AS "requiredDateCodeNotice",
                 warehouse_section_code AS "warehouseSectionCode", sub_inventory_code AS "subInventoryCode"
          FROM picking_orders WHERE id = ${orderId}`
    ))!;
    const orderFields = {
      refNo: body.order.refNo,
      supplierId,
      customerCode,
      poNo: body.order.poNo ?? null,
      shipTo: body.order.shipTo ?? null,
      destinationCountry: body.order.destinationCountry ?? null,
      requiredDateCodeNotice: body.order.requiredDateCodeNotice ?? null,
      deliveryDate,
      warehouseSectionCode: body.order.warehouseSectionCode ?? null,
      subInventoryCode: body.order.subInventoryCode ?? null,
    };
    if (
      po.refNo !== orderFields.refNo ||
      po.supplierId !== orderFields.supplierId ||
      po.customerCode !== orderFields.customerCode ||
      po.poNo !== orderFields.poNo ||
      po.shipTo !== orderFields.shipTo ||
      po.destinationCountry !== orderFields.destinationCountry ||
      po.requiredDateCodeNotice !== orderFields.requiredDateCodeNotice ||
      (await deliveryDateDiffers(tx, "picking_orders", orderId, orderFields.deliveryDate)) ||
      po.warehouseSectionCode !== orderFields.warehouseSectionCode ||
      po.subInventoryCode !== orderFields.subInventoryCode
    ) {
      await queryRun(
        tx,
        sql`UPDATE picking_orders SET ref_no = ${orderFields.refNo}, supplier_id = ${orderFields.supplierId},
              customer_code = ${orderFields.customerCode}, po_no = ${orderFields.poNo},
              ship_to = ${orderFields.shipTo}, destination_country = ${orderFields.destinationCountry},
              required_date_code_notice = ${orderFields.requiredDateCodeNotice},
              delivery_date = ${orderFields.deliveryDate},
              warehouse_section_code = ${orderFields.warehouseSectionCode},
              sub_inventory_code = ${orderFields.subInventoryCode}, updated_at = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const existingItems = await queryAll<ExistingPickingItemRow>(
      tx,
      sql`SELECT pi.id, pi.part_id AS "partId", pi.qty, pi.picked_qty AS "pickedQty",
                 pi.required_date_code AS "requiredDateCode", pi.source_shelf_code AS "sourceShelfCode",
                 (SELECT COUNT(*)::int FROM allocations a WHERE a.picking_item_id = pi.id) AS "allocCount"
          FROM picking_items pi WHERE pi.picking_order_id = ${orderId}`
    );
    const byKey = new Map(existingItems.map((e) => [pickingItemKey(e.partId, e.requiredDateCode), e]));

    for (const it of body.items) {
      const partId = await resolvePartId(tx, it.partId, it.partNo);
      const key = pickingItemKey(partId, it.requiredDateCode ?? null);
      const ex = byKey.get(key);
      if (!ex) {
        await insertPickingItem(tx, orderId, it);
        changed = true;
        continue;
      }
      byKey.delete(key);
      if (it.qty < ex.pickedQty) {
        throw new HTTPException(409, { message: `qty_below_picked: ${it.qty} < ${ex.pickedQty}` });
      }
      const same = ex.qty === it.qty && (ex.sourceShelfCode ?? null) === (it.sourceShelfCode ?? null);
      if (!same) {
        // Expected-side fields only — picked_qty / allocated_qty stay untouched.
        await queryRun(
          tx,
          sql`UPDATE picking_items SET qty = ${it.qty}, source_shelf_code = ${it.sourceShelfCode ?? null},
                updated_at = ${now()}
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

    if (changed) await queryRun(tx, sql`UPDATE picking_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
    return { id: orderId, externalId, created: false, changed, orderStatus: existing.status };
  });
}
