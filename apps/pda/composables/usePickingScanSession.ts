import { computed, ref, type Ref } from "vue";
import type { PickingOrderDetail, PickingShelfStockQuery } from "~/services/types";
import type { OcrInput } from "~/utils/ocrNormalize";
import { usePickingScanQueue, type ScanQueueRow } from "~/composables/usePickingScanQueue";
import { useLabelScan, ocrResultToInput } from "~/composables/useLabelScan";
import { createShelfStockChecker } from "~/utils/shelfStockCheck";
import type { PickFromBoxEntry } from "~/components/picking/PickFromBoxDialog.vue";

export type PickingShelfScanMode = "off" | "require-match" | "require-any";

export interface ScanSessionResult {
  ok: boolean;
  /** i18n suffix under `picking.scanSession.` when not ok. */
  message?: string;
  /** What happened on success — the page maps it to a toast. */
  kind?: "queued" | "carton" | "shelf" | "boxpick";
  /** Carton auto-queue summary (kind "carton"). */
  count?: number;
  qty?: number;
}

export interface PickingScanSessionOptions {
  /** Live ref of the order's items (the queue validates against these). */
  orderItems: Ref<PickingOrderDetail["items"]>;
  /** Order-level org/sub-inventory scope for the shelf-stock probe. */
  scope: Ref<{ orgId?: number; subInventoryCode?: string }>;
  /** Resolved pickingShelfScan mode (useFlowSteps). */
  shelfMode: Ref<PickingShelfScanMode>;
  /** Backend shelf-stock probe (warehouse.getPickingShelfStock → qty). */
  shelfStockFn: (query: PickingShelfStockQuery) => Promise<number>;
}

/**
 * Picking scan-session state + routing (spec
 * docs/superpowers/specs/2026-10-12-picking-unified-detail-scan-design.md):
 * the client-side batch queue, sticky shelf-scan context, pick-from-box
 * dialog, carton auto-queue and confirm-with-re-resolve — the mechanics of
 * the old scan page, framework-free so the page owns all toasts/beeps/modals.
 */
