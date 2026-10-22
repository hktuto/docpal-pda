import { HTTPException } from "hono/http-exception";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { inventoryLots } from "./schema/inventory.js";
import { inventoryTransactions } from "./schema/audit.js";
import { shelfExchanges } from "./schema/shelfExchange.js";
import { shelves } from "./schema/master.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryGet } from "./query.js";
import { allowedOrgFilter } from "./org-filter.js";
import { normalizePartNo } from "./scanParse.js";
import { toCanonicalDateCode } from "./dateCode.js";
import { dateCodeFormat } from "../config.js";
import { scheduleAllocateAll } from "./allocate.js";

// Shelf exchange domain logic (spec 2026-10-12-shelf-exchange-design.md):
// move stock from one shelf to another. Scan-driven, order-free; qty comes
// from the item label. The PDA previews the move (resolving the lot on the
// source shelf), then commits with the pinned lotId.

export interface ShelfExchangeLabelInput {
  /** Parsed label part key (either part_no or wcl_item_no). */
  partNo?: string;
  wclItemNo?: string | null;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

export interface ShelfExchangePreviewInput extends ShelfExchangeLabelInput {
  sourceShelfCode: string;
}

export interface ShelfExchangePreviewResult {
  lotId: string;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  availableQty: number;
  qty: number;
}

// NB: a type alias (not an interface) so it satisfies the
// `Record<string, unknown>` constraint of `db.execute<T>` — interfaces lack
// the implicit index signature.
type ResolvedLot = {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  drawingNo: string | null;
  shelfCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
};

/**
 * Resolve the lot on the source shelf for a scanned label: part keys matched
 * space-insensitively against both part_no and wcl_item_no, label batch
 * fields (dateCode/lotCode/coo/cow) must match when carried, org filter from
 * the flow config, lots whose shelf is missing from shelves excluded (the
 * allocate.ts FK-update guard), FIFO by date_code. 409 no_stock_at_location
 * when no lot covers the qty; 409 insufficient_available_qty when lots exist
 * but all are (partially) allocated.
 */
export async function previewShelfExchange(
  db: AppDb,
  input: ShelfExchangePreviewInput
): Promise<ShelfExchangePreviewResult> {
  const { sourceShelfCode } = input;
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new HTTPException(400, { message: "qty must be a positive integer" });
  }
  const partKeys = [input.partNo, input.wclItemNo]
    .filter((v): v is string => !!v)
    .map(normalizePartNo);
  if (partKeys.length === 0) {
    throw new HTTPException(400, { message: "part_no_required" });
  }

  const shelf = await queryGet<{ code: string }>(
    db,
    sql`SELECT code FROM shelves WHERE code = ${sourceShelfCode}`
  );
  if (!shelf) throw new HTTPException(404, { message: "shelf_not_found" });

  // The scanned label's date code arrives in the label format; lots store
  // canonical YYWW — canonicalize before the match (spec
  // 2026-10-22-datecode-format-config-design.md).
  const scannedDateCode = toCanonicalDateCode(input.dateCode, dateCodeFormat());

  const rows = await db.execute<{
    id: string;
    partNo: string;
    wclItemNo: string | null;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    drawingNo: string | null;
    orgId: number | null;
    subInventoryCode: string | null;
    totalQty: number;
    allocatedQty: number;
    availableQty: number;
  }>(
    sql`SELECT il.id, il.part_no AS "partNo", il.wcl_item_no AS "wclItemNo",
               il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
               il.drawing_no AS "drawingNo", il.org_id AS "orgId",
               il.sub_inventory_code AS "subInventoryCode",
               il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty",
               (il.total_qty - il.allocated_qty) AS "availableQty"
        FROM inventory_lots il
        WHERE ${sql.join(
          partKeys.map(
            (k) => sql`(upper(replace(il.part_no, ' ', '')) = ${k} OR upper(replace(il.wcl_item_no, ' ', '')) = ${k})`
          ),
          sql` OR `
        )}
          AND il.shelf_code = ${sourceShelfCode}
          ${allowedOrgFilter(sql`il.org_id`)}
          AND (${scannedDateCode ?? null}::text IS NULL OR il.date_code = ${scannedDateCode ?? null})
          AND (${input.lotCode ?? null}::text IS NULL OR il.lot_code = ${input.lotCode ?? null})
          AND (${input.coo ?? null}::text IS NULL OR upper(il.coo) = upper(${input.coo ?? null}))
          AND (${input.cow ?? null}::text IS NULL OR upper(il.cow) = upper(${input.cow ?? null}))
          -- Same guard as allocate.ts: lots whose shelf is missing from
          -- shelves fail the FK on UPDATE, never touch them.
          AND EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)
        ORDER BY il.date_code ASC NULLS LAST, il.id`
  );
  const lots = Array.from(rows as Iterable<ResolvedLot>);
  if (!lots.length) {
    throw new HTTPException(409, { message: "no_stock_at_location" });
  }
  // FIFO, but only unallocated stock is movable — allocated qty belongs to
  // picking orders and moving it would break their picks.
  const lot = lots.find((l) => l.totalQty - l.allocatedQty >= input.qty);
  if (!lot) {
    throw new HTTPException(409, { message: "insufficient_available_qty" });
  }

