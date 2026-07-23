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
  supplierCode?: string | null;
  supplierId?: string | null;
  deliveryDate?: string | null;
  dateCode?: string | null;
  orgId?: number | null;
  /** Required — every receiving order goes into exactly one sub-inventory. */
  subInventoryCode: string;
}

export interface IngestReceivingItem {
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
  subInventoryCode?: string | null;
  items: IngestReceivingItem[];
}

export interface IngestReceivingBody {
  order: IngestReceivingOrder;
  invoices: IngestReceivingInvoice[];
}

export interface IngestPickingOrder {
  poNo?: string | null;
  shipTo?: string | null;
  customerCode?: string | null;
  deliveryDate?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
}

export interface IngestPickingItem {
  partNo: string;
  qty: number;
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

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

function validateReceivingBody(body: IngestReceivingBody): void {
  if (!body?.order) throw new HTTPException(400, { message: "order is required" });
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
      if (!it.partNo) throw new HTTPException(400, { message: "partNo is required" });
      if (!Number.isInteger(it.lineQty) || it.lineQty < 0) {
        throw new HTTPException(400, { message: "lineQty must be a non-negative integer" });
      }
    }
  }
}

async function insertReceivingItem(tx: DbOrTx, invoiceId: string, it: IngestReceivingItem): Promise<void> {
  const partNo = await assertPartNo(tx, it.partNo);
  await tx.insert(receivingInvoiceItems).values({
    id: randomUUID(),
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
 * Existing row →
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
    const orderSupplierId = await resolveSupplierId(tx, body.order.supplierId, body.order.supplierCode);
    const orderDeliveryDate = toDate(body.order.deliveryDate);
    const existing = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT id, status FROM receiving_orders WHERE batch_no = ${batchNo} LIMIT 1`
    );

    if (!existing) {
      const orderId = randomUUID();
      await tx.insert(receivingOrders).values({
        id: orderId,
        batchNo,
        supplierId: orderSupplierId,
        deliveryDate: orderDeliveryDate,
        dateCode: body.order.dateCode ?? null,
        orgId: body.order.orgId ?? 2,
        subInventoryCode: body.order.subInventoryCode,
        status: "pending",
      });
      for (const inv of body.invoices) {
        await insertInvoiceWithItems(tx, orderId, inv, orderSupplierId);
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
      supplierId: string | null;
      dateCode: string | null;
      orgId: number;
      subInventoryCode: string;
    }>(
      tx,
      sql`SELECT supplier_id AS "supplierId", date_code AS "dateCode", org_id AS "orgId",
                 sub_inventory_code AS "subInventoryCode"
          FROM receiving_orders WHERE id = ${orderId}`
    ))!;
    const orderFields = {
      supplierId: orderSupplierId,
      deliveryDate: orderDeliveryDate,
      dateCode: body.order.dateCode ?? null,
      orgId: body.order.orgId ?? 2,
      subInventoryCode: body.order.subInventoryCode,
    };
    if (
      ro.supplierId !== orderFields.supplierId ||
      (await deliveryDateDiffers(tx, "receiving_orders", orderId, orderFields.deliveryDate)) ||
      ro.dateCode !== orderFields.dateCode ||
      ro.orgId !== orderFields.orgId ||
      ro.subInventoryCode !== orderFields.subInventoryCode
    ) {
      await queryRun(
        tx,
        sql`UPDATE receiving_orders SET supplier_id = ${orderFields.supplierId},
              delivery_date = ${orderFields.deliveryDate}, date_code = ${orderFields.dateCode},
              org_id = ${orderFields.orgId}, sub_inventory_code = ${orderFields.subInventoryCode},
              updated_at = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const locked = status !== "pending";
    const existingInvoices = await queryAll<ExistingInvoiceRow>(
      tx,
      sql`SELECT id, invoice_no AS "invoiceNo", supplier_id AS "supplierId",
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
        subInventoryCode: inv.subInventoryCode ?? null,
      };
      if (
        ex.supplierId !== invFields.supplierId ||
        ex.wclCompanyName !== invFields.wclCompanyName ||
        ex.totalQty !== invFields.totalQty ||
        ex.totalCtn !== invFields.totalCtn ||
        (await deliveryDateDiffers(tx, "receiving_invoices", ex.id, invFields.deliveryDate)) ||
        ex.orgId !== invFields.orgId ||
        ex.subInventoryCode !== invFields.subInventoryCode
      ) {
        await queryRun(
          tx,
          sql`UPDATE receiving_invoices SET supplier_id = ${invFields.supplierId},
                wcl_company_name = ${invFields.wclCompanyName}, total_qty = ${invFields.totalQty},
                total_ctn = ${invFields.totalCtn}, delivery_date = ${invFields.deliveryDate},
                org_id = ${invFields.orgId}, sub_inventory_code = ${invFields.subInventoryCode},
                updated_at = ${now()}
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
      await queryRun(tx, sql`UPDATE receiving_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
      await emitEvent(tx, {
        type: "receiving_order.upserted",
        topics: ["/receiving-orders"],
        data: { id: orderId, batchNo },
      });
    }
    return { id: orderId, created: false, changed, orderStatus: status };
  });
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

function validatePickingBody(body: IngestPickingBody): void {
  if (!body?.order) throw new HTTPException(400, { message: "order is required" });
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HTTPException(400, { message: "items[] is required" });
  }
  for (const it of body.items) {
    if (!it.partNo) throw new HTTPException(400, { message: "partNo is required" });
    if (!Number.isInteger(it.qty) || it.qty < 0) {
      throw new HTTPException(400, { message: "qty must be a non-negative integer" });
    }
  }
}

async function insertPickingItem(tx: DbOrTx, orderId: string, it: IngestPickingItem): Promise<void> {
  const partNo = await assertPartNo(tx, it.partNo);
  await tx.insert(pickingItems).values({
    id: randomUUID(),
    pickingOrderId: orderId,
    partNo,
    qty: it.qty,
  });
}

interface ExistingPickingItemRow {
  id: string;
  partNo: string;
  qty: number;
  pickedQty: number;
  allocCount: number;
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
      const orderId = randomUUID();
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
        sql`UPDATE picking_orders SET priority_seq = priority_seq + 1, updated_at = ${now()}
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
              updated_at = ${now()}
            WHERE id = ${orderId}`
      );
      changed = true;
    }

    const existingItems = await queryAll<ExistingPickingItemRow>(
      tx,
      sql`SELECT pi.id, pi.part_no AS "partNo", pi.qty, pi.picked_qty AS "pickedQty",
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
      if (ex.qty !== it.qty) {
        // Expected-side fields only — picked_qty / allocated_qty stay untouched.
        await queryRun(
          tx,
          sql`UPDATE picking_items SET qty = ${it.qty}, updated_at = ${now()}
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
      await queryRun(tx, sql`UPDATE picking_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
      await emitEvent(tx, {
        type: "picking_order.updated",
        topics: ["/picking-orders"],
        data: { id: orderId, orderNo },
      });
    }
    return { id: orderId, created: false, changed, orderStatus: existing.status };
  });
}
