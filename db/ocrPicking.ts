import { eq, and, sql, isNull } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { v4 as uuid } from "uuid";
import { I18nError } from "~/composables/i18nError";
import { normalize } from "~/composables/useMockOcr";
import * as schema from "./schema";
import { materializeReceivingAllocation, scanAllocationToPackage } from "./picking";
import { availableReceivingQtySql, allocationsCte } from "./helpers";
import type {
  OcrParsedFields,
  ReceivingCandidate,
  PickingCandidate,
} from "~/services/types";

export type { OcrParsedFields, ReceivingCandidate, PickingCandidate } from "~/services/types";

export async function findReceivingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  parsed: OcrParsedFields
): Promise<ReceivingCandidate[]> {
  const qty = parsed.qty;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new I18nError("qty_must_be_positive_integer");
  }

  const t0 = performance.now();
  const result = await db
    .execute(sql`
      WITH order_item_ids AS (
        SELECT rii.id AS receiving_invoice_item_id
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        WHERE ro.id = ${receivingOrderId}
          AND ro.status = 'in_hand'
          AND REGEXP_REPLACE(UPPER(TRIM(p.part_no)), '\s+', ' ', 'g') = ${parsed.partNo}
      ),
      order_allocations AS (
        SELECT
          a.receiving_invoice_item_id,
          SUM(a.qty) AS allocated_qty
        FROM allocations a
        WHERE a.receiving_invoice_item_id IN (SELECT receiving_invoice_item_id FROM order_item_ids)
        GROUP BY a.receiving_invoice_item_id
      ),
      order_unboxed AS (
        SELECT
          pas.receiving_invoice_item_id,
          SUM(pas.qty) AS unboxed_scanned_qty
        FROM put_away_scans pas
        WHERE pas.shelf_box_id IS NULL
          AND pas.receiving_invoice_item_id IN (SELECT receiving_invoice_item_id FROM order_item_ids)
        GROUP BY pas.receiving_invoice_item_id
      )
      SELECT
        rii.id AS receiving_invoice_item_id,
        p.id AS part_id,
        p.part_no,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(UPPER(TRIM(rii.date_code)), '\s+', ' ', 'g'), 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5') AS date_code,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(UPPER(TRIM(rii.lot_code)), '\s+', ' ', 'g'), 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5') AS lot_code,
        REGEXP_REPLACE(UPPER(TRIM(rii.coo)), '\s+', ' ', 'g') AS coo,
        REGEXP_REPLACE(UPPER(TRIM(rii.cow)), '\s+', ' ', 'g') AS cow,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(unboxed.unboxed_scanned_qty, 0)) AS available_qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN parts p ON p.id = rii.part_id
      LEFT JOIN order_allocations alloc ON alloc.receiving_invoice_item_id = rii.id
      LEFT JOIN order_unboxed unboxed ON unboxed.receiving_invoice_item_id = rii.id
      WHERE ro.id = ${receivingOrderId}
        AND ro.status = 'in_hand'
        AND REGEXP_REPLACE(UPPER(TRIM(p.part_no)), '\s+', ' ', 'g') = ${parsed.partNo}
        AND (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(unboxed.unboxed_scanned_qty, 0)) >= ${qty}
      ORDER BY date_code, lot_code
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        receivingInvoiceItemId: String(row.receiving_invoice_item_id),
        partId: String(row.part_id),
        partNo: String(row.part_no),
        dateCode: row.date_code != null ? String(row.date_code) : null,
        lotCode: row.lot_code != null ? String(row.lot_code) : null,
        coo: row.coo != null ? String(row.coo) : null,
        cow: row.cow != null ? String(row.cow) : null,
        availableQty: Number(row.available_qty),
      }))
    );
  console.log('[SCAN-TIME] findReceivingCandidates query', (performance.now() - t0).toFixed(1), 'ms');
  return result;
}

export async function findPickingCandidates(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  partId: string,
  qty: number
): Promise<PickingCandidate[]> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new I18nError("qty_must_be_positive_integer");
  }

  const t0 = performance.now();
  const result = await db
    .execute(sql`
      SELECT DISTINCT
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref_no,
        pi.id AS picking_item_id,
        pi.part_id AS part_id,
        po.ship_to,
        pi.qty AS required_qty,
        pi.picked_qty,
        (pi.qty - pi.picked_qty) AS remaining_qty
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE pi.part_id = ${partId}
        AND po.status != 'finished'
        AND (pi.qty - pi.picked_qty) > 0
        AND EXISTS (
          SELECT 1
          FROM picking_items pi2
          JOIN allocations a ON a.picking_item_id = pi2.id
          WHERE pi2.picking_order_id = po.id
            AND a.receiving_order_id = ${receivingOrderId}
        )
      ORDER BY po.ref_no
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        pickingOrderId: String(row.picking_order_id),
        pickingOrderRefNo: String(row.picking_order_ref_no),
        pickingItemId: String(row.picking_item_id),
        partId: String(row.part_id),
        shipTo: row.ship_to != null ? String(row.ship_to) : null,
        requiredQty: Number(row.required_qty),
        pickedQty: Number(row.picked_qty),
        remainingQty: Number(row.remaining_qty),
      }))
    );
  console.log('[SCAN-TIME] findPickingCandidates query', (performance.now() - t0).toFixed(1), 'ms');
  return result;
}

