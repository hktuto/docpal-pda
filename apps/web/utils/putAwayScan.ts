import { normalize } from "~/composables/useMockOcr";
import type { PutAwayExpectedItem } from "~/services/types";

/**
 * First item whose part number matches (normalized) and whose remaining qty
 * fits the scanned qty. `remainingQty` is already net of staged scans
 * (server-side, see apps/backend/src/db/putaway.ts). Same first-fit rule as
 * the picking scan queue's findTarget.
 */
export function findPutAwayTarget(
  items: PutAwayExpectedItem[],
  partNo: string,
  qty: number
): PutAwayExpectedItem | null {
  const wanted = normalize(partNo ?? "");
  if (!wanted || !Number.isInteger(qty) || qty <= 0) return null;
  for (const item of items) {
    if (normalize(item.partNo ?? "") !== wanted) continue;
    if (qty <= (item.remainingQty ?? 0)) return item;
  }
  return null;
}
