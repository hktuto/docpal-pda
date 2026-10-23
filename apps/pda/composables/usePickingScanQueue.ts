import { computed, ref, type Ref } from "vue";
import { normalize, normalizeCode, type OcrInput } from "~/utils/ocrNormalize";
import { normalizePartNo } from "~/utils/text";
import { compareDateCodes, toCanonicalDateCode, toLabelDateCode, type DateCodeFormat } from "~/utils/dateCode";
import type { PickingAllocation, PickingOrderDetail } from "~/services/types";

/** A rejected scan: the scanSession i18n key + interpolation params. */
export interface ScanRejection {
  message: string;
  params?: Record<string, string>;
}

/** Check scanned COO/COW against the target's. When the target has a value,
 *  the scan must match (case-insensitive). When the target has no value, the
 *  scan is not constrained. Returns a rejection on mismatch, or null. */
function checkBatchAttr(
  kind: "coo" | "cow",
  targetValue: string | null | undefined,
  scannedValue: string | null | undefined
): ScanRejection | null {
  const target = (targetValue ?? "").trim();
  const scanned = (scannedValue ?? "").trim();
  if (!target || !scanned) return null;
  if (target.toUpperCase() === scanned.toUpperCase()) return null;
  return {
    message: kind === "coo" ? "coo_mismatch" : "cow_mismatch",
    params: { scanned, expected: target },
  };
}

/** Scanned date code vs the source's: must be equal or EARLIER (canonical
 *  YYWW compare, spec 2026-10-14 batch validation, canonical orientation
 *  2026-10-22) — a reel older than stock records say is tolerable, a newer
 *  one means the wrong reel. The scanned label arrives in the label format
 *  (parseOcrScan contract) and is canonicalized via `format` for the compare;
 *  the target is already canonical (see sourceDateCode). The rejection params
 *  echo the raw scanned label value. Unparseable codes on either side never
 *  reject so an unknown label format never blocks the scan. */
function checkDateCode(
  targetValue: string | null | undefined,
  scannedValue: string | null | undefined,
  format: DateCodeFormat
): ScanRejection | null {
  const target = (targetValue ?? "").trim();
  const scanned = (scannedValue ?? "").trim();
  if (!target || !scanned) return null;
  const scannedCanonical = toCanonicalDateCode(scanned, format) ?? scanned;
  if (compareDateCodes(scannedCanonical, target) === "later") {
    return { message: "date_code_newer", params: { scanned, expected: target } };
  }
  return null;
}

/** Lot code is a HARD match whenever the source carries one (spec 2026-10-14):
 *  the scanned label must carry the same lot code (OCR-substitution tolerant).
 *  A missing or different scanned lot code is rejected — including upstream
 *  vocabulary mismatches (label segment vs lot record), which the warehouse
 *  wants surfaced at pick time. Sources without a lot code are not checked. */
function checkLotCode(
  targetValue: string | null | undefined,
  scannedValue: string | null | undefined
): ScanRejection | null {
  const target = normalizeCode(targetValue ?? "");
  if (!target) return null;
  const scannedRaw = (scannedValue ?? "").trim();
  const scanned = normalizeCode(scannedRaw);
  if (!scanned || scanned !== target) {
    return { message: "lot_code_mismatch", params: { scanned: scannedRaw || "—", expected: target } };
  }
  return null;
}

/** The source's date code in canonical YYWW for the scanned-vs-source check:
 *  inventory lots already store canonical YYWW; receiving-area sources are in
 *  the label format (receiving enclave — never converted upstream) and are
 *  canonicalized here, so both sides of the compare speak canonical (spec
 *  2026-10-22-datecode-format-config-design.md). */
function sourceDateCode(allocation: PickingAllocation, format: DateCodeFormat): string | null {
  const lotCode = allocation.lot?.dateCode ?? null;
  if (lotCode) return lotCode;
  const receivingCode = allocation.receiving?.dateCode ?? null;
  return receivingCode ? toCanonicalDateCode(receivingCode, format) : null;
}

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
  /** The row's date code in the LABEL format, always: label rows carry the
   *  scanned value (parseOcrScan contract) and carton rows carry the source
   *  lot's canonical YYWW converted for display + posting (the backend
   *  canonicalizes at its scan boundary). */
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  /** The label's batch fields as scanned (2026-10-14), in the label format —
   *  the backend canonicalizes the date code when it stores the
   *  scanned_date_code snapshot. NULL for whole-carton rows (no label
   *  scanned). */
  scannedDateCode: string | null;
  scannedLotCode: string | null;
  scannedCoo: string | null;
  scannedCow: string | null;
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
export interface PickingScanQueueOptions {
  /** Resolved flow config dateCodeFormat (useFlowSteps) — the label/upstream
   *  format of decoded scan output. Scanned label codes are canonicalized to
   *  YYWW (via toCanonicalDateCode) before they are compared against
   *  canonical lot/package values; the label-format values themselves stay
   *  on the queued rows and are posted verbatim — the backend canonicalizes
   *  at its scan boundary. Defaults to "wwyy". */
  dateCodeFormat?: { value: DateCodeFormat };
}

