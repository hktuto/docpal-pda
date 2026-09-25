import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll } from "./query.js";
import { normalizePartNo } from "./scanParse.js";
import { allowedOrgFilter } from "./org-filter.js";
import { outdatedStockYears } from "../config.js";

// ---------------------------------------------------------------------------
// WWYY date codes (2-digit ISO week + 2-digit year, e.g. "3726" = week 37 of
// 2026) — the real-data format, mirrored by apps/admin/utils/dateCode.ts.
// rank = year*100 + week orders codes correctly; a lexicographic string
// compare does NOT ("5221" = 2021w52 sorts after "0322" = 2022w03 as strings
// but is chronologically earlier).
// ---------------------------------------------------------------------------

/** Comparable rank (fullYear * 100 + week) for a WWYY code; null when
 *  invalid. The 2-digit year is windowed: 2000+YY, minus 100 when that lands
 *  more than a year in the future (date codes are never from the future —
 *  "3896" is 1996, not 2096). */
export function dateCodeRank(code: string | null | undefined, ref: Date = new Date()): number | null {
  if (!code || !/^\d{4}$/.test(code)) return null;
  const week = Number(code.slice(0, 2));
  if (week < 1 || week > 53) return null;
  let fullYear = 2000 + Number(code.slice(2));
  if (fullYear > ref.getUTCFullYear() + 1) fullYear -= 100;
  return fullYear * 100 + week;
}

