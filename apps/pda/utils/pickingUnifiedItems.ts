// Pure logic for the picking unified list (spec
// docs/superpowers/specs/2026-10-12-picking-unified-detail-scan-design.md §5):
// collapsed-line rendering (both collapsedStyle modes) and pending-scan
// aggregation. Framework-free (no vue import) so it unit-tests in the
// node-env vitest suite; the component owns markup and passes i18n `t`.

import type { PickingOrderDetail } from "~/services/types";
import type { ScanQueueRow } from "~/composables/usePickingScanQueue";
import type { PdaDetailCollapsedStyle } from "~/utils/viewConfig";
import { formatCompactQtyUpper } from "~/utils/formatNumber";
import { normalizePartNo } from "~/utils/text";
import { IDENTITY_DETAIL_FIELDS, PICKING_GROUP_FIELDS } from "~/utils/viewConfig";

type PickingItem = PickingOrderDetail["items"][number];

/** Allocation display form (merged across a part group's lines/sources). */
export interface UnifiedAllocation {
  lot: {
    lotCode: string | null;
    dateCode: string | null;
    coo: string | null;
    cow: string | null;
  } | null;
  boxId: string | null;
  qty: number;
}

/** Collapsed line-2 input (everything the formatters need). */
export interface UnifiedCollapsedMetaArgs {
  scannedQty: number;
  qty: number;
  queuedQty: number;
  actionable: boolean;
  collapsedStyle: PdaDetailCollapsedStyle;
  itemFields: readonly string[];
  allocations: UnifiedAllocation[];
}

export type TranslateFn = (key: string) => string;

/**
 * Collapsed row's second line.
 *
 * "allocations" (default): `{scanned}/{required}` in compact KMB form, then —
 * when the queue holds rows for this part — ` (+{queued} pending)`, then
 * ` · {required}({chip}, {chip})` with one chip per open allocation
 * (`{qtyCompact} lot-date-coo-cow` / `CTN {boxId}` / receiving-area label).
 * Allocation chips render only while the group is not fully scanned.
 *
 * "fields": the itemFields-driven meta line (pre-2026-10-12 behavior).
 */
export function unifiedCollapsedMeta(args: UnifiedCollapsedMetaArgs, t: TranslateFn): string {
  if (args.collapsedStyle === "fields") {
    const parts: string[] = [];
    for (const field of args.itemFields) {
      if (IDENTITY_DETAIL_FIELDS.has(field) || !PICKING_GROUP_FIELDS.has(field)) continue;
      if (field === "qty") parts.push(`${t("picking.itemsSection.requiredQty")}: ${args.qty}`);
      else if (field === "picked_qty") parts.push(`${t("picking.itemsSection.scannedQty")}: ${args.scannedQty}`);
      else if (field === "allocated_qty") {
        parts.push(`${t("picking.itemsSection.allocatedQty")}: ${args.allocations.reduce((s, a) => s + a.qty, 0)}`);
      }
    }
    return parts.join(" · ");
  }
  const progress = [`${formatCompactQtyUpper(args.scannedQty)}/${formatCompactQtyUpper(args.qty)}`];
  if (args.queuedQty > 0) {
    progress.push(`(+${formatCompactQtyUpper(args.queuedQty)} ${t("picking.unified.pending")})`);
  }
  const parts = [progress.join(" ")];
  if (args.actionable && args.scannedQty < args.qty && args.allocations.length > 0) {
    const chips = args.allocations.map((a) => `${formatCompactQtyUpper(a.qty)} ${allocationChipLabel(a, t)}`);
    parts.push(`${formatCompactQtyUpper(args.qty)}(${chips.join(", ")})`);
  }
  return parts.join(" · ");
}

/** Allocation chip suffix: `lot-date-coo-cow` (empties skipped), the carton
 *  id for receiving-carton sources, or the receiving-area label. */
export function allocationChipLabel(a: UnifiedAllocation, t: TranslateFn): string {
  if (a.lot) {
    return [a.lot.lotCode, a.lot.dateCode, a.lot.coo, a.lot.cow]
      .filter((v): v is string => !!v && v.trim() !== "")
      .join("-");
  }
  if (a.boxId) return `CTN ${a.boxId}`;
  return t("picking.itemsSection.receivingArea");
}

/** One aggregated pending-scan line of a part group. */
export interface PendingGroup {
  key: string;
  keys: string[];
  qty: number;
  lotCode: string | null;
  dateCode: string | null;
  source: "qr" | "ocr" | "mixed";
  status: "queued" | "failed";
  error: string | null;
}

/** Pending/failed queue rows of one part group, aggregated per batch (part +
 *  lot/date/coo/cow) — one label may span several allocations. */
export function pendingScanGroups(items: PickingItem[], queueRows: ScanQueueRow[]): PendingGroup[] {
  const itemIds = new Set(items.map((i) => i.id));
  const groups = new Map<string, PendingGroup>();
  for (const row of queueRows) {
    if (!itemIds.has(row.itemId)) continue;
    const gk = [normalizePartNo(row.partNo), row.lotCode ?? "", row.dateCode ?? "", row.coo ?? "", row.cow ?? ""].join("|");
    const g = groups.get(gk);
    if (g) {
      g.keys.push(row.key);
      g.qty += row.qty;
      if (g.source !== row.source) g.source = "mixed";
      if (row.status === "failed") {
        g.status = "failed";
        g.error = row.error;
      }
    } else {
      groups.set(gk, {
        key: row.key,
        keys: [row.key],
        qty: row.qty,
        lotCode: row.lotCode,
        dateCode: row.dateCode,
        source: row.source,
        status: row.status === "failed" ? "failed" : "queued",
        error: row.error,
      });
    }
  }
  return [...groups.values()];
}
