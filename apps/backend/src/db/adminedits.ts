import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { sql, type SQL } from "drizzle-orm";
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

/**
 * Admin edit of a picking order's ship-to text and/or ship-from location pair
 * (org_id + sub_inventory_code, composite FK → org_info). The pair must be set
 * together (both null clears it). A location change makes location-matched
 * allocations stale, so a full recompute is scheduled after the write.
 */
export async function updatePickingOrderFields(
  db: AppDb,
  input: {
    orderId: string;
    shipTo?: string | null;
    orgId?: number | null;
    subInventoryCode?: string | null;
    actorId: string | null;
  }
): Promise<{ id: string }> {
  const hasShipTo = input.shipTo !== undefined;
  const hasLocation = input.orgId !== undefined || input.subInventoryCode !== undefined;
  if (!hasShipTo && !hasLocation) throw new HTTPException(400, { message: "no_fields" });
  if (hasLocation && (input.orgId === undefined || input.subInventoryCode === undefined)) {
    throw new HTTPException(400, { message: "orgId and subInventoryCode must be set together" });
  }
  if (hasLocation && (input.orgId === null) !== (input.subInventoryCode === null)) {
    throw new HTTPException(400, { message: "orgId and subInventoryCode must be set together" });
  }
  const existing = await queryGet<{ shipTo: string | null; orgId: number | null; subInventoryCode: string | null }>(
    db,
    sql`SELECT ship_to AS "shipTo", org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM picking_orders WHERE id = ${input.orderId}`
  );
  if (!existing) throw new HTTPException(404, { message: "picking_order_not_found" });
  if (hasLocation && input.orgId !== null && input.subInventoryCode !== null) {
    const pair = await queryGet<{ orgId: number }>(
      db,
      sql`SELECT org_id AS "orgId" FROM org_info
          WHERE org_id = ${input.orgId} AND secondary_inventory_name = ${input.subInventoryCode}`
    );
    if (!pair) throw new HTTPException(400, { message: "invalid_sub_inventory" });
  }
  const sets: SQL[] = [];
  if (hasShipTo) sets.push(sql`ship_to = ${input.shipTo ?? null}`);
  if (hasLocation) {
    sets.push(sql`org_id = ${input.orgId ?? null}`);
    sets.push(sql`sub_inventory_code = ${input.subInventoryCode ?? null}`);
  }
  await queryRun(
    db,
    sql`UPDATE picking_orders SET ${sql.join(sets, sql`, `)}, last_update_date = ${now()} WHERE id = ${input.orderId}`
  );
  if (hasShipTo && existing.shipTo !== (input.shipTo ?? null)) {
    await audit(db, "picking_order", input.orderId, input.actorId, {
      field: "ship_to",
      from: existing.shipTo,
      to: input.shipTo ?? null,
    });
  }
  if (hasLocation && (existing.orgId !== (input.orgId ?? null) || existing.subInventoryCode !== (input.subInventoryCode ?? null))) {
    await audit(db, "picking_order", input.orderId, input.actorId, {
      field: "org_sub_inventory",
      from: { orgId: existing.orgId, subInventoryCode: existing.subInventoryCode },
      to: { orgId: input.orgId ?? null, subInventoryCode: input.subInventoryCode ?? null },
    });
  }
  return { id: input.orderId };
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

/** Editable column fields on a receiving invoice item (camelCase → column). */
const RECEIVING_ITEM_FIELDS = {
  dateCode: "date_code",
  lotCode: "lot_code",
  coo: "coo",
  cow: "cow",
  ctnNo: "ctn_no",
} as const;

/** drawingNo has no column — it lives in the additional_data jsonb passthrough. */
const RECEIVING_ITEM_JSONB_FIELDS = { drawingNo: "drawing_no" } as const;

export type ReceivingItemField = keyof typeof RECEIVING_ITEM_FIELDS | keyof typeof RECEIVING_ITEM_JSONB_FIELDS;

/** Set (or clear with null) editable fields on one receiving invoice item. */
export async function updateReceivingItemFields(
  db: AppDb,
  input: { itemId: string; fields: Partial<Record<ReceivingItemField, string | null>>; actorId: string | null }
): Promise<{ id: string }> {
  const columnKeys = (Object.keys(RECEIVING_ITEM_FIELDS) as (keyof typeof RECEIVING_ITEM_FIELDS)[]).filter(
    (k) => k in input.fields
  );
  const jsonbKeys = (Object.keys(RECEIVING_ITEM_JSONB_FIELDS) as (keyof typeof RECEIVING_ITEM_JSONB_FIELDS)[]).filter(
    (k) => k in input.fields
  );
  if (columnKeys.length === 0 && jsonbKeys.length === 0) throw new HTTPException(400, { message: "no_fields" });
  const existing = await queryGet<Record<string, string | null>>(
    db,
    sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", date_code AS "dateCode", lot_code AS "lotCode", coo, cow, ctn_no AS "ctnNo", additional_data->>'drawing_no' AS "drawingNo" FROM receiving_invoice_items WHERE id = ${input.itemId}`
  );
  if (!existing) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  const itemMeta: Record<string, unknown> = { partNo: existing.partNo };
  if (existing.wclItemNo) itemMeta.wclItemNo = existing.wclItemNo;
  const sets: SQL[] = columnKeys.map(
    (k) => sql`${sql.raw(RECEIVING_ITEM_FIELDS[k])} = ${input.fields[k] ?? null}`
  );
  for (const k of jsonbKeys) {
    const jsonKey = RECEIVING_ITEM_JSONB_FIELDS[k];
    const v = input.fields[k] ?? null;
    sets.push(
      v === null
        ? sql`additional_data = additional_data - ${jsonKey}`
        : sql`additional_data = jsonb_set(COALESCE(additional_data, '{}'::jsonb), ARRAY[${jsonKey}], to_jsonb(${v}::text))`
    );
  }
  await queryRun(
    db,
    sql`UPDATE receiving_invoice_items SET ${sql.join(sets, sql`, `)}, last_update_date = ${now()} WHERE id = ${input.itemId}`
  );
  for (const k of [...columnKeys, ...jsonbKeys] as ReceivingItemField[]) {
    const to = input.fields[k] ?? null;
    if (existing[k] === to) continue;
    const field =
      k in RECEIVING_ITEM_FIELDS
        ? RECEIVING_ITEM_FIELDS[k as keyof typeof RECEIVING_ITEM_FIELDS]
        : RECEIVING_ITEM_JSONB_FIELDS[k as keyof typeof RECEIVING_ITEM_JSONB_FIELDS];
    await audit(db, "receiving_invoice_item", input.itemId, input.actorId, {
      ...itemMeta,
      field,
      from: existing[k],
      to,
    });
  }
  return { id: input.itemId };
}
