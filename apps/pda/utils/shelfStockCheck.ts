import type { PickingShelfStockQuery } from "~/services/types";

/**
 * Scan-time shelf presence check (flow config pickingShelfScan require-match):
 * the scanned part must have stock on the pending shelf/box before its label
 * is accepted. Results are cached per (location, part) for the page session —
 * the operator scans many items per location visit, and the backend is the
 * safety net (409 no_stock_at_location) when stock moves mid-session.
 */
export function createShelfStockChecker(fetchQty: (query: PickingShelfStockQuery) => Promise<number>) {
  const cache = new Map<string, number>();

  function keyOf(query: PickingShelfStockQuery): string {
    return [
      query.shelfCode ?? "",
      query.boxId ?? "",
      query.partNo ?? "",
      query.wclItemNo ?? "",
    ].join("|");
  }

  /** Stock qty of the part at the location (cached). */
  async function qtyAt(query: PickingShelfStockQuery): Promise<number> {
    const key = keyOf(query);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const qty = await fetchQty(query);
    cache.set(key, qty);
    return qty;
  }

  /** true when the part has any stock at the location. */
  async function hasStock(query: PickingShelfStockQuery): Promise<boolean> {
    return (await qtyAt(query)) > 0;
  }

  return { qtyAt, hasStock };
}
