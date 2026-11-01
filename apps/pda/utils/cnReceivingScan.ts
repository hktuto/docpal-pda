// CN receiving scan (收貨掃描) client-side matching — a parsed supplier label
// is matched against the scan task's UNRESOLVED items by part no / WCL item
// no, space- and case-insensitive (same convention as manual receiving and
// the backend scan-parse matcher; spec 2026-11-01-cn-receiving-scan).

import type { CnScanTaskItem } from "~/services/types";

/** Trim, uppercase, and strip ALL whitespace — "AB 123" === "ab123". */
export function normalizePartKey(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** The label fields that identify a part (from parseOcrScan's ParsedFields). */
export interface CnScanLabelPart {
  itemId?: string | null;
  wclItemNo?: string | null;
}

/**
 * Unresolved items whose partNo or wclItemNo matches the label's itemId or
 * wclItemNo (any cross combination, space/case-insensitive). Empty label
 * keys match nothing.
 */
export function findCnScanMatches(items: CnScanTaskItem[], label: CnScanLabelPart): CnScanTaskItem[] {
  const labelKeys = new Set(
    [normalizePartKey(label.itemId), normalizePartKey(label.wclItemNo)].filter((k) => k !== "")
  );
  if (labelKeys.size === 0) return [];
  return items.filter(
    (item) =>
      item.scanStatus === null &&
      ((item.partNo && labelKeys.has(normalizePartKey(item.partNo))) ||
        (item.wclItemNo && labelKeys.has(normalizePartKey(item.wclItemNo))))
  );
}
