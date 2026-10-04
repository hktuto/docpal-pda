import type { DisplayReceivingItem, DisplayReceivingOrder } from "~/components/receiving/types";

// Client-side item grouping for the receiving order detail (spec
// 2026-10-04 PDA app rewrite): the group-by chip row re-buckets the
// already-loaded invoice items by Invoice / Carton / Part no. Pure and
// framework-free so the admin preview and tests share it.

export type ReceivingGroupBy = "invoice" | "carton" | "part-no";

type Invoice = DisplayReceivingOrder["invoices"][number];

export interface ReceivingItemSubGroup {
  key: string;
  /** Empty label = no sub-group header (e.g. invoice mode without cartons). */
  label: string;
  items: DisplayReceivingItem[];
}

export interface ReceivingItemGroup {
  key: string;
  label: string;
  /** Items fully received (expected known and receivedQty covers it). */
  receivedCount: number;
  totalCount: number;
  /** Summed expected qty across lines; null when any line's qty is unknown. */
  expectedQty: number | null;
  /** Summed received qty across lines. */
  receivedQty: number;
  subGroups: ReceivingItemSubGroup[];
}

/** An item counts as received when its expected qty is known and covered. */
export function isItemFullyReceived(item: DisplayReceivingItem): boolean {
  return item.lineQty !== null && item.receivedQty >= item.lineQty;
}

function summarize(key: string, label: string, subGroups: ReceivingItemSubGroup[]): ReceivingItemGroup {
  const items = subGroups.flatMap((g) => g.items);
  let expectedQty: number | null = 0;
  let receivedQty = 0;
  let receivedCount = 0;
  for (const item of items) {
    if (item.lineQty === null) expectedQty = null;
    else if (expectedQty !== null) expectedQty += item.lineQty;
    receivedQty += item.receivedQty;
    if (isItemFullyReceived(item)) receivedCount += 1;
  }
  return {
    key,
    label,
    receivedCount,
    totalCount: items.length,
    expectedQty,
    receivedQty,
    subGroups,
  };
}

function partKey(item: DisplayReceivingItem): string {
  return item.wclItemNo ?? item.partNo;
}

/** Carton sub-bucketing within one invoice — today's hardcoded behavior. */
function cartonSubGroups(items: DisplayReceivingItem[], noCartonLabel: string): ReceivingItemSubGroup[] {
  if (!items.some((i) => i.ctnNo)) {
    return [{ key: "__all__", label: "", items }];
  }
  const byCarton = new Map<string, DisplayReceivingItem[]>();
  const noCarton: DisplayReceivingItem[] = [];
  for (const item of items) {
    if (item.ctnNo) {
      const group = byCarton.get(item.ctnNo) ?? [];
      group.push(item);
      byCarton.set(item.ctnNo, group);
    } else {
      noCarton.push(item);
    }
  }
  const groups: ReceivingItemSubGroup[] = [...byCarton.entries()].map(([ctnNo, groupItems]) => ({
    key: ctnNo,
    label: ctnNo,
    items: groupItems,
  }));
  if (noCarton.length > 0) {
    groups.push({ key: "__none__", label: noCartonLabel, items: noCarton });
  }
  return groups;
}

function bucketBy(
  items: DisplayReceivingItem[],
  keyOf: (item: DisplayReceivingItem) => string | null,
  nullLabel: string | null
): ReceivingItemGroup[] {
  const byKey = new Map<string, DisplayReceivingItem[]>();
  const noKey: DisplayReceivingItem[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (key) {
      const group = byKey.get(key) ?? [];
      group.push(item);
      byKey.set(key, group);
    } else {
      noKey.push(item);
    }
  }
  const groups = [...byKey.entries()].map(([key, groupItems]) =>
    summarize(key, key, [{ key: "__all__", label: "", items: groupItems }])
  );
  if (noKey.length > 0 && nullLabel !== null) {
    groups.push(summarize("__none__", nullLabel, [{ key: "__all__", label: "", items: noKey }]));
  }
  return groups;
}

export interface ReceivingGroupingLabels {
  noCarton: string;
}

/**
 * Bucket an order's items per the group-by choice:
 * - invoice: one group per invoice; inside, items sub-group by carton
 *   (single unlabeled sub-group when the invoice has no carton numbers).
 * - carton: groups keyed by carton across invoices; carton-less items form a
 *   trailing "no carton" group.
 * - part-no: groups keyed by WCL item no (fallback part no), merging
 *   expected/received qty across lines and invoices; expanding a group shows
 *   the underlying PO/line item rows.
 */
export function groupReceivingItems(
  invoices: Invoice[],
  groupBy: ReceivingGroupBy,
  labels: ReceivingGroupingLabels
): ReceivingItemGroup[] {
  if (groupBy === "invoice") {
    return invoices.map((invoice) =>
      summarize(
        invoice.id,
        invoice.invoiceNo,
        cartonSubGroups(invoice.items, labels.noCarton)
      )
    );
  }
  const items = invoices.flatMap((invoice) => invoice.items);
  if (groupBy === "carton") {
    return bucketBy(items, (item) => item.ctnNo || null, labels.noCarton);
  }
  return bucketBy(items, partKey, null);
}
