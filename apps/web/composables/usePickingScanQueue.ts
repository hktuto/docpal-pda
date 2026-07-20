import { computed, ref, type Ref } from "vue";
import { normalize, type OcrInput } from "~/composables/useMockOcr";
import type { PickingAllocation, PickingOrderDetail } from "~/services/types";

export interface ScanQueueRow {
  key: string;
  itemId: string;
  allocationId: string;
  partNo: string;
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
 * qty must fit the first allocation with enough remaining (minus what is
 * already queued against it), and the same raw QR value cannot be queued twice.
 */
export function usePickingScanQueue(items: Ref<OrderItems>) {
  const rows = ref<ScanQueueRow[]>([]);

  const queuedRows = computed(() => rows.value.filter((r) => r.status !== "applied"));

  function queuedQtyForAllocation(allocationId: string): number {
    return rows.value
      .filter((r) => r.status === "queued" && r.allocationId === allocationId)
      .reduce((sum, r) => sum + r.qty, 0);
  }

  function findTarget(
    partNo: string,
    qty: number
  ): { item: OrderItems[number]; allocation: PickingAllocation } | null {
    const wanted = normalize(partNo);
    for (const item of items.value) {
      if (normalize(item.partNo) !== wanted) continue;
      for (const allocation of item.allocations ?? []) {
        if (allocation.qty <= 0) continue;
        const remaining = allocation.qty - queuedQtyForAllocation(allocation.id);
        if (qty <= remaining) return { item, allocation };
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
    const target = findTarget(String(parsed.partNo), qty);
    if (!target) return { ok: false, message: "no_match" };

    rows.value.unshift({
      key: `row-${nextKey++}`,
      itemId: target.item.id,
      allocationId: target.allocation.id,
      partNo: target.item.partNo,
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

  function removeRow(key: string) {
    rows.value = rows.value.filter((r) => r.key !== key || r.status === "applied");
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
      const target = findTarget(row.partNo, row.qty);
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

  return { rows, queuedRows, queuedQtyByItem, addScan, removeRow, reresolveQueued, applyAll };
}
