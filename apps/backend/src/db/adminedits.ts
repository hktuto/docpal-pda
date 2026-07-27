import { randomUUID } from "node:crypto";
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
    id: randomUUID(),
    entityType,
    entityId,
    fromState: null,
    toState: "admin_edit",
    actorId,
    metadata,
    createdAt: now(),
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
    sql`UPDATE picking_orders SET delivery_date = ${input.deliveryDate}, updated_at = ${now()} WHERE id = ${input.orderId}`
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
    sql`UPDATE receiving_orders SET delivery_date = ${input.deliveryDate}, updated_at = ${now()} WHERE id = ${input.orderId}`
  );
  await audit(db, "receiving_order", input.orderId, input.actorId, {
    field: "delivery_date",
    from: existing.deliveryDate,
    to: input.deliveryDate,
  });
  return { id: input.orderId, deliveryDate: input.deliveryDate };
}

/** Set (or clear with null) one receiving invoice item's date code. */
export async function updateReceivingItemDateCode(
  db: AppDb,
  input: { itemId: string; dateCode: string | null; actorId: string | null }
): Promise<{ id: string; dateCode: string | null }> {
  const existing = await queryGet<{ dateCode: string | null }>(
    db,
    sql`SELECT date_code AS "dateCode" FROM receiving_invoice_items WHERE id = ${input.itemId}`
  );
  if (!existing) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  await queryRun(
    db,
    sql`UPDATE receiving_invoice_items SET date_code = ${input.dateCode} WHERE id = ${input.itemId}`
  );
  await audit(db, "receiving_invoice_item", input.itemId, input.actorId, {
    field: "date_code",
    from: existing.dateCode,
    to: input.dateCode,
  });
  return { id: input.itemId, dateCode: input.dateCode };
}
