import { computed, ref, type Ref } from "vue";
import { normalize, type OcrInput } from "~/utils/ocrNormalize";
import { normalizePartNo } from "~/utils/text";
import type { PickingAllocation, PickingOrderDetail } from "~/services/types";

export interface ScanQueueRow {
  key: string;
  itemId: string;
  allocationId: string;
  partNo: string;
  /** The label's part keys as scanned (before normalization to the item's
   *  part) — sent to the backend so measuring/verify show + match the scanned
   *  part, not the allocated item's part. */
  scannedPartNo: string;
  scannedWclItemNo: string | null;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  raw: string;
  source: "qr" | "ocr";
  status: "queued" | "applied" | "failed";
  error: string | null;
}

type OrderItems = PickingOrderDetail["items"];

let nextKey = 1;

/**
 * Local scan queue for the picking scan-session ("checkout") page: scans are
 * validated client-side and queued, then batch-applied on Confirm.
 * Validation mirrors the old per-scan matcher: part must match an order item,
 * qty must fit the aggregated remaining of all same-part lines (minus what is
 * already queued against their allocations), and the same raw QR value cannot
 * be queued twice.
 */
export function usePickingScanQueue(items: Ref<OrderItems>) {
  const rows = ref<ScanQueueRow[]>([]);

  const queuedRows = computed(() => rows.value.filter((r) => r.status !== "applied"));

  function queuedQtyForAllocation(allocationId: string, excludeKey?: string): number {
    return rows.value
      .filter(
        (r) => r.status === "queued" && r.allocationId === allocationId && r.key !== excludeKey
      )
      .reduce((sum, r) => sum + r.qty, 0);
  }

  /**
   * Space-insensitive part match: the label's part no (itemId) and WCL item
   * no (wclItemNo group) are both accepted against the item's part_no /
   * wcl_item_no, all compared with every whitespace stripped.
   */
  function partMatches(item: OrderItems[number], scanned: { partNo: string; wclItemNo?: string }): boolean {
    const scannedKeys = [scanned.partNo, scanned.wclItemNo]
      .filter((v): v is string => !!v)
      .map((v) => normalizePartNo(v));
    if (scannedKeys.length === 0) return false;
    return [item.partNo, item.wclItemNo].some(
      (v) => v != null && scannedKeys.includes(normalizePartNo(v))
    );
  }

  function findTarget(
    parsed: { partNo: string; wclItemNo?: string },
    qty: number,
    excludeKey?: string
  ): { item: OrderItems[number]; allocation: PickingAllocation } | null {
    for (const item of items.value) {
      if (!partMatches(item, parsed)) continue;
      for (const allocation of item.allocations ?? []) {
        if (allocation.qty <= 0) continue;
        const remaining = allocation.qty - queuedQtyForAllocation(allocation.id, excludeKey);
        if (qty <= remaining) return { item, allocation };
      }
    }
    return null;
  }

  /**
   * Like findTarget, but allows one label's qty to span several allocations
   * and several order lines with the same part (an order line is often
   * allocated from more than one source, and one part may appear on multiple
   * lines, e.g. 10000 + 20000 — a 25000 package covers neither line alone).
   * Consumes lines in list order and their allocations FIFO, net of queued
   * qty, returning one portion per (line, allocation) touched, or null when
   * the aggregated remaining of all same-part lines cannot cover the qty.
   */
  function findTargets(
    parsed: { partNo: string; wclItemNo?: string },
    qty: number
  ): { item: OrderItems[number]; allocation: PickingAllocation; qty: number }[] | null {
    const portions: { item: OrderItems[number]; allocation: PickingAllocation; qty: number }[] = [];
    let remaining = qty;
    for (const item of items.value) {
      if (!partMatches(item, parsed)) continue;
      for (const allocation of item.allocations ?? []) {
        if (allocation.qty <= 0) continue;
        const available = allocation.qty - queuedQtyForAllocation(allocation.id);
        if (available <= 0) continue;
        const take = Math.min(available, remaining);
        portions.push({ item, allocation, qty: take });
        remaining -= take;
        if (remaining === 0) return portions;
      }
    }
    return null;
  }

  function addScan(
    parsed: OcrInput,
    raw: string,
    source: ScanQueueRow["source"]
  ): { ok: boolean; message?: "duplicate" | "invalid" | "no_match" } {
    if (rows.value.some((r) => r.status === "queued" && r.raw === raw)) {
      return { ok: false, message: "duplicate" };
    }
    const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
    if (!normalize(String(parsed.partNo ?? "")) || !Number.isInteger(qty) || qty <= 0) {
      return { ok: false, message: "invalid" };
    }
    const target = findTargets({ partNo: String(parsed.partNo ?? ""), wclItemNo: parsed.wclItemNo }, qty);
    if (!target) return { ok: false, message: "no_match" };

    // One row per (line, allocation) portion; unshift in reverse so the
    // first portion ends up on top. Portions of one label share the raw
    // value — the page's display table re-aggregates them into a single line.
    for (const portion of [...target].reverse()) {
      rows.value.unshift({
        key: `row-${nextKey++}`,
        itemId: portion.item.id,
        allocationId: portion.allocation.id,
        partNo: portion.item.partNo,
        scannedPartNo: String(parsed.partNo ?? ""),
        scannedWclItemNo: parsed.wclItemNo ?? null,
        qty: portion.qty,
        dateCode: parsed.dateCode || null,
        lotCode: parsed.lotCode || null,
        coo: parsed.coo || null,
        cow: parsed.cow || null,
        raw,
        source,
        status: "queued",
        error: null,
      });
    }
    return { ok: true };
  }

  function removeRow(key: string) {
    rows.value = rows.value.filter((r) => r.key !== key || r.status === "applied");
  }

  function matchBy(
    raw: string,
    ids: (a: PickingAllocation) => (string | null | undefined)[]
  ): { item: OrderItems[number]; allocation: PickingAllocation }[] {
    const wanted = raw.trim().toUpperCase();
    if (!wanted) return [];
    const found: { item: OrderItems[number]; allocation: PickingAllocation }[] = [];
    for (const item of items.value) {
      for (const allocation of item.allocations ?? []) {
        if (allocation.qty <= 0) continue;
        if (!ids(allocation).some((v) => v != null && v.trim().toUpperCase() === wanted)) continue;
        found.push({ item, allocation });
      }
    }
    return found;
  }

  /**
   * Box/shelf lookup: return every allocation whose shelf box id
   * (`lot.boxId`) or shelf code (`lot.shelfCode`) equals the scanned value.
   * Used to open the "pick from box" dialog — the operator then scans the
   * parts inside one by one. Receiving cartons are deliberately NOT matched
   * here: a carton scan auto-queues its contents (matchCartonAllocations).
   */
  function matchBoxAllocations(
    raw: string
  ): { item: OrderItems[number]; allocation: PickingAllocation }[] {
    return matchBy(raw, (a) => [a.lot?.boxId, a.lot?.shelfCode]);
  }

  /**
   * Receiving-carton lookup (`ctn_no`). A supplier carton's contents are
   * known and sealed, so scanning its barcode queues everything this order
   * still needs from it in one go — no per-part scans.
   */
  function matchCartonAllocations(
    raw: string
  ): { item: OrderItems[number]; allocation: PickingAllocation }[] {
    return matchBy(raw, (a) => [a.boxId]);
  }

  /** Remaining qty a specific allocation can still take (net of queued rows). */
  function allocationRemaining(allocationId: string, excludeKey?: string): number {
    const allocation = items.value
      .flatMap((i) => i.allocations ?? [])
      .find((a) => a.id === allocationId);
    if (!allocation) return 0;
    return allocation.qty - queuedQtyForAllocation(allocationId, excludeKey);
  }

  /**
   * Queue a part-label scan against one specific allocation (the "pick from
   * box" dialog): the scanned part must be the allocation's item and the
   * label qty must fit that allocation's remaining qty.
   */
  function addAllocationScan(
    itemId: string,
    allocationId: string,
    parsed: OcrInput,
    raw: string,
    source: ScanQueueRow["source"]
  ): { ok: boolean; message?: "duplicate" | "invalid" | "no_match" | "qty_exceeds" } {
    if (rows.value.some((r) => r.status === "queued" && r.raw === raw)) {
      return { ok: false, message: "duplicate" };
    }
    const item = items.value.find((i) => i.id === itemId);
    const allocation = item?.allocations?.find((a) => a.id === allocationId);
    if (!item || !allocation) return { ok: false, message: "no_match" };
    const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
    if (!normalize(String(parsed.partNo ?? "")) || !Number.isInteger(qty) || qty <= 0) {
      return { ok: false, message: "invalid" };
    }
    if (!partMatches(item, { partNo: String(parsed.partNo ?? ""), wclItemNo: parsed.wclItemNo })) {
      return { ok: false, message: "no_match" };
    }
    if (qty > allocationRemaining(allocationId)) {
      return { ok: false, message: "qty_exceeds" };
    }
    rows.value.unshift({
      key: `row-${nextKey++}`,
      itemId: item.id,
      allocationId: allocation.id,
      partNo: item.partNo,
      scannedPartNo: String(parsed.partNo ?? ""),
      scannedWclItemNo: parsed.wclItemNo ?? null,
      qty,
      dateCode: parsed.dateCode || null,
      lotCode: parsed.lotCode || null,
      coo: parsed.coo || null,
      cow: parsed.cow || null,
      raw,
      source,
      status: "queued",
      error: null,
    });
    return { ok: true };
  }

  /**
   * Queue a whole receiving-carton scan: one row per matched allocation at
   * its full remaining qty. The carton barcode is the rows' shared raw value,
   * so re-scanning the same carton is a duplicate. Returns the queued row
   * count + total pcs for the page's toast.
   */
  function addCartonScan(
    matches: { item: OrderItems[number]; allocation: PickingAllocation }[],
    raw: string
  ): { ok: boolean; message?: "duplicate" | "no_match"; count: number; qty: number } {
    if (rows.value.some((r) => r.status === "queued" && r.raw === raw)) {
      return { ok: false, message: "duplicate", count: 0, qty: 0 };
    }
    let count = 0;
    let qty = 0;
    for (const { item, allocation } of [...matches].reverse()) {
      const take = allocationRemaining(allocation.id);
      if (take <= 0) continue;
      rows.value.unshift({
        key: `row-${nextKey++}`,
        itemId: item.id,
        allocationId: allocation.id,
        partNo: item.partNo,
        // A carton scan carries no parsed label part — record the item's own
        // keys as the scanned identity.
        scannedPartNo: item.partNo,
        scannedWclItemNo: item.wclItemNo ?? null,
        qty: take,
        dateCode: allocation.lot?.dateCode ?? null,
        lotCode: allocation.lot?.lotCode ?? null,
        coo: allocation.lot?.coo ?? null,
        cow: allocation.lot?.cow ?? null,
        raw,
        source: "qr",
        status: "queued",
        error: null,
      });
      count += 1;
      qty += take;
    }
    if (count === 0) return { ok: false, message: "no_match", count: 0, qty: 0 };
    return { ok: true, count, qty };
  }

  /** Queued qty per picking item id (for the progress summary). */
  const queuedQtyByItem = computed(() => {
    const map: Record<string, number> = {};
    for (const r of rows.value) {
      if (r.status !== "queued") continue;
      map[r.itemId] = (map[r.itemId] ?? 0) + r.qty;
    }
    return map;
  });

  /**
   * Re-resolve queued rows against fresh allocations. The backend rebuilds
   * an item's allocation rows (new ids) after every applied scan
   * (allocateAll), so queued rows captured before that hold stale
   * allocation ids. Rows that no longer fit any allocation are marked
   * failed with the `allocation_changed` marker.
   */
  function reresolveQueued() {
    for (const row of rows.value) {
      if (row.status !== "queued") continue;
      const target = findTarget({ partNo: row.partNo }, row.qty, row.key);
      if (target) {
        row.itemId = target.item.id;
        row.allocationId = target.allocation.id;
      } else {
        row.status = "failed";
        row.error = "allocation_changed";
      }
    }
  }

  /**
   * Apply queued rows sequentially. Each row is marked applied/failed; applied
   * rows are dropped from the queue, failed rows stay with their error.
   * `afterApply` runs after each successful apply — pass a refetch +
   * `reresolveQueued` so later rows get fresh allocation ids.
   * Returns the number of failed rows.
   */
  async function applyAll(
    scanFn: (row: ScanQueueRow) => Promise<void>,
    errorMessage: (e: unknown) => string,
    afterApply?: () => Promise<void>
  ): Promise<number> {
    for (const row of rows.value) {
      if (row.status !== "queued") continue;
      try {
        await scanFn(row);
        row.status = "applied";
        if (afterApply) await afterApply();
      } catch (e) {
        row.status = "failed";
        row.error = errorMessage(e);
      }
    }
    rows.value = rows.value.filter((r) => r.status !== "applied");
    return rows.value.filter((r) => r.status === "failed").length;
  }

  return { rows, queuedRows, queuedQtyByItem, addScan, matchBoxAllocations, matchCartonAllocations, addCartonScan, allocationRemaining, addAllocationScan, removeRow, reresolveQueued, applyAll };
}