export function usePickingScanSession(options: PickingScanSessionOptions) {
  const { orderItems, scope, shelfMode, shelfStockFn } = options;
  const { parseRawValue } = useLabelScan();

  const {
    rows,
    addScan,
    matchBoxAllocations,
    matchCartonAllocations,
    addCartonScan,
    allocationRemaining,
    addAllocationScan,
    removeRow,
    reresolveQueued,
    applyAll,
  } = usePickingScanQueue(orderItems);

  const queuedCount = computed(() => rows.value.filter((r) => r.status === "queued").length);
  const applying = ref(false);
  const requireShelfScan = computed(() => shelfMode.value !== "off");

  // Sticky shelf-scan context (require-* modes): one shelf/box scan per
  // location visit; replaced by the next shelf scan or cleared manually.
  const pendingShelf = ref<{ label: string; shelfCode: string | null; boxId: string | null } | null>(null);
  const shelfStockChecker = createShelfStockChecker(shelfStockFn);

  // "Pick from box" dialog (off mode): scanning a shelf box/shelf barcode
  // lists what the order still needs from it.
  const boxPickId = ref<string | null>(null);
  const boxPickEntries = computed<PickFromBoxEntry[]>(() => {
    if (!boxPickId.value) return [];
    return matchBoxAllocations(boxPickId.value).map(({ item, allocation }) => ({
      itemId: item.id,
      allocationId: allocation.id,
      lineNumber: item.lineNumber,
      shipmentNumber: item.shipmentNumber,
      partNo: item.partNo,
      wclItemNo: item.wclItemNo,
      lotCode: allocation.lot?.lotCode ?? null,
      dateCode: allocation.lot?.dateCode ?? null,
      required: allocation.qty,
      queued: allocation.qty - allocationRemaining(allocation.id),
    }));
  });

  // Distinct parts.brand values of the order's items — brand-scoped template
  // lookup tries these suppliers' QR templates first (rest as fallback).
  const orderBrands = computed(() => [
    ...new Set(orderItems.value.map((i) => i.brand).filter((b): b is string => !!b)),
  ]);

  /** Set/replace the sticky shelf context from a scan that matched an
   *  allocation's shelf box / shelf code. */
  function setPendingShelfFromMatch(rawValue: string) {
    const lot = matchBoxAllocations(rawValue)[0]?.allocation.lot;
    pendingShelf.value = {
      label: rawValue.trim(),
      shelfCode: lot?.shelfCode ?? null,
      boxId: lot?.boxId ?? null,
    };
  }

  function clearPendingShelf() {
    pendingShelf.value = null;
  }

  function closeBoxPick() {
    boxPickId.value = null;
  }

  function removeGroup(keys: string[]) {
    for (const key of keys) removeRow(key);
  }

  /** Queue one parsed label record (QR or OCR), with the shelf-mode guards:
   *  require-* modes need a pending shelf; require-match does the shelf-stock
   *  pre-check (the backend's no_stock_at_location 409 is the safety net). */
  async function handleParsed(
    parsed: OcrInput,
    raw: string,
    source: ScanQueueRow["source"]
  ): Promise<ScanSessionResult> {
    if (requireShelfScan.value && !pendingShelf.value) {
      return { ok: false, message: "scanShelfFirst" };
    }
    if (shelfMode.value === "require-match" && pendingShelf.value) {
      const stocked = await shelfStockChecker.hasStock({
        partNo: String(parsed.partNo ?? ""),
        wclItemNo: parsed.wclItemNo || undefined,
        shelfCode: pendingShelf.value.shelfCode ?? undefined,
        boxId: pendingShelf.value.boxId ?? undefined,
        orgId: scope.value.orgId,
        subInventoryCode: scope.value.subInventoryCode,
      });
      if (!stocked) return { ok: false, message: "item_not_on_shelf" };
    }
    const result = addScan(parsed, raw, source);
    return result.ok ? { ok: true, kind: "queued" } : { ok: false, message: result.message };
  }

  /** Shelf/box scan handling. In the require-* modes a shelf scan ONLY
   *  sets/replaces the location banner; in off mode it opens the pick-from-box
   *  dialog as a lookup shortcut. */
  function openBoxPick(rawValue: string): ScanSessionResult {
    const matches = matchBoxAllocations(rawValue);
    if (requireShelfScan.value) {
      if (matches.length > 0) {
        setPendingShelfFromMatch(rawValue);
      } else if (shelfMode.value === "require-any") {
        pendingShelf.value = { label: rawValue.trim(), shelfCode: rawValue.trim(), boxId: null };
      } else {
        return { ok: false, message: "no_match" };
      }
      return { ok: true, kind: "shelf" };
    }
    if (matches.length === 0) return { ok: false, message: "no_match" };
    boxPickId.value = rawValue.trim();
    return { ok: true, kind: "boxpick" };
  }

  /** Receiving-carton scan: queue everything this order still needs from it. */
  function queueCarton(rawValue: string): ScanSessionResult {
    const matches = matchCartonAllocations(rawValue);
    if (matches.length === 0) return { ok: false, message: "no_match" };
    const result = addCartonScan(matches, rawValue.trim());
    if (!result.ok) return { ok: false, message: result.message, count: 0, qty: 0 };
    return { ok: true, kind: "carton", count: result.count, qty: result.qty };
  }

  /** Hardware/camera QR path: supplier label first, receiving carton second
   *  (auto-queue), shelf box/shelf barcode last (pick-from-box dialog). */
  async function handleQrOrBoxScan(rawValue: string): Promise<ScanSessionResult> {
    const parsedResult = await parseRawValue(rawValue, undefined, orderBrands.value);
    if (parsedResult.matched) {
      return await handleParsed(ocrResultToInput(parsedResult.parsed), rawValue, "qr");
    }
    if (matchCartonAllocations(rawValue).length > 0) {
      return queueCarton(rawValue);
    }
    return openBoxPick(rawValue);
  }

  /** A scan while the pick-from-box dialog is open: a new box/shelf barcode
   *  switches the dialog; a carton barcode queues the carton (and closes the
   *  dialog); anything else must be a part label for one of the box's items. */
  async function handleBoxPickScan(rawValue: string): Promise<ScanSessionResult> {
    if (matchBoxAllocations(rawValue).length > 0) {
      boxPickId.value = rawValue.trim();
      return { ok: true, kind: "boxpick" };
    }
    if (matchCartonAllocations(rawValue).length > 0) {
      boxPickId.value = null;
      return queueCarton(rawValue);
    }
    const parsedResult = await parseRawValue(rawValue, undefined, orderBrands.value);
    if (!parsedResult.matched) return { ok: false, message: "no_match" };
    const parsed = ocrResultToInput(parsedResult.parsed);
    const wanted = String(parsed.partNo ?? "").trim().toUpperCase();
    const entry = boxPickEntries.value.find((e) => e.partNo.trim().toUpperCase() === wanted);
    if (!entry) return { ok: false, message: "part_not_in_box" };
    const result = addAllocationScan(entry.itemId, entry.allocationId, parsed, rawValue, "qr");
    return result.ok ? { ok: true, kind: "queued" } : { ok: false, message: result.message };
  }

  /** Queued qty per picking item id (for the collapsed progress line). */
  const queuedQtyByItem = computed(() => {
    const map: Record<string, number> = {};
    for (const r of rows.value) {
      if (r.status !== "queued") continue;
      map[r.itemId] = (map[r.itemId] ?? 0) + r.qty;
    }
    return map;
  });

  function scannedQtyOf(item: PickingOrderDetail["items"][number]): number {
    return (item.packages ?? []).reduce((sum, p) => sum + p.qty, 0);
  }

  // Progress-based completion (spec 2026-10-03): every item fully scanned
  // (Σ packages from the last order fetch) with an empty queue.
  const completed = computed(() => {
    const items = orderItems.value;
    if (items.length === 0) return false;
    return queuedCount.value === 0 && items.every((i) => scannedQtyOf(i) >= i.qty);
  });

  // The queued scans cover what the server has not confirmed yet — every
  // item's required qty is matched. The page watches this for the
  // success-cue + auto-confirm prompt (one prompt per transition).
  const orderMatched = computed(() => {
    const items = orderItems.value;
    if (items.length === 0 || queuedCount.value === 0) return false;
    return items.every((i) => scannedQtyOf(i) + (queuedQtyByItem.value[i.id] ?? 0) >= i.qty);
  });

  /** Apply every queued row sequentially via `scanFn` (the page's
   *  scanPickingItem wrapper, including the sticky shelf context). After each
   *  successful apply the order refetches and the queue re-resolves (the
   *  backend rebuilds allocation ids). Returns the number of failed rows. */
  async function confirm(
    scanFn: (row: ScanQueueRow) => Promise<void>,
    errorMessage: (e: unknown) => string,
    afterApply?: () => Promise<void>
  ): Promise<number> {
    if (applying.value || queuedCount.value === 0) return 0;
    applying.value = true;
    boxPickId.value = null;
    try {
      return await applyAll(scanFn, errorMessage, afterApply);
    } finally {
      applying.value = false;
    }
  }

  return {
    rows,
    queuedCount,
    queuedQtyByItem,
    applying,
    requireShelfScan,
    pendingShelf,
    boxPickId,
    boxPickEntries,
    orderBrands,
    completed,
    orderMatched,
    setPendingShelfFromMatch,
    clearPendingShelf,
    closeBoxPick,
    removeGroup,
    handleParsed,
    queueCarton,
    openBoxPick,
    handleQrOrBoxScan,
    handleBoxPickScan,
    reresolveQueued,
    confirm,
  };
}

export type PickingScanSession = ReturnType<typeof usePickingScanSession>;
