import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "./query.js";
import { normalizePartNo } from "./scanParse.js";
import { allowedOrgFilter } from "./org-filter.js";

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
//   - shelfCode: any-of match on the lot's shelf_code.
//   - zone: any-of match on the shelf's zone (shelves join; lots whose shelf
//     has no zone never match).
//   - brand: any-of match on the part's brand (parts.brand).
//   - orgId / subInventoryCode: any-of match on the lot's location pair.
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
  supplierCode?: string[];
  partNo?: string;
  shelfCode?: string[];
  zone?: string[];
  brand?: string[];
  orgId?: number[];
  subInventoryCode?: string[];
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
  /** The part's WCL item no (via the parts join) — primary display key. */
  wclItemNo: string | null;
  /** Part identity fields, for display/sort/group on lot rows. */
  description: string | null;
  brand: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  /** The shelf's zone (shelves join; null when the lot has no/unknown shelf). */
  zone: string | null;
  boxId: string | null;
  /** Stamped from the shelf at put-away (the lot's location pair). */
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

/** Distinct filter values present in the current stock (for dropdowns). */
export interface StockSearchOptions {
  brands: string[];
  zones: string[];
  shelves: { code: string; zone: string | null }[];
  locations: { orgId: number | null; subInventoryCode: string | null; description: string | null }[];
}

export interface StockSearchResult {
  parts: StockSearchPartRow[];
  lots: StockSearchLotRow[];
}

/** Lot row plus the part PK (stitched away in TS after parts aggregation). */
interface LotJoinRow extends StockSearchLotRow {
  partPk: string;
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
        p.description,
        p.brand,
        s.zone
      FROM inventory_lots il
      JOIN parts p ON p.wcl_item_no = il.wcl_item_no
      LEFT JOIN shelves s ON s.code = il.shelf_code
      WHERE TRUE
      ${allowedOrgFilter(sql`il.org_id`)}
      ${partNoNorm ? sql`AND strpos(regexp_replace(upper(p.part_no), '\\s', '', 'g'), ${partNoNorm}) > 0` : sql``}
      ${filters.shelfCode?.length ? sql`AND il.shelf_code IN (${sql.join(filters.shelfCode.map((v) => sql`${v}`), sql`, `)})` : sql``}
      ${filters.zone?.length ? sql`AND s.zone IN (${sql.join(filters.zone.map((v) => sql`${v}`), sql`, `)})` : sql``}
      ${filters.brand?.length ? sql`AND p.brand IN (${sql.join(filters.brand.map((v) => sql`${v}`), sql`, `)})` : sql``}
      ${filters.orgId?.length ? sql`AND il.org_id IN (${sql.join(filters.orgId.map((v) => sql`${v}`), sql`, `)})` : sql``}
      ${filters.subInventoryCode?.length ? sql`AND il.sub_inventory_code IN (${sql.join(filters.subInventoryCode.map((v) => sql`${v}`), sql`, `)})` : sql``}
      ${
        filters.supplierCode?.length
          ? sql`AND EXISTS (
              SELECT 1
              FROM inventory_lot_sources ils
              JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
              JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
              JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
              WHERE ils.inventory_lot_id = il.id AND ro.supplier_code IN (${sql.join(filters.supplierCode.map((v) => sql`${v}`), sql`, `)})
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
    const { partPk, ...lot } = row;
    lots.push(lot);
    const idx = partIndexById.get(partPk);
    if (idx === undefined) {
      partIndexById.set(partPk, parts.length);
      parts.push({ id: partPk, partNo: row.partNo, wclItemNo: row.wclItemNo, description: row.description, onHandQty: row.totalQty });
    } else {
      parts[idx].onHandQty += row.totalQty;
    }
  }
  return { parts, lots };
}

/**
 * Distinct filter values present in the current stock, for the admin filter
 * dropdowns — options always reflect values that can actually match. Scoped
 * by the same allowed-org filter as searchStock.
 */
export async function stockSearchOptions(db: AppDb): Promise<StockSearchOptions> {
  const brands = await queryAll<{ brand: string }>(
    db,
    sql`
      SELECT DISTINCT p.brand
      FROM inventory_lots il
      JOIN parts p ON p.wcl_item_no = il.wcl_item_no
      WHERE TRUE
      ${allowedOrgFilter(sql`il.org_id`)}
      ORDER BY p.brand
    `
  );
  const zones = await queryAll<{ zone: string }>(
    db,
    sql`
      SELECT DISTINCT s.zone
      FROM inventory_lots il
      JOIN shelves s ON s.code = il.shelf_code
      WHERE s.zone IS NOT NULL
      ${allowedOrgFilter(sql`il.org_id`)}
      ORDER BY s.zone
    `
  );
  const shelves = await queryAll<{ code: string; zone: string | null }>(
    db,
    sql`
      SELECT DISTINCT il.shelf_code AS code, s.zone
      FROM inventory_lots il
      LEFT JOIN shelves s ON s.code = il.shelf_code
      WHERE il.shelf_code IS NOT NULL
      ${allowedOrgFilter(sql`il.org_id`)}
      ORDER BY il.shelf_code
    `
  );
  const locations = await queryAll<{ orgId: number | null; subInventoryCode: string | null; description: string | null }>(
    db,
    sql`
      SELECT DISTINCT
        il.org_id AS "orgId",
        il.sub_inventory_code AS "subInventoryCode",
        oi.subinv_description AS "description"
      FROM inventory_lots il
      LEFT JOIN org_info oi ON oi.org_id = il.org_id AND oi.secondary_inventory_name = il.sub_inventory_code
      WHERE TRUE
      ${allowedOrgFilter(sql`il.org_id`)}
      ORDER BY il.org_id, il.sub_inventory_code
    `
  );
  return {
    brands: brands.map((r) => r.brand),
    zones: zones.map((r) => r.zone),
    shelves,
    locations,
  };
}
