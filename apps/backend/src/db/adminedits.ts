import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryGet, queryRun } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Admin console edits to flow data (not master data): picking order delivery
// date (TOC 4.2) and receiving invoice item date code (TOC 4.1). Each write
// leaves a transaction_logs audit row (metadata carries field/from/to).
// ---------------------------------------------------------------------------

export const ADMIN_EDIT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function audit(
  db: AppDb,
  entityType: string,
  entityId: string,
  actorId: string | null,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.insert(transactionLogs).values({
    id: newId(),
    entityType,
    entityId,
    fromState: null,
    toState: "admin_edit",
    actorId,
    metadata,
    createdDate: now(),
  });
}

/** Set (or clear with null) the picking order's delivery date. */
export async function updatePickingDeliveryDate(
  db: AppDb,
  input: { orderId: string; deliveryDate: string | null; actorId: string | null }
): Promise<{ id: string; deliveryDate: string | null }> {
  if (input.deliveryDate !== null && !ADMIN_EDIT_DATE_RE.test(input.deliveryDate)) {
    throw new HTTPException(400, { message: "deliveryDate must be YYYY-MM-DD" });
  }
  const existing = await queryGet<{ deliveryDate: string | null }>(
    db,
    sql`SELECT delivery_date::date::text AS "deliveryDate" FROM picking_orders WHERE id = ${input.orderId}`
  );
  if (!existing) throw new HTTPException(404, { message: "picking_order_not_found" });
  await queryRun(
    db,
    sql`UPDATE picking_orders SET delivery_date = ${input.deliveryDate}, last_update_date = ${now()} WHERE id = ${input.orderId}`
  );
  await audit(db, "picking_order", input.orderId, input.actorId, {
    field: "delivery_date",
    from: existing.deliveryDate,
    to: input.deliveryDate,
  });
  return { id: input.orderId, deliveryDate: input.deliveryDate };
}

/** Set (or clear with null) the receiving order's delivery date. */
export async function updateReceivingDeliveryDate(
  db: AppDb,
  input: { orderId: string; deliveryDate: string | null; actorId: string | null }
): Promise<{ id: string; deliveryDate: string | null }> {
  if (input.deliveryDate !== null && !ADMIN_EDIT_DATE_RE.test(input.deliveryDate)) {
    throw new HTTPException(400, { message: "deliveryDate must be YYYY-MM-DD" });
  }
  const existing = await queryGet<{ deliveryDate: string | null }>(
    db,
    sql`SELECT delivery_date::date::text AS "deliveryDate" FROM receiving_orders WHERE id = ${input.orderId}`
  );
  if (!existing) throw new HTTPException(404, { message: "receiving_order_not_found" });
  await queryRun(
    db,
    sql`UPDATE receiving_orders SET delivery_date = ${input.deliveryDate}, last_update_date = ${now()} WHERE id = ${input.orderId}`
  );
  await audit(db, "receiving_order", input.orderId, input.actorId, {
    field: "delivery_date",
    from: existing.deliveryDate,
    to: input.deliveryDate,
  });
  return { id: input.orderId, deliveryDate: input.deliveryDate };
}

/** Editable fields on a receiving invoice item (camelCase → column). */
const RECEIVING_ITEM_FIELDS = {
  dateCode: "date_code",
  lotCode: "lot_code",
  coo: "coo",
  cow: "cow",
  ctnNo: "ctn_no",
} as const;

export type ReceivingItemField = keyof typeof RECEIVING_ITEM_FIELDS;

/** Set (or clear with null) editable fields on one receiving invoice item. */
export async function updateReceivingItemFields(
  db: AppDb,
  input: { itemId: string; fields: Partial<Record<ReceivingItemField, string | null>>; actorId: string | null }
): Promise<{ id: string }> {
  const keys = (Object.keys(RECEIVING_ITEM_FIELDS) as ReceivingItemField[]).filter((k) => k in input.fields);
  if (keys.length === 0) throw new HTTPException(400, { message: "no_fields" });
  const existing = await queryGet<Record<string, string | null>>(
    db,
    sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", date_code AS "dateCode", lot_code AS "lotCode", coo, cow, ctn_no AS "ctnNo" FROM receiving_invoice_items WHERE id = ${input.itemId}`
  );
  if (!existing) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  const itemMeta: Record<string, unknown> = { partNo: existing.partNo };
  if (existing.wclItemNo) itemMeta.wclItemNo = existing.wclItemNo;
  await queryRun(
    db,
    sql`UPDATE receiving_invoice_items SET ${sql.join(
      keys.map((k) => sql`${sql.raw(RECEIVING_ITEM_FIELDS[k])} = ${input.fields[k] ?? null}`),
      sql`, `
    )}, last_update_date = ${now()} WHERE id = ${input.itemId}`
  );
  for (const k of keys) {
    const to = input.fields[k] ?? null;
    if (existing[k] === to) continue;
    await audit(db, "receiving_invoice_item", input.itemId, input.actorId, {
      ...itemMeta,
      field: RECEIVING_ITEM_FIELDS[k],
      from: existing[k],
      to,
    });
  }
  return { id: input.itemId };
}