  return {
    lotId: lot.id,
    partNo: lot.partNo,
    wclItemNo: lot.wclItemNo,
    dateCode: lot.dateCode,
    lotCode: lot.lotCode,
    coo: lot.coo,
    cow: lot.cow,
    totalQty: lot.totalQty,
    availableQty: lot.totalQty - lot.allocatedQty,
    qty: input.qty,
  };
}

export interface ShelfExchangeCommitInput {
  sourceShelfCode: string;
  targetShelfCode: string;
  lotId: string;
  qty: number;
  actorId: string;
}

export interface ShelfExchangeCommitResult {
  id: string;
  sourceShelfCode: string;
  targetShelfCode: string;
  partNo: string;
  qty: number;
  sourceRemaining: number;
  targetTotal: number;
}

/**
 * Commit a shelf exchange. Single transaction:
 * 1. Re-validate the pinned lot (still on the source shelf, enough
 *    unallocated stock — availability can drift between preview and commit).
 * 2. Validate the target shelf exists and differs from the source.
 * 3. Source lot total_qty -= qty; find-or-create the target lot on the
 *    unique-lot index key (box_id NULL, org/sub-inventory from the source)
 *    and total_qty += qty — merge semantics, matching put-away/ad-hoc.
 * 4. Insert the shelf_exchanges audit row + two MOVE ledger rows.
 */
