// CN receiving scan (收貨掃描) client-side matching — a parsed supplier label
// is matched against the scan task's UNRESOLVED items by part no / WCL item
// no, space- and case-insensitive with TE AMP(...) wrappers unwrapped (same
// convention as manual receiving and the backend scan-parse matcher; spec
// 2026-11-01-cn-receiving-scan).

import type { CnScanTaskItem } from "~/services/types";
import { normalizePartNo } from "./text";

/** Null-safe normalizePartNo — "AB 123" === "ab123", "AMP(640385-8)" ===
 *  "640385-8" (TE labels carry the bare PN, master keys may be wrapped). */
export function normalizePartKey(value: string | null | undefined): string {
  return value == null ? "" : normalizePartNo(value);
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
