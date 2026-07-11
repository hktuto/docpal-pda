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

function upsertInvoice(
  tx: DbOrTx, orderId: string, inv: ReceivingPutInvoice, fallbackSupplierId: string | null
): { id: string; changed: boolean } {
  const supplierId = inv.supplier_code !== undefined ? resolveSupplierId(tx, inv.supplier_code) : fallbackSupplierId;
  const existing = tx.get<{ id: string; supplierId: string | null }>(
    sql`SELECT id, supplier_id AS supplierId FROM receiving_invoices WHERE receiving_order_id = ${orderId} AND invoice_no = ${inv.invoice_no}`
  );
  if (existing) {
    if (existing.supplierId !== supplierId) {
      tx.run(sql`UPDATE receiving_invoices SET supplier_id = ${supplierId}, updated_at = ${now()} WHERE id = ${existing.id}`);
      return { id: existing.id, changed: true };
    }
    return { id: existing.id, changed: false };
  }
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
        VALUES (${id}, ${orderId}, ${inv.invoice_no}, ${supplierId}, ${now()}, ${now()})`
  );
  return { id, changed: true };
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
      const { id: invoiceId } = upsertInvoice(tx, orderId, inv, orderSupplierId);
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

interface ExistingItem {
  id: string; invoiceId: string; lineNo: number; partId: string; qty: number;
  boxId: string | null; dateCodeNorm: string | null; lotCodeNorm: string | null;
  cooNorm: string | null; cowNorm: string | null;
  receivedQty: number; pickedQty: number; putAwayQty: number; allocLinks: number;
}

function loadExistingItems(tx: DbOrTx, orderId: string): ExistingItem[] {
  return tx.all<ExistingItem>(sql`
    SELECT rii.id, ri.id AS invoiceId, rii.line_no AS lineNo, rii.part_id AS partId, rii.qty,
           rii.box_id AS boxId, rii.date_code_norm AS dateCodeNorm, rii.lot_code_norm AS lotCodeNorm,
           rii.coo_norm AS cooNorm, rii.cow_norm AS cowNorm,
           rii.received_qty AS receivedQty, rii.picked_qty AS pickedQty, rii.put_away_qty AS putAwayQty,
           (SELECT COUNT(*) FROM allocation_receiving_items ari WHERE ari.receiving_invoice_item_id = rii.id) AS allocLinks
    FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId}`);
}

function reconcileReceivingOrder(
  tx: DbOrTx, orderId: string, status: string, body: ReceivingPutBody, orderSupplierId: string | null
): ReceivingUpsertResult {
  let changed = false;
  const ro = tx.get<{ refNo: string; deliveryDate: string | null; supplierId: string | null }>(
    sql`SELECT ref_no AS refNo, delivery_date AS deliveryDate, supplier_id AS supplierId FROM receiving_orders WHERE id = ${orderId}`
  )!;
  const newDelivery = body.order.delivery_date ?? null;
  if (ro.refNo !== body.order.ref_no || ro.deliveryDate !== newDelivery || ro.supplierId !== orderSupplierId) {
    tx.run(sql`UPDATE receiving_orders SET ref_no = ${body.order.ref_no}, delivery_date = ${newDelivery},
               supplier_id = ${orderSupplierId}, updated_at = ${now()} WHERE id = ${orderId}`);
    changed = true;
  }

  const locked = status !== "pending";
  const existingItems = loadExistingItems(tx, orderId);
  const seenKeys = new Set<string>();

  for (const inv of body.invoices) {
    const invRes = upsertInvoice(tx, orderId, inv, orderSupplierId);
    const invoiceId = invRes.id;
    if (invRes.changed) changed = true;
    for (const it of inv.items) {
      const key = `${invoiceId}:${it.line_no}`;
      seenKeys.add(key);
      const partId = resolveOrCreatePart(tx, it.part_no, it.description);
      const n = itemNorms(it);
      const ex = existingItems.find((e) => e.invoiceId === invoiceId && e.lineNo === it.line_no);

      if (!ex) {
        tx.run(
          sql`INSERT INTO receiving_invoice_items
              (id, receiving_invoice_id, part_id, qty, box_id, date_code, lot_code, coo, cow,
               date_code_norm, lot_code_norm, coo_norm, cow_norm, line_no, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${invoiceId}, ${partId}, ${it.qty}, ${it.box_id ?? null},
                      ${n.dateCode}, ${n.lotCode}, ${n.coo}, ${n.cow}, ${n.dateCodeNorm}, ${n.lotCodeNorm},
                      ${n.cooNorm}, ${n.cowNorm}, ${it.line_no}, ${now()}, ${now()})`
        );
        changed = true;
        continue;
      }

      if (it.qty < ex.qty) {
        if (locked) throw new HTTPException(409, { message: `invoice ${inv.invoice_no} line ${it.line_no}: qty may only increase once ${status}` });
        if (ex.allocLinks > 0 || ex.receivedQty > 0 || ex.pickedQty > 0 || ex.putAwayQty > 0)
          throw new HTTPException(409, { message: `invoice ${inv.invoice_no} line ${it.line_no}: cannot decrease qty after work started` });
      }
      const same =
        ex.partId === partId && ex.qty === it.qty && (ex.boxId ?? null) === (it.box_id ?? null) &&
        ex.dateCodeNorm === n.dateCodeNorm && ex.lotCodeNorm === n.lotCodeNorm &&
        ex.cooNorm === n.cooNorm && ex.cowNorm === n.cowNorm;
      if (!same) {
        tx.run(
          sql`UPDATE receiving_invoice_items SET part_id = ${partId}, qty = ${it.qty}, box_id = ${it.box_id ?? null},
              date_code = ${n.dateCode}, lot_code = ${n.lotCode}, coo = ${n.coo}, cow = ${n.cow},
              date_code_norm = ${n.dateCodeNorm}, lot_code_norm = ${n.lotCodeNorm}, coo_norm = ${n.cooNorm},
              cow_norm = ${n.cowNorm}, updated_at = ${now()} WHERE id = ${ex.id}`
        );
        changed = true;
      }
    }
  }

  for (const ex of existingItems) {
    const key = `${ex.invoiceId}:${ex.lineNo}`;
    if (seenKeys.has(key)) continue;
    if (locked) throw new HTTPException(409, { message: `cannot remove a line once ${status}` });
    if (ex.allocLinks > 0 || ex.receivedQty > 0 || ex.pickedQty > 0 || ex.putAwayQty > 0)
      throw new HTTPException(409, { message: "cannot remove a line after work started" });
    tx.run(sql`DELETE FROM receiving_invoice_items WHERE id = ${ex.id}`);
    changed = true;
  }

  if (changed) tx.run(sql`UPDATE receiving_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
  return { orderId, created: false, changed };
}
