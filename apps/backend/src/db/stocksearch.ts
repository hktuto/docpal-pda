import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "./query.js";
import { normalizePartNo } from "./scanParse.js";

// ---------------------------------------------------------------------------
// Stock search (read-only). One aggregate query replaces the old 3-call
// cascade (/stock-search/suppliers → /suppliers/:id/parts → /parts/lots):
// lots are the primary result, `parts` is the distinct part list of those
// lots with onHandQty = Σ total_qty over the matching lots of that part.
//
// Filter semantics (all optional, ANDed):
//   - partNo: case-insensitive substring on parts.part_no, normalized with
//     the same normalizePartNo as scan matching (uppercase + all whitespace
//     stripped) — the column side applies the identical transform in SQL.
//   - shelfCode: exact match on the lot's shelf_code.
//   - supplierCode: the lot traces to the supplier via inventory_lot_sources →
//     receiving_invoice_items → receiving_invoices → receiving_orders —
//     filtered on receiving_orders.supplier_code, mirroring the old
//     /stock-search/suppliers/:id/parts join.
// Zero-qty lots are returned: the old /stock-search/parts/lots had no
// total_qty filter (the >0 rule was only the suppliers-stats CTE and a
// client-side "only with inventory" toggle), so it is mirrored here.
// No actorId, no mutations, no allocateAll.
// ---------------------------------------------------------------------------

export interface StockSearchFilters {
  supplierCode?: string;
  partNo?: string;
  shelfCode?: string;
}

export interface StockSearchPartRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  description: string | null;
  onHandQty: number;
}

export interface StockSearchLotRow {
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  /** Stamped from the shelf at put-away (the lot's location pair). */
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface StockSearchResult {
  parts: StockSearchPartRow[];
  lots: StockSearchLotRow[];
}

/** Lot row joined with its part's identity fields (part fields stitched away in TS). */
interface LotJoinRow extends StockSearchLotRow {
  partPk: string;
  wclItemNo: string | null;
  description: string | null;
}

/**
 * Aggregate stock search: one query for the matching lots (part identity
 * embedded), then the distinct `parts` list with on-hand sums is stitched in
 * TS. Rows come back ordered by part_no, date_code NULLS LAST, shelf_code,
 * box_id — the same order drives both arrays.
 */
export async function searchStock(db: AppDb, filters: StockSearchFilters): Promise<StockSearchResult> {
  const partNoNorm = filters.partNo ? normalizePartNo(filters.partNo) : "";
  const rows = await queryAll<LotJoinRow>(
    db,
    sql`
      SELECT
        il.part_no AS "partNo",
        il.date_code AS "dateCode",
        il.lot_code AS "lotCode",
        il.coo, il.cow,
        il.shelf_code AS "shelfCode",
        il.box_id AS "boxId",
        il.org_id AS "orgId",
        il.sub_inventory_code AS "subInventoryCode",
        il.total_qty AS "totalQty",
        il.allocated_qty AS "allocatedQty",
        il.available_qty AS "availableQty",
        p.id AS "partPk",
        p.wcl_item_no AS "wclItemNo",
        p.description
      FROM inventory_lots il
      JOIN parts p ON p.part_no = il.part_no
      WHERE TRUE
      ${partNoNorm ? sql`AND strpos(regexp_replace(upper(p.part_no), '\\s', '', 'g'), ${partNoNorm}) > 0` : sql``}
      ${filters.shelfCode ? sql`AND il.shelf_code = ${filters.shelfCode}` : sql``}
      ${
        filters.supplierCode
          ? sql`AND EXISTS (
              SELECT 1
              FROM inventory_lot_sources ils
              JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
              JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
              JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
              WHERE ils.inventory_lot_id = il.id AND ro.supplier_code = ${filters.supplierCode}
            )`
          : sql``
      }
      ORDER BY il.part_no, il.date_code NULLS LAST, il.shelf_code, il.box_id
    `
  );

  const parts: StockSearchPartRow[] = [];
  const partIndexById = new Map<string, number>();
  const lots: StockSearchLotRow[] = [];
  for (const row of rows) {
    const { partPk, wclItemNo, description, ...lot } = row;
    lots.push(lot);
    const idx = partIndexById.get(partPk);
    if (idx === undefined) {
      partIndexById.set(partPk, parts.length);
      parts.push({ id: partPk, partNo: row.partNo, wclItemNo, description, onHandQty: row.totalQty });
    } else {
      parts[idx].onHandQty += row.totalQty;
    }
  }
  return { parts, lots };
}
