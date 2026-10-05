import { normalizePartNo } from "~/utils/text";
import type { PutAwayExpectedItem } from "~/services/types";

/**
 * First item whose part number or WCL item no matches the label's part no /
 * WCL item no (space-insensitive — same key rule as the picking scan queue's
 * findTarget) and whose remaining qty fits the scanned qty. `remainingQty` is
 * already net of staged scans (server-side, see apps/backend/src/db/putaway.ts).
 * Supplier templates return space-stripped item ids (collapseSpaces in
 * parseOcrScan.ts), so a space-preserving compare would miss parts whose
 * master part number contains spaces.
 */
export function findPutAwayTarget(
  items: PutAwayExpectedItem[],
  partNo: string,
  qty: number,
  wclItemNo?: string
): PutAwayExpectedItem | null {
  const scannedKeys = [partNo, wclItemNo]
    .filter((v): v is string => !!v)
    .map((v) => normalizePartNo(v));
  if (scannedKeys.length === 0 || !Number.isInteger(qty) || qty <= 0) return null;
  for (const item of items) {
    const itemKeys = [item.partNo, item.wclItemNo]
      .filter((v): v is string => !!v)
      .map((v) => normalizePartNo(v));
    if (!itemKeys.some((k) => scannedKeys.includes(k))) continue;
    if (qty <= (item.remainingQty ?? 0)) return item;
  }
  return null;
}
