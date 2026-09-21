import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { queryGet } from "./query.js";
import {
  receivingOrders,
  receivingInvoices,
  receivingInvoiceItems,
  pickingOrders,
  pickingItems,
} from "./schema/index.js";

// ---------------------------------------------------------------------------
// Test fixtures: direct inserts of upstream-synced rows (the ingest apply
// layer was removed 2026-09 — tests insert what the external sync service
// would have written). No app_events, no sync_events suppression: these run
// as the normal db role after reseed (whose SET LOCAL suppression is
// tx-scoped and already gone).
// ---------------------------------------------------------------------------

export interface FixtureReceivingItem {
  partNo: string;
  wclItemNo?: string | null;
  poNo?: string | null;
  poLine?: string | null;
  lineQty?: number | null;
  ctnNo?: string | null;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  orgId?: number | null;
  subInventoryCode?: string | null;
  additionalData?: Record<string, unknown> | null;
}

export interface FixtureReceivingInvoice {
  invoiceNo: string;
  supplierCode?: string | null;
  wclCompanyName?: string | null;
  totalQty?: number | null;
  totalCtn?: number | null;
  items: FixtureReceivingItem[];
}

/** Insert a pending receiving order + invoices + items. Returns the order id. */
export async function insertReceivingOrder(
  db: AppDb,
  batchNo: string,
  body: {
    order: { supplierCode?: string | null; deliveryDate?: string | null; dateCode?: string | null; orgId?: number | null };
    invoices: FixtureReceivingInvoice[];
  }
): Promise<string> {
  return db.transaction(async (tx) => {
    const orderId = newId();
    await tx.insert(receivingOrders).values({
      id: orderId,
      batchNo,
      supplierCode: body.order.supplierCode ?? null,
      deliveryDate: body.order.deliveryDate ? new Date(body.order.deliveryDate) : null,
      dateCode: body.order.dateCode ?? null,
      orgId: body.order.orgId ?? 2,
      status: "pending",
    });
    for (const inv of body.invoices) {
      const invoiceId = newId();
      await tx.insert(receivingInvoices).values({
        id: invoiceId,
        receivingOrderId: orderId,
        invoiceNo: inv.invoiceNo,
        supplierCode: inv.supplierCode ?? body.order.supplierCode ?? null,
        wclCompanyName: inv.wclCompanyName ?? null,
        totalQty: inv.totalQty ?? null,
        totalCtn: inv.totalCtn ?? null,
        orgId: 2,
      });
      for (const it of inv.items) {
        await tx.insert(receivingInvoiceItems).values({
          id: newId(),
          receivingInvoiceId: invoiceId,
          partNo: it.partNo,
          wclItemNo: it.wclItemNo ?? null,
          poNo: it.poNo ?? null,
          poLine: it.poLine ?? null,
          lineQty: it.lineQty ?? null,
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
    }
    return orderId;
  });
}

/** Insert a pending picking order + items at the end of the priority queue. */
export async function insertPickingOrder(
  db: AppDb,
  id: string,
  body: {
    order: {
      orderNo: string;
      customerCode?: string | null;
      orgId?: number | null;
      subInventoryCode?: string | null;
    };
    items: { partNo: string; qty: number; lineId?: number | null; lineNumber?: number | null; shipmentNumber?: number | null }[];
  }
): Promise<string> {
  return db.transaction(async (tx) => {
    const pos = (
      await queryGet<{ p: number }>(
        tx,
        sql`SELECT COALESCE(MAX(priority_seq), 0) + 1 AS p FROM picking_orders WHERE status IN ('pending', 'picking')`
      )
    )!.p;
    await tx.insert(pickingOrders).values({
      id,
      orderNo: body.order.orderNo,
      customerCode: body.order.customerCode ?? null,
      orgId: body.order.orgId ?? null,
      subInventoryCode: body.order.subInventoryCode ?? null,
      status: "pending",
      prioritySeq: pos,
    });
    for (const it of body.items) {
      await tx.insert(pickingItems).values({
        id: newId(),
        pickingOrderId: id,
        partNo: it.partNo,
        qty: it.qty,
        lineId: it.lineId ?? null,
        lineNumber: it.lineNumber ?? null,
        shipmentNumber: it.shipmentNumber ?? null,
      });
    }
    return id;
  });
}
