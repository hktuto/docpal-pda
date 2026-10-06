import type { PartAvailabilityStockRow } from "~/utils/flowApi";

// Stock-lot table helpers shared by the picking/receiving part-availability
// modals: client-side sorting and the combined location column (spec
// docs/superpowers/specs/2026-10-06-admin-availability-dialog-improvements-design.md).

export type StockSortKey = "date-code" | "available-qty" | "shelf";

export const STOCK_SORT_OPTIONS: { value: StockSortKey; labelKey: string }[] = [
  { value: "date-code", labelKey: "admin.pages.pickingOrders.availabilitySortDateCode" },
  { value: "available-qty", labelKey: "admin.pages.pickingOrders.availabilitySortAvailableQty" },
  { value: "shelf", labelKey: "admin.pages.pickingOrders.availabilitySortShelf" },
];

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortStockRows(rows: PartAvailabilityStockRow[], key: StockSortKey): PartAvailabilityStockRow[] {
  const sorted = [...rows];
  const shelf = (r: PartAvailabilityStockRow) => (r.shelfDisplayName ?? r.shelfCode ?? "").toLowerCase();
  const byDateCode = (a: PartAvailabilityStockRow, b: PartAvailabilityStockRow) => {
    // WWYY strings are fixed-width — plain lexicographic order works.
    if (!a.dateCode) return b.dateCode ? 1 : 0;
    if (!b.dateCode) return -1;
    return cmpStr(a.dateCode, b.dateCode);
  };
  if (key === "available-qty") {
    sorted.sort((a, b) => b.availableQty - a.availableQty || byDateCode(a, b));
  } else if (key === "shelf") {
    sorted.sort((a, b) => cmpStr(shelf(a), shelf(b)) || byDateCode(a, b));
  } else {
    // date-code (default): ascending, empty last; ties by available desc.
    sorted.sort((a, b) => byDateCode(a, b) || b.availableQty - a.availableQty);
  }
  return sorted;
}

// Combined `shelf - date code - coo - cow` cell ("—" when all parts empty).
export function formatStockLocation(r: PartAvailabilityStockRow): string {
  const parts = [r.shelfDisplayName ?? r.shelfCode, r.dateCode, r.coo, r.cow].filter(
    (p): p is string => !!p
  );
  return parts.length > 0 ? parts.join(" - ") : "—";
}