/**
 * Pre-compute all receiving candidates for a receiving order.
 * Returns a map keyed by normalized part number for instant scan lookup.
 */
export async function findReceivingCandidatesForOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
): Promise<Map<string, ReceivingCandidate[]>> {
  const result = await db
    .execute(sql`
      WITH order_item_ids AS (
        SELECT rii.id AS receiving_invoice_item_id
        FROM receiving_orders ro
        JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
        JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        JOIN parts p ON p.id = rii.part_id
        WHERE ro.id = ${receivingOrderId}
          AND ro.status = 'in_hand'
      ),
      order_allocations AS (
        SELECT
          a.receiving_invoice_item_id,
          SUM(a.qty) AS allocated_qty
        FROM allocations a
        WHERE a.receiving_invoice_item_id IN (SELECT receiving_invoice_item_id FROM order_item_ids)
        GROUP BY a.receiving_invoice_item_id
      ),
      order_unboxed AS (
        SELECT
          pas.receiving_invoice_item_id,
          SUM(pas.qty) AS unboxed_scanned_qty
        FROM put_away_scans pas
        WHERE pas.shelf_box_id IS NULL
          AND pas.receiving_invoice_item_id IN (SELECT receiving_invoice_item_id FROM order_item_ids)
        GROUP BY pas.receiving_invoice_item_id
      )
      SELECT
        rii.id AS receiving_invoice_item_id,
        p.id AS part_id,
        p.part_no,
        REGEXP_REPLACE(UPPER(TRIM(p.part_no)), '\s+', ' ', 'g') AS normalized_part_no,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(UPPER(TRIM(rii.date_code)), '\s+', ' ', 'g'), 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5') AS date_code,
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(UPPER(TRIM(rii.lot_code)), '\s+', ' ', 'g'), 'O', '0'), 'I', '1'), 'L', '1'), 'Z', '2'), 'S', '5') AS lot_code,
        REGEXP_REPLACE(UPPER(TRIM(rii.coo)), '\s+', ' ', 'g') AS coo,
        REGEXP_REPLACE(UPPER(TRIM(rii.cow)), '\s+', ' ', 'g') AS cow,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(unboxed.unboxed_scanned_qty, 0)) AS available_qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      JOIN parts p ON p.id = rii.part_id
      LEFT JOIN order_allocations alloc ON alloc.receiving_invoice_item_id = rii.id
      LEFT JOIN order_unboxed unboxed ON unboxed.receiving_invoice_item_id = rii.id
      WHERE ro.id = ${receivingOrderId}
        AND ro.status = 'in_hand'
        AND (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(unboxed.unboxed_scanned_qty, 0)) > 0
      ORDER BY normalized_part_no, date_code, lot_code
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        receivingInvoiceItemId: String(row.receiving_invoice_item_id),
        partId: String(row.part_id),
        partNo: String(row.part_no),
        dateCode: row.date_code != null ? String(row.date_code) : null,
        lotCode: row.lot_code != null ? String(row.lot_code) : null,
        coo: row.coo != null ? String(row.coo) : null,
        cow: row.cow != null ? String(row.cow) : null,
        availableQty: Number(row.available_qty),
      }))
    );

  const map = new Map<string, ReceivingCandidate[]>();
  for (const candidate of result) {
    const key = normalize(candidate.partNo);
    const list = map.get(key) ?? [];
    list.push(candidate);
    map.set(key, list);
  }
  return map;
}

/**
 * Pre-compute all picking candidates for a receiving order.
 * Returns a map keyed by part id for instant scan lookup.
 */
export async function findPickingCandidatesForOrder(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string
): Promise<Map<string, PickingCandidate[]>> {
  const result = await db
    .execute(sql`
      SELECT DISTINCT
        po.id AS picking_order_id,
        po.ref_no AS picking_order_ref_no,
        pi.id AS picking_item_id,
        pi.part_id AS part_id,
        po.ship_to,
        pi.qty AS required_qty,
        pi.picked_qty,
        (pi.qty - pi.picked_qty) AS remaining_qty
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE po.status != 'finished'
        AND (pi.qty - pi.picked_qty) > 0
        AND EXISTS (
          SELECT 1
          FROM picking_items pi2
          JOIN allocations a ON a.picking_item_id = pi2.id
          WHERE pi2.picking_order_id = po.id
            AND a.receiving_order_id = ${receivingOrderId}
        )
      ORDER BY po.ref_no
    `)
    .then((r) =>
      (r.rows ?? []).map((row) => ({
        pickingOrderId: String(row.picking_order_id),
        pickingOrderRefNo: String(row.picking_order_ref_no),
        pickingItemId: String(row.picking_item_id),
        partId: String(row.part_id),
        shipTo: row.ship_to != null ? String(row.ship_to) : null,
        requiredQty: Number(row.required_qty),
        pickedQty: Number(row.picked_qty),
        remainingQty: Number(row.remaining_qty),
      }))
    );

  const map = new Map<string, PickingCandidate[]>();
  for (const candidate of result) {
    const list = map.get(candidate.partId) ?? [];
    list.push(candidate);
    map.set(candidate.partId, list);
  }
  return map;
}

export async function applyOcrPick(
  db: PgliteDatabase<typeof schema>,
  receivingOrderId: string,
  pickingItemId: string,
  qty: number,
  dateCode: string | null,
  lotCode: string | null,
  coo: string | null,
  cow: string | null,
  actorId: string
): Promise<void> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new I18nError("qty_must_be_positive_integer");
  }
  if (!actorId) throw new I18nError("actor_required");

  return db.transaction(async (tx) => {
    const [receivingOrder] = await tx
      .select()
      .from(schema.receivingOrders)
      .where(eq(schema.receivingOrders.id, receivingOrderId));
    if (!receivingOrder) throw new I18nError("receiving_order_not_found");
    if (receivingOrder.status !== "in_hand") throw new I18nError("receiving_order_not_in_hand");

    const [pickingItem] = await tx
      .select()
      .from(schema.pickingItems)
      .where(eq(schema.pickingItems.id, pickingItemId));
    if (!pickingItem) throw new I18nError("picking_item_not_found");

    const partInOrder = await tx.execute(sql`
      SELECT 1
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
      LIMIT 1
    `);
    if ((partInOrder.rows ?? []).length === 0) {
      throw new I18nError("receiving_picking_part_mismatch");
    }

    const scannedResult = await tx
      .select({
        total: sql<number>`coalesce(sum(${schema.pickingPackages.qty}), 0)`.mapWith(Number),
      })
      .from(schema.pickingPackages)
      .where(
        and(
          eq(schema.pickingPackages.pickingItemId, pickingItemId),
          isNull(schema.pickingPackages.shippingBoxId)
        )
      );
    const scannedNotBoxed = scannedResult[0]?.total ?? 0;
    const remaining = pickingItem.qty - pickingItem.pickedQty - scannedNotBoxed;
    if (qty > remaining) throw new I18nError("quantity_exceeds_picking_need");

    const existingAllocations = await tx
      .select()
      .from(schema.allocations)
      .where(
        sql`${schema.allocations.receivingOrderId} = ${receivingOrderId}
          AND ${schema.allocations.pickingItemId} = ${pickingItemId}
          AND ${schema.allocations.qty} > 0`
      )
      .orderBy(schema.allocations.id);
    const existingTotal = existingAllocations.reduce((sum, a) => sum + a.qty, 0);

    const availabilityResult = await tx.execute(sql`
      SELECT
        COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical_qty,
        COALESCE((
          SELECT SUM(a.qty)
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          WHERE a.receiving_order_id = ${receivingOrderId}
            AND pi.part_id = ${pickingItem.partId}
            AND a.picking_item_id != ${pickingItemId}
        ), 0) AS reserved_by_others
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
    `);
    const availabilityRow = availabilityResult.rows[0] as any;
    const physicalQty = Number(availabilityRow.physical_qty ?? 0);
    const reservedByOthers = Number(availabilityRow.reserved_by_others ?? 0);
    const availableForScan = physicalQty - reservedByOthers;
    if (qty > availableForScan) {
      throw new I18nError("quantity_not_available_receiving");
    }

    const left = Math.max(0, qty - existingTotal);
    if (left > 0) {
      const unallocatedDemand = pickingItem.qty - pickingItem.pickedQty - pickingItem.allocatedQty - scannedNotBoxed;
      if (left > unallocatedDemand) {
        throw new I18nError("quantity_exceeds_unallocated_picking_need");
      }
      await tx.insert(schema.allocations).values({
        id: uuid(),
        pickingItemId,
        receivingOrderId,
        qty: left,
      });
      await tx
        .update(schema.pickingItems)
        .set({ allocatedQty: sql`${schema.pickingItems.allocatedQty} + ${left}` })
        .where(eq(schema.pickingItems.id, pickingItemId));
    }

    const invoiceItems = await tx.execute(sql`
      SELECT
        rii.id AS receiving_invoice_item_id,
        rii.received_qty,
        rii.picked_qty,
        rii.put_away_qty,
        rii.date_code,
        COALESCE((
          SELECT SUM(a.qty)
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          WHERE a.receiving_order_id = ro.id
            AND pi.part_id = rii.part_id
            AND a.picking_item_id != ${pickingItemId}
        ), 0) AS reserved_by_others,
        (
          SELECT COALESCE(SUM(pas.qty), 0)
          FROM put_away_scans pas
          WHERE pas.receiving_invoice_item_id = rii.id
            AND pas.shelf_box_id IS NULL
        ) AS unboxed_scanned_qty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.id = ${receivingOrderId}
        AND rii.part_id = ${pickingItem.partId}
      GROUP BY rii.id, rii.received_qty, rii.picked_qty, rii.put_away_qty, rii.date_code, ri.invoice_no, ro.delivery_date
      HAVING rii.received_qty - rii.picked_qty - rii.put_away_qty -
        COALESCE((
          SELECT SUM(a.qty)
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          WHERE a.receiving_order_id = ro.id
            AND pi.part_id = rii.part_id
            AND a.picking_item_id != ${pickingItemId}
        ), 0) -
        (
          SELECT COALESCE(SUM(pas.qty), 0)
          FROM put_away_scans pas
          WHERE pas.receiving_invoice_item_id = rii.id
            AND pas.shelf_box_id IS NULL
        ) > 0
      ORDER BY ro.delivery_date ASC NULLS LAST, ri.invoice_no ASC, rii.date_code ASC NULLS LAST
    `);

    let remainingScan = qty;
    for (const raw of invoiceItems.rows ?? []) {
      if (remainingScan <= 0) break;
      const available =
        Number(raw.received_qty) -
        Number(raw.picked_qty) -
        Number(raw.put_away_qty) -
        Number(raw.reserved_by_others) -
        Number(raw.unboxed_scanned_qty);
      if (available <= 0) continue;
      const use = Math.min(remainingScan, available);
      const receivingInvoiceItemId = String(raw.receiving_invoice_item_id);

      const [allocation] = await tx
        .select()
        .from(schema.allocations)
        .where(
          sql`${schema.allocations.receivingOrderId} = ${receivingOrderId}
            AND ${schema.allocations.pickingItemId} = ${pickingItemId}
            AND ${schema.allocations.qty} > 0`
        )
        .orderBy(schema.allocations.id)
        .limit(1);
      if (!allocation) throw new I18nError("allocation_not_found");

      const materializedAllocationId = await materializeReceivingAllocation(
        db,
        allocation.id,
        use,
        dateCode,
        lotCode,
        coo,
        cow,
        receivingInvoiceItemId,
        tx
      );
      await scanAllocationToPackage(db, materializedAllocationId, use, actorId, tx);
      remainingScan -= use;
    }

    if (remainingScan > 0) {
      throw new I18nError("quantity_not_available_receiving");
    }
  });
}
