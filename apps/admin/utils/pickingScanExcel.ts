import type { PickingOrderDetail } from "~/utils/flowApi";
import { toLabelDateCode, type DateCodeFormat } from "~/utils/dateCode";

/**
 * Picked-scan Excel (picking_finished view "download scan excel"): one row
 * per picking_packages row, in SCAN ORDER — the backend returns packages
 * ordered by created_date, id. Pure: returns an AOA; the caller does the
 * XLSX.write (aoa_to_sheet / writeFile).
 */

export const PICKING_SCAN_EXCEL_HEADERS = [
  "#",
  "order_no",
  "wcl_item_no",
  "qty",
  "date_code_yyyymmdd",
  "date_code_original",
  "coo",
  "cow",
  "drawing_no",
  "box_no",
  "box_index",
] as const;

/** YYWW → the Thursday of that ISO week as yyyymmdd (e.g. "2601" → "20260101").
 *  Jan 4 is always in ISO week 1; walk back to its Monday, add (week-1)*7
 *  days, then +3 for the Thursday. Returns null for invalid/absent codes. */
export function canonicalDateCodeToYyyymmdd(code: string | null | undefined): string | null {
  if (!code || !/^\d{4}$/.test(code)) return null;
  const year = 2000 + Number(code.slice(0, 2));
  const week = Number(code.slice(2, 4));
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Monday = new Date(jan4);
  jan4Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const thursday = new Date(jan4Monday);
  thursday.setUTCDate(jan4Monday.getUTCDate() + 7 * (week - 1) + 3);
  const y = thursday.getUTCFullYear();
  if (y !== year) return null; // week 53 that belongs to the next ISO year
  const m = String(thursday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(thursday.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

type PickingPackage = PickingOrderDetail["items"][number]["packages"][number];

export interface PickingScanExcelInput {
  order: PickingOrderDetail;
  /** Date-code format config (canonical YYWW vs label WWYY) — used to
   *  reconstruct the original label-format date code. */
  dateCodeFormat: DateCodeFormat;
  /** Boxes in display order — box_index is "position/total" by this order. */
}

/** One row per package, in scan order. Effective date code = pick-time
 *  scanned value when set, else the source snapshot. */
export function buildPickingScanAoa(
  input: PickingScanExcelInput
): (string | number)[][] {
  const { order, dateCodeFormat } = input;
  const boxIds = (order.boxes ?? []).map((b) => b.id);
  const rows: (string | number)[][] = [[...PICKING_SCAN_EXCEL_HEADERS]];
  let seq = 1;
  const emit = (wcl: string, p: PickingPackage) => {
    const canonical = p.scannedDateCode ?? p.dateCode;
    const yyyymmdd = canonicalDateCodeToYyyymmdd(canonical) ?? "";
    const original = canonical ? (toLabelDateCode(canonical, dateCodeFormat) ?? canonical) : "";
    const boxIdx = p.shippingBoxId ? boxIds.indexOf(p.shippingBoxId) : -1;
    rows.push([
      seq++,
      order.orderNo,
      wcl,
      p.qty,
      yyyymmdd,
      original,
      p.scannedCoo ?? p.coo ?? "",
      p.scannedCow ?? p.cow ?? "",
      p.scannedDrawingNo ?? p.drawingNo ?? "",
      boxIdx >= 0 ? boxIdx + 1 : "",
      boxIdx >= 0 ? `${boxIdx + 1}/${boxIds.length}` : "",
    ]);
  };
  // Per-item packages first (item-bound rows, legacy + item scans), then the
  // order-level scan record (unbound aggregate rows, 2026-11-19) — the flat
  // one-line-per-scan truth.
  for (const item of order.items ?? []) {
    if (item.status === "cancelled") continue;
    for (const p of item.packages ?? []) emit(item.wclItemNo ?? item.partNo, p);
  }
  for (const p of order.orderScanRecord ?? []) {
    emit(p.scannedWclItemNo ?? p.scannedPartNo ?? "", p);
  }
  return rows;
}