export async function commitShelfExchange(
  db: AppDb,
  input: ShelfExchangeCommitInput
): Promise<ShelfExchangeCommitResult> {
  const { sourceShelfCode, targetShelfCode, lotId, qty, actorId } = input;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new HTTPException(400, { message: "qty must be a positive integer" });
  }
  if (sourceShelfCode === targetShelfCode) {
    throw new HTTPException(400, { message: "same_shelf" });
  }

  return db.transaction(async (tx): Promise<ShelfExchangeCommitResult> => {
    const sourceRows = await tx.execute<ResolvedLot>(
      sql`SELECT il.id, il.part_no AS "partNo", il.wcl_item_no AS "wclItemNo",
                 il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
                 il.drawing_no AS "drawingNo", il.shelf_code AS "shelfCode",
                 il.org_id AS "orgId",
                 il.sub_inventory_code AS "subInventoryCode",
                 il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty",
                 (il.total_qty - il.allocated_qty) AS "availableQty"
          FROM inventory_lots il WHERE il.id = ${lotId} FOR UPDATE`
    );
    const source = Array.from(sourceRows as Iterable<ResolvedLot>)[0];
    if (!source || source.shelfCode !== sourceShelfCode) {
      // The lot moved (or vanished) between preview and commit.
      throw new HTTPException(409, { message: "no_stock_at_location" });
    }
    if (source.totalQty < qty || source.totalQty - source.allocatedQty < qty) {
      throw new HTTPException(409, { message: "insufficient_available_qty" });
    }

    const targetShelf = await tx.execute<{ code: string }>(
      sql`SELECT code FROM shelves WHERE code = ${targetShelfCode}`
    );
    if (!Array.from(targetShelf).length) {
      throw new HTTPException(404, { message: "shelf_not_found" });
    }

    // Decrement the source lot.
    await tx
      .update(inventoryLots)
      .set({ totalQty: sql`${inventoryLots.totalQty} - ${qty}`, lastUpdateDate: now() })
      .where(eq(inventoryLots.id, lotId));

    // Find-or-create the target lot on the unique-lot index key (nullable
    // columns need IS NOT DISTINCT FROM; box_id NULL — the target is a
    // shelf, not a box).
    const existing = await tx.execute<{ id: string }>(
      sql`SELECT il.id FROM inventory_lots il
          WHERE il.part_no = ${source.partNo}
            AND il.date_code IS NOT DISTINCT FROM ${source.dateCode}
            AND il.coo IS NOT DISTINCT FROM ${source.coo}
            AND il.cow IS NOT DISTINCT FROM ${source.cow}
            AND il.shelf_code = ${targetShelfCode}
            AND il.box_id IS NULL
            AND il.org_id IS NOT DISTINCT FROM ${source.orgId}
            AND il.sub_inventory_code IS NOT DISTINCT FROM ${source.subInventoryCode}
          LIMIT 1`
    );
    let targetLotId = Array.from(existing as Iterable<{ id: string }>)[0]?.id;
    if (targetLotId) {
      await tx
        .update(inventoryLots)
        .set({ totalQty: sql`${inventoryLots.totalQty} + ${qty}`, lastUpdateDate: now() })
        .where(eq(inventoryLots.id, targetLotId));
    } else {
      targetLotId = newId();
      await tx.insert(inventoryLots).values({
        id: targetLotId,
        partNo: source.partNo,
        wclItemNo: source.wclItemNo,
        dateCode: source.dateCode,
        lotCode: source.lotCode,
        coo: source.coo,
        cow: source.cow,
        drawingNo: source.drawingNo,
        shelfCode: targetShelfCode,
        orgId: source.orgId,
        subInventoryCode: source.subInventoryCode,
        totalQty: qty,
        allocatedQty: 0,
      });
    }

    // Audit row.
    const exchangeId = newId();
    await tx.insert(shelfExchanges).values({
      id: exchangeId,
      sourceShelfCode,
      targetShelfCode,
      sourceLotId: lotId,
      targetLotId,
      partNo: source.partNo,
      wclItemNo: source.wclItemNo,
      qty,
      dateCode: source.dateCode,
      lotCode: source.lotCode,
      coo: source.coo,
      cow: source.cow,
      orgId: source.orgId,
      subInventoryCode: source.subInventoryCode,
      actorId,
    });

    // Two MOVE ledger rows: −qty at the source shelf, +qty at the target.
    const at = now();
    await tx.insert(inventoryTransactions).values([
      {
        id: newId(),
        inventoryLotId: lotId,
        partNo: source.partNo,
        shelfCode: sourceShelfCode,
        txnType: "MOVE",
        qtyType: "on_hand",
        qtyDelta: -qty,
        dateCode: source.dateCode,
        lotCode: source.lotCode,
        coo: source.coo,
        cow: source.cow,
        referenceType: "shelf_exchange",
        referenceId: exchangeId,
        actorId,
        txnReason: "shelf exchange",
        txnAt: at,
      },
      {
        id: newId(),
        inventoryLotId: targetLotId,
        partNo: source.partNo,
        shelfCode: targetShelfCode,
        txnType: "MOVE",
        qtyType: "on_hand",
        qtyDelta: qty,
        dateCode: source.dateCode,
        lotCode: source.lotCode,
        coo: source.coo,
        cow: source.cow,
        referenceType: "shelf_exchange",
        referenceId: exchangeId,
        actorId,
        txnReason: "shelf exchange",
        txnAt: at,
      },
    ]);

    const totals = await tx.execute<{ sourceRemaining: number; targetTotal: number }>(
      sql`SELECT (SELECT total_qty FROM inventory_lots WHERE id = ${lotId}) AS "sourceRemaining",
                 (SELECT total_qty FROM inventory_lots WHERE id = ${targetLotId}) AS "targetTotal"`
    );
    const t = Array.from(totals as Iterable<{ sourceRemaining: number; targetTotal: number }>)[0];

    return {
      id: exchangeId,
      sourceShelfCode,
      targetShelfCode,
      partNo: source.partNo,
      qty,
      sourceRemaining: t?.sourceRemaining ?? source.totalQty - qty,
      targetTotal: t?.targetTotal ?? qty,
    };
  });
}

/** Re-export for route scheduling (same pattern as adhocPutaway.ts). */
export { scheduleAllocateAll };
