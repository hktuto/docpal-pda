import { normalizePartNo } from "~/utils/text";
import type { PutAwayBox, PutAwayExpectedItem, Shelf } from "~/services/types";

/**
 * Where a hardware scan on the put-away page should go, checked in order:
 * shelf label (exact shelf code) → box label (an order's placed box id, the
 * order's staging box id, or a `BOX-*` generated-format id) → anything else is
 * a supplier item label. Box ids that are neither the order's nor
 * `BOX-*`-prefixed fall through to the item flow — the scan-box dialog remains
 * the entry point for those.
 */
export type PutAwayScanClass =
  | { type: "shelf"; code: string }
  | { type: "box"; boxId: string; existing: PutAwayBox | null; staging: boolean }
  | { type: "item" };

export function classifyPutAwayScan(
  raw: string,
  shelves: Shelf[],
  boxes: PutAwayBox[],
  stagingBoxId?: string | null
): PutAwayScanClass {
  const value = raw.trim();
  if (!value) return { type: "item" };
  const upper = value.toUpperCase();
  const shelf = shelves.find((s) => s.code.toUpperCase() === upper);
  if (shelf) return { type: "shelf", code: shelf.code };
  const existing = boxes.find((b) => b.id.toUpperCase() === upper) ?? null;
  if (existing) return { type: "box", boxId: existing.id, existing, staging: false };
  if (stagingBoxId && stagingBoxId.toUpperCase() === upper)
    return { type: "box", boxId: stagingBoxId, existing: null, staging: true };
  if (/^box-/i.test(value)) return { type: "box", boxId: value, existing: null, staging: false };
  return { type: "item" };
}

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

/**
 * Like findPutAwayTarget, but allows one label's qty to span several order
 * lines with the same part (the same part may sit on multiple invoice
 * lines, e.g. 300 + 20000 — a 20300 package covers neither line alone).
 * Consumes lines in list order, each capped at its remainingQty, returning
 * one portion per line touched, or null when the aggregated remaining of
 * all matching lines cannot cover the qty. Every portion is written as its
 * own per-line scan so the backend's per-line guards stay intact.
 */
export function findPutAwayTargets(
  items: PutAwayExpectedItem[],
  partNo: string,
  qty: number,
  wclItemNo?: string
): { item: PutAwayExpectedItem; qty: number }[] | null {
  const scannedKeys = [partNo, wclItemNo]
    .filter((v): v is string => !!v)
    .map((v) => normalizePartNo(v));
  if (scannedKeys.length === 0 || !Number.isInteger(qty) || qty <= 0) return null;
  const portions: { item: PutAwayExpectedItem; qty: number }[] = [];
  let remaining = qty;
  for (const item of items) {
    const itemKeys = [item.partNo, item.wclItemNo]
      .filter((v): v is string => !!v)
      .map((v) => normalizePartNo(v));
    if (!itemKeys.some((k) => scannedKeys.includes(k))) continue;
    const available = item.remainingQty ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    portions.push({ item, qty: take });
    remaining -= take;
    if (remaining === 0) return portions;
  }
  return null;
}
