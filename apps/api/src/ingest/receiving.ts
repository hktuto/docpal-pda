import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";
import { normalizeCode, normalizePlain } from "../db/schema/normalize.js";
import { resolveOrCreatePart } from "./parts.js";
import { resolveSupplierId } from "./suppliers.js";
import type { ReceivingPutBody, ReceivingPutInvoice, ReceivingPutItem } from "@warehouse/shared";

export interface ReceivingUpsertResult { orderId: string; created: boolean; changed: boolean; }

function validate(body: ReceivingPutBody): void {
  if (!body?.order?.ref_no) throw new HTTPException(400, { message: "order.ref_no is required" });
  if (!Array.isArray(body.invoices) || body.invoices.length === 0)
    throw new HTTPException(400, { message: "invoices[] is required" });
  for (const inv of body.invoices) {
    if (!inv.invoice_no) throw new HTTPException(400, { message: "invoice_no is required" });
    if (!Array.isArray(inv.items) || inv.items.length === 0)
      throw new HTTPException(400, { message: `invoice ${inv.invoice_no}: items[] required` });
    for (const it of inv.items) {
      if (!Number.isInteger(it.line_no)) throw new HTTPException(400, { message: "line_no must be an integer" });
      if (!it.part_no) throw new HTTPException(400, { message: "part_no is required" });
      if (!Number.isInteger(it.qty) || it.qty < 0) throw new HTTPException(400, { message: "qty must be a non-negative integer" });
    }
  }
}

function itemNorms(it: ReceivingPutItem) {
  return {
    dateCode: it.date_code ?? null, lotCode: it.lot_code ?? null, coo: it.coo ?? null, cow: it.cow ?? null,
    dateCodeNorm: normalizeCode(it.date_code), lotCodeNorm: normalizeCode(it.lot_code),
    cooNorm: normalizePlain(it.coo), cowNorm: normalizePlain(it.cow),
  };
}

function upsertInvoice(tx: DbOrTx, orderId: string, inv: ReceivingPutInvoice, fallbackSupplierId: string | null): string {
  const supplierId = inv.supplier_code !== undefined ? resolveSupplierId(tx, inv.supplier_code) : fallbackSupplierId;
  const existing = tx.get<{ id: string }>(
    sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${orderId} AND invoice_no = ${inv.invoice_no}`
  );
  if (existing) {
    tx.run(sql`UPDATE receiving_invoices SET supplier_id = ${supplierId}, updated_at = ${now()} WHERE id = ${existing.id}`);
    return existing.id;
  }
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
        VALUES (${id}, ${orderId}, ${inv.invoice_no}, ${supplierId}, ${now()}, ${now()})`
  );
  return id;
}

export function upsertReceivingOrder(tx: DbOrTx, externalId: string, body: ReceivingPutBody): ReceivingUpsertResult {
  validate(body);
  const orderSupplierId = resolveSupplierId(tx, body.order.supplier_code);
  const existing = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM receiving_orders WHERE external_id = ${externalId}`
  );

  if (!existing) {
    const orderId = crypto.randomUUID();
    tx.run(
      sql`INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
          VALUES (${orderId}, ${externalId}, ${body.order.ref_no}, ${body.order.delivery_date ?? null}, 'pending',
                  ${orderSupplierId}, ${now()}, ${now()})`
    );
    for (const inv of body.invoices) {
      const invoiceId = upsertInvoice(tx, orderId, inv, orderSupplierId);
      for (const it of inv.items) {
        const partId = resolveOrCreatePart(tx, it.part_no, it.description);
        const n = itemNorms(it);
        tx.run(
          sql`INSERT INTO receiving_invoice_items
              (id, receiving_invoice_id, part_id, qty, box_id, date_code, lot_code, coo, cow,
               date_code_norm, lot_code_norm, coo_norm, cow_norm, line_no, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${invoiceId}, ${partId}, ${it.qty}, ${it.box_id ?? null},
                      ${n.dateCode}, ${n.lotCode}, ${n.coo}, ${n.cow}, ${n.dateCodeNorm}, ${n.lotCodeNorm},
                      ${n.cooNorm}, ${n.cowNorm}, ${it.line_no}, ${now()}, ${now()})`
        );
      }
    }
    return { orderId, created: true, changed: true };
  }

  return reconcileReceivingOrder(tx, existing.id, existing.status, body, orderSupplierId);
}

// placeholder so Task 2 compiles; replaced in Task 3.
function reconcileReceivingOrder(
  _tx: DbOrTx, _orderId: string, _status: string, _body: ReceivingPutBody, _orderSupplierId: string | null
): ReceivingUpsertResult {
  throw new Error("reconcileReceivingOrder implemented in Task 3");
}