/** ISO-8601 week of a UTC instant as a WWYY code. */
export function dateToDateCode(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${String(week).padStart(2, "0")}${String(thursday.getUTCFullYear() % 100).padStart(2, "0")}`;
}

/** Rank of the WWYY code exactly `years` before ref — the outdated threshold. */
function outdatedThresholdRank(years: number, ref: Date = new Date()): number {
  const d = new Date(Date.UTC(ref.getUTCFullYear() - years, ref.getUTCMonth(), ref.getUTCDate()));
  return dateCodeRank(dateToDateCode(d))!;
}

/** SQL rank expression for inventory_lots.date_code (aliased il) — mirrors
 *  dateCodeRank including the 2-digit-year window (a YY landing more than a
 *  year ahead of the DB clock is read as a century earlier). */
const DC_RANK = sql`((2000 + right(il.date_code, 2)::int) - CASE WHEN 2000 + right(il.date_code, 2)::int > EXTRACT(YEAR FROM now())::int + 1 THEN 100 ELSE 0 END) * 100 + left(il.date_code, 2)::int`;
/** SQL guard: date_code is a well-formed WWYY code (week 01–53). */
const DC_VALID = sql`il.date_code ~ '^[0-9]{4}$' AND left(il.date_code, 2)::int BETWEEN 1 AND 53`;

// ---------------------------------------------------------------------------
// Stock search (read-only). One aggregate query replaces the old 3-call
// cascade (/stock-search/suppliers → /suppliers/:id/parts → /parts/lots):
// lots are the primary result, `parts` is the distinct part list of those
// lots with onHandQty = Σ total_qty over the matching lots of that part.
//
// Filter semantics (all optional, ANDed):
//   - partNo: case-insensitive substring on parts.part_no OR
//     parts.wcl_item_no, normalized with the same normalizePartNo as scan
//     matching (uppercase + all whitespace stripped) — the column side
//     applies the identical transform in SQL.
//   - drawingNo: same normalized-substring semantics as partNo, on
//     inventory_lots.drawing_no.
//   - shelfCode: any-of match on the lot's shelf_code.
//   - zone: any-of match on the shelf's zone (shelves join; lots whose shelf
//     has no zone never match).
//   - brand: any-of match on the part's brand (parts.brand).
//   - orgId / subInventoryCode: any-of match on the lot's location pair.
//   - dateCodeFrom / dateCodeTo: WWYY date-code range, ranked as
//     year*100+week (NOT lexicographic — "5221" < "0322" chronologically);
//     lots with NULL/invalid date codes never match once a bound is set.
//   - supplierCode: the lot traces to the supplier via inventory_lot_sources →
//     receiving_invoice_items → receiving_invoices → receiving_orders —
//     filtered on receiving_orders.supplier_code, mirroring the old
//     /stock-search/suppliers/:id/parts join.
// Zero-qty lots are returned: the old /stock-search/parts/lots had no
// total_qty filter (the >0 rule was only the suppliers-stats CTE and a
// client-side "only with inventory" toggle), so it is mirrored here.
// No actorId, no mutations, no allocateAll.
//
// Opt-in paging: searchStock(db, filters, { page, pageSize?, sort?, dir? })
// with `page` defined returns `{ rows, total }` — LIMIT/OFFSET + COUNT over
// the same FROM/WHERE, no `parts` aggregate (a whole-result aggregate the
// admin doesn't use). Without `page` the legacy full `{ parts, lots }`
// response is returned unchanged (the PDA consumes that shape). Sorting is a
// key whitelist (LOT_SORTS); unknown/missing keys fall back to the default
// order, which is always appended as tiebreakers for stable pagination.
// ---------------------------------------------------------------------------

export interface StockSearchFilters {
  supplierCode?: string[];
  partNo?: string;
  drawingNo?: string;
  shelfCode?: string[];
  zone?: string[];
  brand?: string[];
  orgId?: number[];
  subInventoryCode?: string[];
  /** WWYY date-code range bounds (either optional; swapped bounds are
   *  normalized). When a bound is set, lots with NULL/invalid date codes
   *  never match. */
  dateCodeFrom?: string;
  dateCodeTo?: string;
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
  drawingNo: string | null;
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
  /** Filter values for the admin dropdowns: brands/zones/shelves are the
   *  distinct values present in stock; locations are every org_info pair
   *  within the allowed orgs (whether stocked or not), so the org/sub-inventory
   *  filters can target locations that currently hold no stock. officeCode is
   *  the org's org_info.office_code (the org dropdown label). */
  locations: { orgId: number | null; subInventoryCode: string | null; description: string | null; officeCode: string | null }[];
}

export interface StockSearchResult {
  parts: StockSearchPartRow[];
  lots: StockSearchLotRow[];
}

/** Opt-in paging/sorting for searchStock. When `page` is defined the result
 *  switches to StockSearchPage (`{ rows, total }`). */
export interface StockSearchPaging {
  page?: number;
  pageSize?: number;
  /** Sort key — whitelist in LOT_SORTS; unknown keys fall back to the
   *  default order. */
  sort?: string;
  dir?: "asc" | "desc";
}

/** Paged lot rows (no `parts` — a whole-result aggregate the admin doesn't
 *  use). */
export interface StockSearchPage {
  rows: StockSearchLotRow[];
  total: number;
}

/** Overall (unfiltered) stock totals for the admin summary header. */
export interface StockSearchSummary {
  /** Distinct parts (joined to the parts master) present in stock. */
  partCount: number;
  lotCount: number;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  /** Distinct shelves holding at least one lot (NULL shelf_code ignored). */
  shelfCount: number;
  /** Newest last_update_date across all lots (ISO string), null when empty. */
  lastUpdateDate: string | null;
  /** Outdated threshold in force (flow config outdatedStockYears). */
  outdatedYears: number;
  /** Distinct parts with at least one outdated lot (WWYY date code older
   *  than outdatedYears). */
  outdatedPartCount: number;
  outdatedLotCount: number;
  /** Σ total_qty over outdated lots. */
  outdatedQty: number;
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
 * With `paging.page` defined the response switches to `{ rows, total }`:
 * the same lot rows (no partPk, no `parts` aggregate) with LIMIT/OFFSET +
 * COUNT, optionally sorted by a LOT_SORTS key.
 */
/** Shared FROM/WHERE fragment for the lot search, its count, and the summary
 *  aggregate — expects aliases `il` (inventory_lots), `p` (parts), `s`
 *  (shelves, LEFT JOINed). */
function stockFromWhere(filters: StockSearchFilters) {
  return sql`
    FROM inventory_lots il
    JOIN parts p ON p.wcl_item_no = il.wcl_item_no
    LEFT JOIN shelves s ON s.code = il.shelf_code
    WHERE TRUE
    ${stockFilterClauses(filters)}
  `;
}

/** Default row order — also the tiebreaker tail for stable pagination when a
 *  sort key is active. */
const DEFAULT_ORDER = sql`il.part_no, il.date_code NULLS LAST, il.shelf_code, il.box_id`;

/** Sort key whitelist → SQL expression(s), each rendered `<expr> ASC|DESC
 *  NULLS LAST` followed by the default order as tiebreakers. Keys are the
 *  admin lots-table column keys. */
const LOT_SORTS: Record<string, ReturnType<typeof sql>[]> = {
  partNo: [sql`p.wcl_item_no`], // the admin column displays wclItemNo ?? partNo (wcl_item_no NOT NULL)
  description: [sql`p.description`],
  brand: [sql`p.brand`],
  drawingNo: [sql`il.drawing_no`],
  dateCode: [sql`il.date_code`],
  lotCode: [sql`il.lot_code`],
  shelfCode: [sql`il.shelf_code`],
  zone: [sql`s.zone`],
  boxId: [sql`il.box_id`],
  orgSubInventory: [sql`il.org_id`, sql`il.sub_inventory_code`],
  totalQty: [sql`il.total_qty`],
  allocatedQty: [sql`il.allocated_qty`],
  availableQty: [sql`il.available_qty`],
};

function stockOrderBy(paging?: StockSearchPaging) {
  const exprs = paging?.sort ? LOT_SORTS[paging.sort] : undefined;
  if (!exprs?.length) return sql`ORDER BY ${DEFAULT_ORDER}`;
  const dir = paging!.dir === "desc" ? sql`DESC` : sql`ASC`;
  return sql`ORDER BY ${sql.join(
    exprs.map((e) => sql`${e} ${dir} NULLS LAST`),
    sql`, `
  )}, ${DEFAULT_ORDER}`;
}

export function searchStock(db: AppDb, filters: StockSearchFilters): Promise<StockSearchResult>;
export function searchStock(db: AppDb, filters: StockSearchFilters, paging: StockSearchPaging & { page: number }): Promise<StockSearchPage>;
export async function searchStock(
  db: AppDb,
  filters: StockSearchFilters,
  paging?: StockSearchPaging
): Promise<StockSearchResult | StockSearchPage> {
  const fromWhere = stockFromWhere(filters);
  if (paging?.page !== undefined) {
    const page = Math.max(1, paging.page);
    const pageSize = Math.min(200, Math.max(1, paging.pageSize ?? 50));
    const [rows, count] = await Promise.all([
      queryAll<StockSearchLotRow>(
        db,
        sql`
          SELECT
            il.part_no AS "partNo",
            il.date_code AS "dateCode",
            il.lot_code AS "lotCode",
            il.coo, il.cow,
            il.drawing_no AS "drawingNo",
            il.shelf_code AS "shelfCode",
            il.box_id AS "boxId",
            il.org_id AS "orgId",
            il.sub_inventory_code AS "subInventoryCode",
            il.total_qty AS "totalQty",
            il.allocated_qty AS "allocatedQty",
            il.available_qty AS "availableQty",
            p.wcl_item_no AS "wclItemNo",
            p.description,
            p.brand,
            s.zone
          ${fromWhere}
          ${stockOrderBy(paging)}
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `
      ),
      queryAll<{ total: number }>(db, sql`SELECT COUNT(*)::int AS total ${fromWhere}`),
    ]);
    return { rows, total: count[0]?.total ?? 0 };
  }
  const rows = await queryAll<LotJoinRow>(
    db,
    sql`
      SELECT
        il.part_no AS "partNo",
        il.date_code AS "dateCode",
        il.lot_code AS "lotCode",
        il.coo, il.cow,
        il.drawing_no AS "drawingNo",
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
      ${fromWhere}
      ${stockOrderBy()}
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

/** Shared WHERE fragment for the lot search and the summary aggregate —
 *  expects aliases `il` (inventory_lots), `p` (parts), `s` (shelves, LEFT
 *  JOINed). All filters optional and ANDed. */
function stockFilterClauses(filters: StockSearchFilters) {
  const partNoNorm = filters.partNo ? normalizePartNo(filters.partNo) : "";
  const drawingNoNorm = filters.drawingNo ? normalizePartNo(filters.drawingNo) : "";
  // Normalize the date-code range: ranks (year*100+week), swapped bounds
  // fixed up, invalid codes treated as unbounded.
  const fromRank = dateCodeRank(filters.dateCodeFrom);
  const toRank = dateCodeRank(filters.dateCodeTo);
  const dcLo = fromRank !== null && toRank !== null ? Math.min(fromRank, toRank) : fromRank;
  const dcHi = fromRank !== null && toRank !== null ? Math.max(fromRank, toRank) : toRank;
  return sql`
    ${allowedOrgFilter(sql`il.org_id`)}
    ${partNoNorm ? sql`AND (strpos(regexp_replace(upper(p.part_no), '\\s', '', 'g'), ${partNoNorm}) > 0 OR strpos(regexp_replace(upper(p.wcl_item_no), '\\s', '', 'g'), ${partNoNorm}) > 0)` : sql``}
    ${drawingNoNorm ? sql`AND strpos(regexp_replace(upper(il.drawing_no), '\\s', '', 'g'), ${drawingNoNorm}) > 0` : sql``}
    ${filters.shelfCode?.length ? sql`AND il.shelf_code IN (${sql.join(filters.shelfCode.map((v) => sql`${v}`), sql`, `)})` : sql``}
    ${filters.zone?.length ? sql`AND s.zone IN (${sql.join(filters.zone.map((v) => sql`${v}`), sql`, `)})` : sql``}
    ${filters.brand?.length ? sql`AND p.brand IN (${sql.join(filters.brand.map((v) => sql`${v}`), sql`, `)})` : sql``}
    ${filters.orgId?.length ? sql`AND il.org_id IN (${sql.join(filters.orgId.map((v) => sql`${v}`), sql`, `)})` : sql``}
    ${filters.subInventoryCode?.length ? sql`AND il.sub_inventory_code IN (${sql.join(filters.subInventoryCode.map((v) => sql`${v}`), sql`, `)})` : sql``}
    ${
      dcLo !== null || dcHi !== null
        ? sql`AND ${DC_VALID}
          ${dcLo !== null ? sql`AND ${DC_RANK} >= ${dcLo}` : sql``}
          ${dcHi !== null ? sql`AND ${DC_RANK} <= ${dcHi}` : sql``}`
        : sql``
    }
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
  `;
}

/**
 * Stock totals for the admin summary header: one aggregate over the lots
 * matching the given search filters ({} = overall), scoped by the same
 * allowed-org filter as searchStock. Sums are cast to int — pg returns
 * SUM(int) as a bigint string.
 * Outdated = lot WWYY date code older than the flow config's
 * outdatedStockYears (lots with NULL/invalid date codes never count).
 */
export async function stockSearchSummary(db: AppDb, filters: StockSearchFilters = {}): Promise<StockSearchSummary> {
  const years = outdatedStockYears();
  const thresholdRank = outdatedThresholdRank(years);
  const outdated = sql`${DC_VALID} AND ${DC_RANK} < ${thresholdRank}`;
  const [row] = await queryAll<{
    partCount: number;
    lotCount: number;
    totalQty: number;
    allocatedQty: number;
    availableQty: number;
    shelfCount: number;
    lastUpdateDate: Date | string | null;
    outdatedPartCount: number;
    outdatedLotCount: number;
    outdatedQty: number;
  }>(
    db,
    sql`
      SELECT
        COUNT(DISTINCT p.id)::int AS "partCount",
        COUNT(*)::int AS "lotCount",
        COALESCE(SUM(il.total_qty), 0)::int AS "totalQty",
        COALESCE(SUM(il.allocated_qty), 0)::int AS "allocatedQty",
        COALESCE(SUM(il.total_qty - il.allocated_qty), 0)::int AS "availableQty",
        COUNT(DISTINCT il.shelf_code)::int AS "shelfCount",
        MAX(il.last_update_date) AS "lastUpdateDate",
        COUNT(DISTINCT p.id) FILTER (WHERE ${outdated})::int AS "outdatedPartCount",
        COUNT(*) FILTER (WHERE ${outdated})::int AS "outdatedLotCount",
        COALESCE(SUM(il.total_qty) FILTER (WHERE ${outdated}), 0)::int AS "outdatedQty"
      FROM inventory_lots il
      JOIN parts p ON p.wcl_item_no = il.wcl_item_no
      LEFT JOIN shelves s ON s.code = il.shelf_code
      WHERE TRUE
      ${stockFilterClauses(filters)}
    `
  );
  return {
    partCount: row?.partCount ?? 0,
    lotCount: row?.lotCount ?? 0,
    totalQty: row?.totalQty ?? 0,
    allocatedQty: row?.allocatedQty ?? 0,
    availableQty: row?.availableQty ?? 0,
    shelfCount: row?.shelfCount ?? 0,
    lastUpdateDate: row?.lastUpdateDate ? new Date(row.lastUpdateDate).toISOString() : null,
    outdatedYears: years,
    outdatedPartCount: row?.outdatedPartCount ?? 0,
    outdatedLotCount: row?.outdatedLotCount ?? 0,
    outdatedQty: row?.outdatedQty ?? 0,
  };
}

/**
 * Filter values for the admin filter dropdowns. brands/zones/shelves are the
 * distinct values present in the current stock (scoped by the same allowed-org
 * filter as searchStock); locations come from org_info — every
 * (org_id, secondary_inventory_name) pair within the allowed orgs, whether or
 * not it holds stock — so the org/sub-inventory dropdowns always match the
 * org_info master rather than whatever happens to be stocked.
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
  const locations = await queryAll<{ orgId: number | null; subInventoryCode: string | null; description: string | null; officeCode: string | null }>(
    db,
    sql`
      SELECT
        oi.org_id AS "orgId",
        oi.secondary_inventory_name AS "subInventoryCode",
        oi.subinv_description AS "description",
        oi.office_code AS "officeCode"
      FROM org_info oi
      WHERE TRUE
      ${allowedOrgFilter(sql`oi.org_id`)}
      ORDER BY oi.org_id, oi.secondary_inventory_name
    `
  );
  return {
    brands: brands.map((r) => r.brand),
    zones: zones.map((r) => r.zone),
    shelves,
    locations,
  };
}
