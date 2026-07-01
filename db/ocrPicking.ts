import { eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import * as schema from "./schema";
import { materializeReceivingAllocation, confirmAllocationPicked } from "./picking";

export interface OcrParseResult {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  originCountry: string | null;
  qty: number;
}

export interface ReceivingCandidate {
  receivingInvoiceItemId: string;
  partId: string;
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  originCountry: string | null;
  availableQty: number;
}

export interface PickingCandidate {
  pickingOrderId: string;
  pickingOrderRefNo: string;
  pickingItemId: string;
  shipTo: string | null;
  requiredQty: number;
  pickedQty: number;
  remainingQty: number;
}

export async function findReceivingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  parsed: OcrParseResult
): Promise<ReceivingCandidate[]> {
  const qty = parsed.qty;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  return db
    .execute(sql`
      WITH normalized AS (
        SELECT
          rii.id AS receiving_invoice_item_id,
          p.id AS part_id,
          p.part_no,
          UPPER(TRIM(rii.date_code)) AS date_code,
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TRIM(rii.lot_code)), 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5') AS lot_code,
          UPPER(TRIM(rii.origin_country)) AS origin_country,
          (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)) AS available_qty
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        LEFT JOIN (
          SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
          FROM allocations
          WHERE receiving_invoice_item_id IS NOT NULL
          GROUP BY receiving_invoice_item_id
        ) alloc ON alloc.receiving_invoice_item_id = rii.id
        WHERE ro.id = ${receivingOrderId}
          AND ro.status = 'in_hand'
          AND rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) >= ${qty}
      )
      SELECT * FROM normalized
      WHERE UPPER(TRIM(part_no)) = ${parsed.partNo}
        AND (date_code IS NOT DISTINCT FROM ${parsed.dateCode})
        AND (lot_code IS NOT DISTINCT FROM ${parsed.lotCode})
        AND (origin_country IS NOT DISTINCT FROM ${parsed.originCountry})
      ORDER BY date_code, lot_code
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        receivingInvoiceItemId: String(row.receiving_invoice_item_id),
        partId: String(row.part_id),
        partNo: String(row.part_no),
        dateCode: row.date_code != null ? String(row.date_code) : null,
        lotCode: row.lot_code != null ? String(row.lot_code) : null,
        originCountry: row.origin_country != null ? String(row.origin_country) : null,
        availableQty: Number(row.available_qty),
      }))
    );
}

export async function findPickingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  partId: string,
  qty: number
): Promise<PickingCandidate[]> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  return db
    .execute(sql`
      SELECT DISTINCT
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref_no,
        pi.id AS picking_item_id,
        po.ship_to,
        pi.qty AS required_qty,
        pi.picked_qty,
        (pi.qty - pi.picked_qty) AS remaining_qty
      FROM picking_orders po
      JOIN picking_items pi ON pi.picking_order_id = po.id
      WHERE po.id IN (
        SELECT DISTINCT po2.id
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN allocations a ON a.receiving_invoice_item_id = rii.id
        JOIN picking_items pi2 ON pi2.id = a.picking_item_id
        JOIN picking_orders po2 ON po2.id = pi2.picking_order_id
        WHERE ro.id = ${receivingOrderId}
      )
        AND pi.part_id = ${partId}
        AND po.status != 'finished'
        AND (pi.qty - pi.picked_qty) > 0
      ORDER BY po.ref_no
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        pickingOrderId: String(row.picking_order_id),
        pickingOrderRefNo: String(row.picking_order_ref_no),
        pickingItemId: String(row.picking_item_id),
        shipTo: row.ship_to != null ? String(row.ship_to) : null,
        requiredQty: Number(row.required_qty),
        pickedQty: Number(row.picked_qty),
        remainingQty: Number(row.remaining_qty),
      }))
    );
}

export async function applyOcrPick(
  db: PgliteDatabase<typeof schema>,
  receivingInvoiceItemId: string,
  pickingItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  originCountry: string | null,
  actorId: string
): Promise<{ allocationId: string; materializedAllocationId: string }> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("Qty must be a positive integer");
  }

  return db.transaction(async (tx) => {
    const [receivingItem] = await tx
      .select()
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));
    if (!receivingItem) throw new Error("Receiving invoice item not found");

    const allocatedResult = await tx
      .select({ total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number) })
      .from(schema.allocations)
      .where(eq(schema.allocations.receivingInvoiceItemId, receivingInvoiceItemId));
    const allocated = allocatedResult[0]?.total ?? 0;
    const available = receivingItem.receivedQty - receivingItem.pickedQty - receivingItem.putAwayQty - allocated;
    if (qty > available) throw new Error("Insufficient available quantity");

    const [pickingItem] = await tx
      .select()
      .from(schema.pickingItems)
      .where(eq(schema.pickingItems.id, pickingItemId));
    if (!pickingItem) throw new Error("Picking item not found");
    if (pickingItem.partId !== receivingItem.partId) {
      throw new Error("Receiving item and picking item do not match the same part");
    }
    const remaining = pickingItem.qty - pickingItem.pickedQty;
    if (qty > remaining) throw new Error("Quantity exceeds picking order need");

    const [allocation] = await tx
      .insert(schema.allocations)
      .values({
        id: uuid(),
        pickingItemId,
        receivingInvoiceItemId,
        qty,
      })
      .returning();

    await tx
      .update(schema.pickingItems)
      .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${qty}` })
      .where(eq(schema.pickingItems.id, pickingItemId));

    const materializedAllocationId = await materializeReceivingAllocation(
      db,
      allocation.id,
      qty,
      dateCode,
      lotCode,
      originCountry,
      tx
    );

    await confirmAllocationPicked(db, materializedAllocationId, qty, actorId, tx);

    return { allocationId: allocation.id, materializedAllocationId };
  });
}
