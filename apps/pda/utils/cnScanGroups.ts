import type { CnScanTaskItem } from "~/services/types";
import { normalizePartKey } from "./cnReceivingScan";

// CN receiving scan (收貨掃描) display grouping (spec
// 2026-11-04-cn-receiving-scan-grouping): the detail page renders one row per
// (part, dateCode, COO, COW) group instead of one per invoice line. Scan
// matching itself is server-side (POST .../scan-aggregate) — this util is
// display-only.

export type CnScanGroupStatus = "error" | "over" | "complete" | "partial" | "open";

/** One scannable row: lines sharing part identity + batch fields, with
 *  summed quantities and a derived group status. */
export interface CnScanGroup {
  key: string;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  coo: string | null;
  cow: string | null;
  /** Summed scanned qty across member lines (null scanQty counts as 0). */
  scanQty: number;
  /** Summed expected qty; null when any member lineQty is unknown (OCR gap). */
  lineQty: number | null;
  status: CnScanGroupStatus;
  /** Unique PO numbers of the member lines, first-seen order. */
  poNos: string[];
  items: CnScanTaskItem[];
}

function norm(value: string | null | undefined): string {
  return value == null ? "" : value.trim().toUpperCase();
}

export function cnScanGroupKey(item: CnScanTaskItem): string {
  return [
    normalizePartKey(item.wclItemNo || item.partNo),
    norm(item.dateCode),
    norm(item.coo),
    norm(item.cow),
  ].join("|");
}

function deriveStatus(items: CnScanTaskItem[], scanQty: number, lineQty: number | null): CnScanGroupStatus {
  if (items.some((i) => i.scanStatus === "error")) return "error";
  if (lineQty == null) return scanQty > 0 ? "partial" : "open";
  if (scanQty > lineQty) return "over";
  if (scanQty === lineQty && scanQty > 0) return "complete";
  if (scanQty > 0) return "partial";
  return "open";
}

/** Group the task's items per part + batch combo. First-seen group order and
 *  line order within a group are preserved (stable). */
export function buildCnScanGroups(items: CnScanTaskItem[]): CnScanGroup[] {
  const groups = new Map<string, CnScanGroup>();
  for (const item of items) {
    const key = cnScanGroupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        partNo: item.partNo,
        wclItemNo: item.wclItemNo,
        dateCode: item.dateCode,
        coo: item.coo,
        cow: item.cow,
        scanQty: 0,
        lineQty: 0,
        status: "open",
        poNos: [],
        items: [],
      };
      groups.set(key, group);
    }
    group.scanQty += item.scanQty ?? 0;
    if (group.lineQty != null) {
      group.lineQty = item.lineQty == null ? null : group.lineQty + item.lineQty;
    }
    if (item.poNo && !group.poNos.includes(item.poNo)) group.poNos.push(item.poNo);
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.status = deriveStatus(group.items, group.scanQty, group.lineQty);
  }
  return [...groups.values()];
}