export function usePickingScanQueue(items: Ref<OrderItems>, options?: PickingScanQueueOptions) {
  const rows = ref<ScanQueueRow[]>([]);
  const labelFormat = () => options?.dateCodeFormat?.value ?? "wwyy";

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
   *
   * Exported so the scan session can preview WHICH sources a label would hit
   * before queueing it — the sticky shelf scan is required only for
   * lot-sourced portions (receiving-area dock sources have no shelf).
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
  ): { ok: boolean; message?: string; params?: Record<string, string> } {
    if (rows.value.some((r) => r.status === "queued" && r.raw === raw)) {
      return { ok: false, message: "duplicate" };
    }
    const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
    if (!normalize(String(parsed.partNo ?? "")) || !Number.isInteger(qty) || qty <= 0) {
      return { ok: false, message: "invalid" };
    }
    const target = findTargets({ partNo: String(parsed.partNo ?? ""), wclItemNo: parsed.wclItemNo }, qty);
    if (!target) return { ok: false, message: "no_match" };

    // Batch-field checks (2026-10-14): COO/COW exact when the source carries
    // them; date code equal-or-earlier; lot code hard match when the source
    // has one. The scanned date code decodes in the label format
    // (parseOcrScan contract) — checkDateCode canonicalizes it for the
    // compare against canonical sources; the row keeps + posts the
    // label-format value (the backend converts at its boundary,
    // spec 2026-10-22).
    for (const portion of target) {
      const cooErr = checkBatchAttr("coo", portion.allocation.lot?.coo, parsed.coo);
      if (cooErr) return { ok: false, ...cooErr };
      const cowErr = checkBatchAttr("cow", portion.allocation.lot?.cow, parsed.cow);
      if (cowErr) return { ok: false, ...cowErr };
      const dateErr = checkDateCode(sourceDateCode(portion.allocation, labelFormat()), parsed.dateCode ? String(parsed.dateCode) : "", labelFormat());
      if (dateErr) return { ok: false, ...dateErr };
      const lotErr = checkLotCode(portion.allocation.lot?.lotCode ?? null, parsed.lotCode);
      if (lotErr) return { ok: false, ...lotErr };
    }

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
        scannedDateCode: parsed.dateCode || null,
        scannedLotCode: parsed.lotCode || null,
        scannedCoo: parsed.coo || null,
        scannedCow: parsed.cow || null,
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
  ): { ok: boolean; message?: string; params?: Record<string, string> } {
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
    // Batch-field checks (2026-10-14) — same rules as addScan; the scanned
    // date code is canonicalized for the compare (label format → YYWW).
    const cooErr = checkBatchAttr("coo", allocation.lot?.coo, parsed.coo);
    if (cooErr) return { ok: false, ...cooErr };
    const cowErr = checkBatchAttr("cow", allocation.lot?.cow, parsed.cow);
    if (cowErr) return { ok: false, ...cowErr };
    const dateErr = checkDateCode(sourceDateCode(allocation, labelFormat()), parsed.dateCode ? String(parsed.dateCode) : "", labelFormat());
    if (dateErr) return { ok: false, ...dateErr };
    const lotErr = checkLotCode(allocation.lot?.lotCode ?? null, parsed.lotCode);
    if (lotErr) return { ok: false, ...lotErr };
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
      scannedDateCode: parsed.dateCode || null,
      scannedLotCode: parsed.lotCode || null,
      scannedCoo: parsed.coo || null,
      scannedCow: parsed.cow || null,
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
        // The lot stores canonical YYWW — convert to the label format so the
        // row renders like a scanned label and posts verbatim (the backend
        // canonicalizes at its scan boundary), spec 2026-10-22.
        dateCode: toLabelDateCode(allocation.lot?.dateCode, labelFormat()),
        lotCode: allocation.lot?.lotCode ?? null,
        coo: allocation.lot?.coo ?? null,
        cow: allocation.lot?.cow ?? null,
        // A carton scan carries no parsed label — nothing was scanned verbatim.
        scannedDateCode: null,
        scannedLotCode: null,
        scannedCoo: null,
        scannedCow: null,
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
   * Apply queued rows sequentially, draining until none remain. Each batch is
   * a snapshot, so rows queued WHILE a drain is running (the unified page
   * auto-applies on every scan) are picked up by the next batch instead of
   * shifting the live iteration. Each row is marked applied/failed; applied
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
    for (;;) {
      const batch = rows.value.filter((r) => r.status === "queued");
      if (batch.length === 0) break;
      for (const row of batch) {
        // afterApply re-resolves later rows — one marked failed mid-batch
        // (allocation_changed) must not be applied.
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
    }
    return rows.value.filter((r) => r.status === "failed").length;
  }

  return { rows, queuedRows, queuedQtyByItem, addScan, findTargets, matchBoxAllocations, matchCartonAllocations, addCartonScan, allocationRemaining, addAllocationScan, removeRow, reresolveQueued, applyAll };
}
