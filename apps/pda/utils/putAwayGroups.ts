import { normalizePartNo } from "~/utils/text";
import { putAwayItemFieldValue } from "~/utils/viewConfig";
import type { PutAwayExpectedItem } from "~/services/types";

/** One put-away card: all visible lines of the same part on the order,
 *  merged for display (spec 2026-10-05-put-away-part-grouping-design).
 *  The per-line rows are kept in `items` — writes stay per-line. */
export interface PutAwayItemGroup {
  /** Group identity = normalizePartNo(partNo); also the card's scroll anchor. */
  key: string;
  partNo: string;
  wclItemNo: string | null;
  /** Member lines in list order. */
  items: PutAwayExpectedItem[];
  /** Summed qty fields (lineQty null when any member is null). */
  lineQty: number | null;
  receivedQty: number;
  putAwayQty: number;
  remainingQty: number;
  /** Staged (unboxed) scan qty across the member lines. */
  stagedQty: number;
}

/** Group visible put-away lines by part number (space-insensitive), in first-
 *  appearance order. Single-member groups render exactly like the old cards. */
export function groupPutAwayItems(
  items: PutAwayExpectedItem[],
  stagedQtyByItem: Record<string, number>
): PutAwayItemGroup[] {
  const groups: PutAwayItemGroup[] = [];
  const byKey = new Map<string, PutAwayItemGroup>();
  for (const item of items) {
    const key = normalizePartNo(item.partNo);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        partNo: item.partNo,
        wclItemNo: item.wclItemNo,
        items: [],
        lineQty: 0,
        receivedQty: 0,
        putAwayQty: 0,
        remainingQty: 0,
        stagedQty: 0,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
    if (item.lineQty == null) group.lineQty = null;
    else if (group.lineQty != null) group.lineQty += item.lineQty;
    group.receivedQty += item.receivedQty;
    group.putAwayQty += item.putAwayQty;
    group.remainingQty += item.remainingQty;
    group.stagedQty += stagedQtyByItem[item.id] ?? 0;
  }
  return groups;
}

/** Qty catalog fields are summed; batch/location fields render the distinct
 *  member values joined (empty excluded, all empty → the no-data dash).
 *  po_no/box_id stay no-data, matching putAwayItemFieldValue. */
const GROUP_SUM_FIELDS = new Set(["expected_qty", "received_qty", "remaining_qty"]);

export function putAwayGroupFieldValue(field: string, group: PutAwayItemGroup): string {
  if (GROUP_SUM_FIELDS.has(field)) {
    switch (field) {
      case "expected_qty": return String(group.lineQty ?? "—");
      case "received_qty": return String(group.receivedQty);
      default: return String(group.remainingQty);
    }
  }
  const distinct = [
    ...new Set(
      group.items
        .map((item) => putAwayItemFieldValue(field, item))
        .filter((v) => v && v !== "—")
    ),
  ];
  return distinct.length ? distinct.join(" / ") : "—";
}
