<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <div v-if="selectedShelf" class="shelf-banner">
        <span>{{ $t("putAway.shelfBanner", { shelf: selectedShelf }) }}</span>
        <button type="button" class="shelf-banner__clear" :aria-label="$t('putAway.shelfBannerClear')" @click="selectedShelf = null">×</button>
      </div>

      <PutAwayLotsPanel
        v-model:expanded-items="expandedItems"
        :groups="groups"
        :scans="scans"
        :shelf-code="selectedShelf"
        :scanning="scanning"
        :adding-scan="addingScan"
        :removing-scan="removingScan"
        :armed-item-id="armedItemId"
        @scan="openScan"
        @arm-scan="toggleArmScan"
        @add-to-shelf="addPendingToShelf"
        @remove-scan="removeScanHandler"
        @remove-from-shelf="removeScanFromShelfHandler"
      />

      <!-- CN put-away: the CN world has no per-scan staging endpoint, so the
           scanned pieces live locally and post in one batch on confirm. -->
      <div v-if="cnMode && scans.length" class="cn-commit">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="committingAll"
          @click="commitCn"
        >
          {{ $t('putAway.cn.commit', { count: cnPendingQty }) }}
        </button>
      </div>
    </template>

      <ScanMultiItemModal
        v-if="multiReview"
        :model-value="multiOpen"
        :rows="multiReview.rows"
        :part-nos="visiblePartNos"
        :results="multiResults"
        @update:model-value="onMultiClosed"
        @apply="onApplyMulti"
        @remove="onMultiRowRemoved"
      />

      <LabelScanReviewModal
      v-if="review?.status === 'review'"
      v-model="reviewOpen"
      :image-path="review.capture.imagePath"
      :text="review.capture.text"
      :barcodes="review.capture.barcodes"
      :parsed="review.parsed"
      :options="review.options"
      :match-result="review.matchResult"
      :mode="review.capture.imagePath ? 'review' : 'manual'"
      :context="{ task: 'put-away', receivingOrderId: orderId, receivingItem: scanItem ?? undefined, putAwayItems: visibleItems, shelfCode: selectedShelf }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { nextTick } from "vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useStatusLabel } from "~/composables/useStatusLabel";
import { useErrorMessage } from "~/composables/errorMessage";
import { I18nError } from "~/composables/i18nError";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import {
  captureLabel,
  getCachedSupplierQrTemplates,
  getCachedDateCodePeriods,
  ocrResultToInput,
  useLabelScan,
  type LabelScanResult,
} from "~/composables/useLabelScan";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import { scrollToItem } from "~/utils/scroll";
import { rawCode } from "~/utils/text";
import { compareByPoLineThenPartNo, findCnPutAwayTargets, findPutAwayTargets } from "~/utils/putAwayScan";
import {
  groupPutAwayItems,
  type PutAwayItemGroup,
} from "~/utils/putAwayGroups";
import {
  extractMultiItemRows,
  parseQrCapture,
  parseAndIdentify,
  type ScanMultiRow,
  type ScanMultiRowResult,
} from "~/utils/parseOcrScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import ScanMultiItemModal from "~/components/ScanMultiItemModal.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import { viewListRow } from "~/utils/viewConfig";
import type {
  CnPutAwayCompleteItem,
  PutAwayExpectedItem,
  PutAwayScan,
  PutAwayTaskDetail,
  Shelf,
  ReceivingOrderDetail,
} from "~/services/types";

definePageMeta({ title: "meta.putAwayDetail" });

const { t } = useI18n();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

useHead({ title: t("putAway.detail.title") });

const route = useRoute();
const orderId = route.params.id as string;
// Arriving from the task queue (?task=<id>): read the task detail instead of
// the plain receiving-order aggregate — same data plus per-item shelf hints.
const taskId = (route.query.task as string) || null;

const expandedItems = ref<Set<string>>(new Set());
// Sticky shelf context (spec 2026-10-06 shelf-direct flow): while set, every
// scan commits straight onto this shelf; clear (×) to scan into the pending
// list instead.
const selectedShelf = ref<string | null>(null);

const statusLabel = useStatusLabel();
const headerStatus = computed(() =>
  order.value ? statusLabel.receiving(order.value.status) : ""
);

// Unresolved outdated-scan warnings on the order (spec 2026-10-07) — from the
// put-away aggregate (task detail embeds the same aggregate).
const outdatedWarningCount = ref(0);

// CN task detail extras for the header title template — the CN detail's
// order aggregate carries no invoices array, so the list-row invoiceNos come
// from the task detail payload instead.
const cnInvoiceNos = ref<string | null>(null);

// Title, status badge and header info rows render in the AppHeader. The
// title follows the put-away list's pdaViewConfig title template (same as
// the list rows — [batch_no] by default, [name] = the backend displayName).
usePageHeader({
  title: () => {
    const o = order.value;
    if (!o) return undefined;
    const row = {
      displayName: o.displayName,
      batchNo: o.batchNo,
      status: o.status,
      deliveryDate: o.deliveryDate,
      dateCode: o.dateCode,
      orgId: o.orgId,
      supplierCode: o.supplier?.code ?? null,
      supplierName: o.supplier?.name ?? null,
      invoiceNos:
        o.invoices.length > 0 ? o.invoices.map((i) => i.invoiceNo).join(",") : (cnInvoiceNos.value ?? ""),
    };
    return viewListRow("put-away", row, viewConfig.value).title || o.displayName || o.batchNo;
  },
  badgeText: () => headerStatus.value || undefined,
  badgeClass: () => badgeClass(order.value?.status),
  warningText: () =>
    outdatedWarningCount.value > 0
      ? t("outdatedWarning.chip", { count: outdatedWarningCount.value })
      : undefined,
  info: () => {
    const o = order.value;
    if (!o) return [];
    return [
      { label: t("putAway.detail.supplier"), value: o.supplier?.name || t("common.noData") },
      {
        label: t("putAway.detail.deliveryDate"),
        value: o.deliveryDate ? new Date(o.deliveryDate).toLocaleDateString() : t("common.noData"),
      },
    ];
  },
});

const warehouse = useWarehouse();
const { viewConfig } = useViewConfig();
const { cnReceiving } = useFlowSteps();

// CN customer-receiving mode: the detail reads the CN task aggregate
// (/put-away-cn/tasks/:id, normalized onto the standard types) and scanned
// pieces accumulate LOCALLY — the CN world has no per-scan staging
// endpoint; they post in one batch on confirm (same pattern as ad-hoc
// put-away).
const cnMode = computed(() => cnReceiving.value);

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<ReceivingOrderDetail | null>(null);
const items = ref<PutAwayExpectedItem[]>([]);
const shelves = ref<Shelf[]>([]);
// scans[] are the order's PENDING pieces. Standard mode: the unstaged scans
// from the put-away aggregate. CN mode: the locally staged pieces awaiting
// the batch confirm (kept across reloads; cleared on commit).
const scans = ref<PutAwayScan[]>([]);
// CN duplicate-serial guard (the standard path's check is backend-side).
const cnSeenSerials = ref<Set<string>>(new Set());
let cnLocalSeq = 0;

const scanItem = ref<PutAwayExpectedItem | null>(null);
// The group card the OCR review was opened from — its member lines ride in
// the review context so one label's qty can span them (spec 2026-10-05).
const scanGroup = ref<PutAwayItemGroup | null>(null);
const scrollTargetGroupKey = ref<string | null>(null);
// Item-first hardware scan mode: while set, the next gun scan is validated
// strictly against this part group's lines instead of free-matching across
// all visible items. Holds the group key (normalized part no).
const armedItemId = ref<string | null>(null);
const addingScan = ref<Record<string, boolean>>({});
const removingScan = ref<Record<string, boolean>>({});
const committingAll = ref(false);

// Restrict the hardware decoder to the supplier's barcode-type whitelist
// while this order is open (no-op when the profile has none). Shelf/box QR
// labels stay decodable — put-away requires shelf scans.
useSupplierSymbologyScope(computed(() => order.value?.supplier?.code ?? undefined), { withShelfCodes: true });

const stagedQtyByItem = computed(() => {
  const map: Record<string, number> = {};
  for (const scan of scans.value) {
    if (!scan.receivingInvoiceItemId) continue;
    // CN pieces always carry a shelf (shelf-first flow) but still count as
    // staged until the batch confirm posts them.
    if (!cnMode.value && scan.shelfCode) continue;
    map[scan.receivingInvoiceItemId] =
      (map[scan.receivingInvoiceItemId] ?? 0) + scan.qty;
  }
  return map;
});

// CN items' server remainingQty is net of nothing local — subtract the
// locally staged pieces so the display and the scan matcher see the truth
// (the standard path gets the same netted value server-side).
const matchItems = computed<PutAwayExpectedItem[]>(() => {
  if (!cnMode.value) return items.value;
  const staged = stagedQtyByItem.value;
  return items.value.map((it) => {
    const s = staged[it.id] ?? 0;
    return s > 0 ? { ...it, remainingQty: Math.max(0, it.remainingQty - s) } : it;
  });
});

// Same visibility rule as the old lots list: items with anything left to put
// away, or with scans still pending. CN mode orders the list po_line →
// part_no (the warehouse works the sheet by PO line); standard keeps the
// backend order.
const visibleItems = computed(() => {
  const list = matchItems.value.filter(
    (item) =>
      item.remainingQty > 0 || (stagedQtyByItem.value[item.id] ?? 0) > 0
  );
  if (cnMode.value) list.sort(compareByPoLineThenPartNo);
  return list;
});

// Display grouping: one card per part, summed qty (spec 2026-10-05). Writes
// stay per receiving line — scans are split FIFO across the group's lines.
const groups = computed(() =>
  groupPutAwayItems(visibleItems.value, stagedQtyByItem.value)
);

const armedGroupItems = computed(() => {
  if (!armedItemId.value) return visibleItems.value;
  return (
    groups.value.find((g) => g.key === armedItemId.value)?.items ??
    visibleItems.value
  );
});

const { processCapture, parseRawValue } = useLabelScan();
const scanning = ref(false);

/** Check scanned COO/COW against the target's. When the target has a value,
 *  the scan must match (case-insensitive). Returns an error key or null. */
function checkBatchAttr(
  kind: "coo" | "cow",
  targetValue: string | null | undefined,
  scannedValue: string | null | undefined
): string | null {
  const target = (targetValue ?? "").trim();
  const scanned = (scannedValue ?? "").trim();
  if (!target || !scanned) return null;
  if (target.toUpperCase() === scanned.toUpperCase()) return null;
  return `errors.${kind}_mismatch`;
}
const review = ref<LabelScanResult | null>(null);
const reviewOpen = ref(false);

// Multi-item label review (table UI): rows parsed from one OCR capture.
const multiReview = ref<{ rows: ScanMultiRow[] } | null>(null);
const multiOpen = ref(false);
const multiResults = ref<ScanMultiRowResult[] | null>(null);
const multiApplying = ref(false);

const visiblePartNos = computed(() => visibleItems.value.map((i) => i.partNo));

async function onApplied() {
  reviewOpen.value = false;
  review.value = null;
  await load();
}

// Hardware / wedge QR scans (spec 2026-10-06 shelf-direct flow): a shelf QR
// selects the shelf (and offers to commit the pending list); a BOX-* id is
// not used in this flow; anything else is a supplier item label — parse,
// match, and record (committed to the selected shelf, or pending when none).
useHardwareScanner({
  enabled: () =>
    !!order.value &&
    order.value.status !== "clear" &&
    !scanning.value &&
    !reviewOpen.value &&
    !multiOpen.value,
  onScan: async (rawValue: string) => {
    if (!order.value) return false;
    const value = rawValue.trim();
    const shelf = shelves.value.find((s) => s.code.toUpperCase() === value.toUpperCase());
    if (shelf) {
      await selectShelf(shelf.code);
      return true;
    }
    if (/^box-/i.test(value)) {
      showToast(t("putAway.boxScanIgnored"));
      return false;
    }
    scanning.value = true;
    try {
      const parsedResult = await parseRawValue(
        value,
        order.value.supplier?.code ?? undefined
      );
      const parsed = ocrResultToInput(parsedResult.parsed);
      const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
      // CN mode: stage the piece locally (shelf-first, no server write until
      // the batch confirm). Matching mirrors the standard flow but also
      // accepts the CN item's carton number as the scanned identity.
      if (cnMode.value) {
        return handleCnItemScan(parsed.partNo, parsed.wclItemNo, qty, {
          dateCode: parsed.dateCode,
          lotCode: parsed.lotCode,
          coo: parsed.coo,
          cow: parsed.cow,
          serialNo: parsed.serialNo,
        });
      }
      // Item-first (armed) mode: match strictly against the armed part
      // group's lines. One label's qty may span several same-part lines —
      // the scan is split FIFO into one write per line.
      const portions = findPutAwayTargets(
        armedGroupItems.value,
        parsed.partNo,
        qty,
        parsed.wclItemNo
      );
      if (!portions) {
        showToast(t("errors.scanned_part_does_not_match_item"));
        return false;
      }
      // COO/COW check: when the receiving item has a value, the scan must match.
      for (const portion of portions) {
        const cooErr = checkBatchAttr("coo", portion.item.coo, parsed.coo);
        if (cooErr) {
          showToast(t(cooErr, { scanned: parsed.coo, expected: portion.item.coo }));
          return false;
        }
        const cowErr = checkBatchAttr("cow", portion.item.cow, parsed.cow);
        if (cowErr) {
          showToast(t(cowErr, { scanned: parsed.cow, expected: portion.item.cow }));
          return false;
        }
      }
      const batch = [
        rawCode(parsed.dateCode),
        rawCode(parsed.lotCode),
        rawCode(parsed.coo),
        rawCode(parsed.cow),
      ];
      for (const [portionIdx, portion] of portions.entries()) {
        await warehouse.recordPutAwayScan(
          orderId,
          portion.item.id,
          portion.qty,
          batch[0],
          batch[1],
          batch[2],
          batch[3],
          selectedShelf.value,
          // The label's serial rides on the first split portion only — one
          // physical label split across lines must not trip its own dedup.
          portionIdx === 0 ? rawCode(parsed.serialNo) : null
        );
      }
      showToast(t("common.scanSuccess"));
      const hitGroup = groups.value.find((g) =>
        g.items.some((i) => i.id === portions[0].item.id)
      );
      scrollTargetGroupKey.value = hitGroup?.key ?? null;
      await load();
      return true;
    } catch (e) {
      showToast(errorMessage(e));
      return false;
    } finally {
      scanning.value = false;
    }
  },
});

// Shelf scan: select the shelf (banner), then — when pieces are pending —
// offer to commit them all onto it in one go.
async function selectShelf(code: string) {
  selectedShelf.value = code;
  showToast(t("putAway.shelfSelected", { shelf: code }));
  // CN: pieces carry the shelf they were scanned on and post via the batch
  // confirm button — no per-shelf commit prompt.
  if (cnMode.value) return;
  if (scans.value.length === 0) return;
  const total = scans.value.reduce((sum, s) => sum + s.qty, 0);
  const confirmed = window.confirm(
    t("putAway.pendingPanel.commitPrompt", { count: total, shelf: code })
  );
  if (!confirmed) return;
  await commitPendingToShelf(code);
}

// --- CN put-away (cnReceiving flow) -----------------------------------------
// The CN world has no per-scan staging endpoint: scanned pieces accumulate in
// scans[] locally (shelf-first — a shelf must be sticky before item scans)
// and post in one batch via POST /put-away-cn/tasks/:id/complete.

/** Stage one scanned label's portions onto the locally pending list. */
function addCnPieces(
  portions: { item: PutAwayExpectedItem; qty: number }[],
  batch: { dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; serialNo: string | null }
) {
  for (const [idx, portion] of portions.entries()) {
    scans.value.push({
      id: `cn-${++cnLocalSeq}`,
      receivingInvoiceItemId: portion.item.id,
      partNo: portion.item.partNo,
      wclItemNo: portion.item.wclItemNo,
      qty: portion.qty,
      dateCode: batch.dateCode,
      lotCode: batch.lotCode,
      coo: batch.coo,
      cow: batch.cow,
      // The CN complete call is per item + shelf; a scanned physical box QR
      // could ride here later — CN boxes are plain text, no entities.
      shelfCode: selectedShelf.value,
      boxId: null,
    });
    // The label's serial rides on the first split portion only (same rule as
    // the standard path's backend-side dedup).
    if (idx === 0 && batch.serialNo) cnSeenSerials.value.add(batch.serialNo);
  }
}

/**
 * Hardware-scan entry point in CN mode: match the parsed label against the
 * (armed) visible items — part keys or the item's carton number — with the
 * standard COO/COW guard, then stage the piece locally.
 */
async function handleCnItemScan(
  partNo: string,
  wclItemNo: string | undefined,
  qty: number,
  batch: { dateCode: string; lotCode: string; coo: string; cow: string; serialNo: string | undefined }
): Promise<boolean> {
  if (!selectedShelf.value) {
    showToast(t("putAway.cn.shelfRequired"));
    return false;
  }
  const portions = findCnPutAwayTargets(
    armedGroupItems.value,
    partNo,
    qty,
    wclItemNo
  );
  if (!portions) {
    showToast(t("errors.scanned_part_does_not_match_item"));
    return false;
  }
  // COO/COW check: when the receiving item has a value, the scan must match.
  for (const portion of portions) {
    const cooErr = checkBatchAttr("coo", portion.item.coo, batch.coo);
    if (cooErr) {
      showToast(t(cooErr, { scanned: batch.coo, expected: portion.item.coo }));
      return false;
    }
    const cowErr = checkBatchAttr("cow", portion.item.cow, batch.cow);
    if (cowErr) {
      showToast(t(cowErr, { scanned: batch.cow, expected: portion.item.cow }));
      return false;
    }
  }
  const serial = rawCode(batch.serialNo);
  if (serial && cnSeenSerials.value.has(serial)) {
    showToast(t("adHocPutAway.duplicateSerial", { serialNo: serial }));
    return false;
  }
  addCnPieces(portions, {
    dateCode: rawCode(batch.dateCode),
    lotCode: rawCode(batch.lotCode),
    coo: rawCode(batch.coo),
    cow: rawCode(batch.cow),
    serialNo: serial,
  });
  showToast(t("common.scanSuccess"));
  const hitGroup = groups.value.find((g) =>
    g.items.some((i) => i.id === portions[0].item.id)
  );
  // CN pieces stage locally (no reload), so scroll to the hit group here
  // instead of relying on load() to consume scrollTargetGroupKey.
  if (hitGroup) {
    expandedItems.value = new Set(expandedItems.value).add(hitGroup.key);
    await nextTick();
    scrollToItem({ itemId: hitGroup.key });
  }
  return true;
}

const cnPendingQty = computed(() =>
  scans.value.reduce((sum, s) => sum + s.qty, 0)
);

// Batch-confirm the locally staged CN pieces: one backend tx (per-item
// put_away_qty updates + on-hand lot upserts + PUT_AWAY ledger rows); the
// task completes when every item is fully put away.
async function commitCn() {
  if (!cnMode.value || !taskId || committingAll.value || scans.value.length === 0) return;
  const confirmed = window.confirm(
    t("putAway.cn.commitPrompt", { count: cnPendingQty.value })
  );
  if (!confirmed) return;
  committingAll.value = true;
  error.value = null;
  try {
    const itemsPayload: CnPutAwayCompleteItem[] = scans.value.map((s) => ({
      itemId: s.receivingInvoiceItemId!,
      qty: s.qty,
      shelfCode: s.shelfCode!,
      boxId: s.boxId,
    }));
    const result = await warehouse.completeCnPutAwayTask(taskId, itemsPayload);
    showToast(
      result.taskCompleted
        ? t("putAway.cn.taskDone")
        : t("putAway.cn.commitDone", { count: cnPendingQty.value })
    );
    scans.value = [];
    cnSeenSerials.value.clear();
    await load();
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    committingAll.value = false;
  }
}

// Commit pending scans onto a shelf (all of them, or the given scanIds for
// the pending list's per-row "Add to shelf") — one tx backend-side.
async function commitPendingToShelf(code: string, scanIds?: string[]) {
  if (committingAll.value) return;
  committingAll.value = true;
  error.value = null;
  try {
    const result = await warehouse.commitPutAwayToShelf(orderId, code, scanIds);
    if (result.count === 0) {
      showToast(t("putAway.pendingPanel.commitEmpty"));
    } else {
      showToast(t("putAway.pendingPanel.commitDone", { count: result.qty, shelf: code }));
    }
    await load();
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    committingAll.value = false;
  }
}

async function addPendingToShelf(scanId: string) {
  if (!selectedShelf.value) return;
  addingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.commitPutAwayToShelf(orderId, selectedShelf.value, [scanId]);
    showToast(t("common.scanSuccess"));
    await load();
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    addingScan.value[scanId] = false;
  }
}

// Tapping the armed group's button disarms; tapping another group re-arms.
function toggleArmScan(group: PutAwayItemGroup) {
  armedItemId.value = armedItemId.value === group.key ? null : group.key;
}

// Hard-delete a pending scan (mis-scan correction).
async function removeScanHandler(scanId: string) {
  // CN: the piece is local-only — dropping it needs no server round-trip.
  if (cnMode.value) {
    scans.value = scans.value.filter((s) => s.id !== scanId);
    return;
  }
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScannedPiece(scanId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

// Reverse a committed scan — the stock leaves the shelf (lot + ledger
// reversal backend-side). Confirmed because it moves real stock; the backend
// rejects with 409 lot_has_pick_allocations when the lot feeds pick
// allocations.
async function removeScanFromShelfHandler(scan: PutAwayScan) {
  // CN: the piece has not been posted yet — just drop it from the local list.
  if (cnMode.value) {
    scans.value = scans.value.filter((s) => s.id !== scan.id);
    return;
  }
  if (!scan.boxId) return;
  const confirmed = window.confirm(
    t("putAway.lotsPanel.removeFromShelfConfirm", {
      qty: scan.qty,
      shelf: scan.shelfCode ?? "",
    })
  );
  if (!confirmed) return;
  removingScan.value[scan.id] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScanFromShelf(scan.id, scan.boxId);
    showToast(
      t("putAway.lotsPanel.removedFromShelf", {
        qty: scan.qty,
        shelf: scan.shelfCode ?? "",
      })
    );
    await load();
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    removingScan.value[scan.id] = false;
  }
}

useVisibleReload(load);

// CN task detail → the ReceivingOrderDetail-shaped header aggregate the page
// renders from (CN orders have no supplier/invoices/arrival stamps).
function cnOrderFromTaskDetail(detail: PutAwayTaskDetail): ReceivingOrderDetail {
  return {
    id: detail.order.id,
    batchNo: detail.order.batchNo,
    status: detail.order.status,
    deliveryDate: detail.taskOrderDeliveryDate ?? null,
    dateCode: detail.taskOrderDateCode ?? null,
    orgId: 0,
    arrivedAt: null,
    arrivedBy: null,
    createdDate: detail.task.createdDate,
    lastUpdateDate: detail.task.createdDate,
    supplier: null,
    invoices: [],
  };
}

async function load() {
  pending.value = true;
  error.value = null;
  try {
    if (cnMode.value) {
      // CN put-away is task-scoped — arriving without ?task= has no detail
      // to read (the list rows always carry it).
      if (!taskId) {
        error.value = t("putAway.cn.noTask");
        return;
      }
      const [detail, shelvesData] = await Promise.all([
        warehouse.getCnPutAwayTaskDetail(taskId),
        warehouse.getShelves(),
      ]);
      order.value = cnOrderFromTaskDetail(detail);
      cnInvoiceNos.value = detail.taskOrderInvoiceNos ?? null;
      items.value = detail.items;
      shelves.value = shelvesData;
      // CN: the locally staged pieces stay in scans[] — never overwritten
      // by the server read (the CN aggregate has no scans section).
    } else {
      const [orderData, detail, shelvesData] = await Promise.all([
        warehouse.getReceivingOrder(orderId),
        taskId
          ? warehouse.getPutAwayTaskDetail(taskId)
          : warehouse.getPutAwayDetail(orderId),
        warehouse.getShelves(),
      ]);
      order.value = orderData;
      items.value = detail.items;
      shelves.value = shelvesData;
      scans.value = detail.scans;
      outdatedWarningCount.value = detail.outdatedWarningCount;
    }

    // Auto-disarm when the armed group has left the visible list (fully put
    // away with no pending scans left).
    if (
      armedItemId.value &&
      !groups.value.some((g) => g.key === armedItemId.value)
    ) {
      armedItemId.value = null;
    }
  } catch (e) {
    error.value = errorMessage(e);
    scrollTargetGroupKey.value = null;
  } finally {
    pending.value = false;
  }

  // Scroll AFTER pending flips false: while pending, the v-if unmounts the
  // whole panel, so the target element does not exist yet and the scroll
  // would silently no-op (long lists also jump back to the top on remount).
  if (scrollTargetGroupKey.value) {
    const targetKey = scrollTargetGroupKey.value;
    scrollTargetGroupKey.value = null;
    // Expand the group so the just-recorded scan row is visible at the
    // scroll target (it renders inside the card's expanded block).
    expandedItems.value = new Set(expandedItems.value).add(targetKey);
    await nextTick();
    scrollToItem({ itemId: targetKey });
  }
}

async function openScan(group: PutAwayItemGroup) {
  error.value = null;
  scrollTargetGroupKey.value = group.key;
  scanItem.value = group.items[0];
  scanGroup.value = group;
  scanning.value = true;
  // CN: no per-scan server write and no OCR review modal — parse the label,
  // match it (part keys or carton number), and stage the piece locally,
  // exactly like a CN hardware scan (ad-hoc put-away camera pattern).
  if (cnMode.value) {
    try {
      if (!selectedShelf.value) {
        showToast(t("putAway.cn.shelfRequired"));
        scrollTargetGroupKey.value = null;
        return;
      }
      const capture = await captureLabel();
      if (!capture) {
        scrollTargetGroupKey.value = null;
        return;
      }
      const barcodes = JSON.parse(capture.barcodes || "[]");
      const templates = await getCachedSupplierQrTemplates(warehouse);
      const dateCodePeriods = await getCachedDateCodePeriods(warehouse);
      const isQrOnly =
        barcodes.length === 1 && barcodes[0]?.format === "4" && !capture.imagePath;
      const result = isQrOnly
        ? parseQrCapture(barcodes[0].value, {
            supplierTemplates: templates,
            targets: [group.partNo],
            dateCodePeriods,
          })
        : parseAndIdentify({ text: capture.text, barcodes }, [group.partNo]);
      if (!result.matched) {
        playScanError();
        showToast(t("adHocPutAway.scanError"));
        scrollTargetGroupKey.value = null;
        return;
      }
      const qty = result.parsed.qty ?? 1;
      const ok = await handleCnItemScan(
        result.parsed.itemId ?? "",
        result.parsed.wclItemNo,
        qty,
        {
          dateCode: result.parsed.dateCode ?? "",
          lotCode: result.parsed.lotCode ?? "",
          coo: result.parsed.coo ?? "",
          cow: result.parsed.cow ?? "",
          serialNo: result.parsed.serialNo,
        }
      );
      if (!ok) {
        playScanError();
        scrollTargetGroupKey.value = null;
        return;
      }
      playScanSuccess();
    } catch (e) {
      scrollTargetGroupKey.value = null;
      playScanError();
      showToast(errorMessage(e));
    } finally {
      scanning.value = false;
    }
    return;
  }
  try {
    const capture = await captureLabel();
    if (!capture) {
      scrollTargetGroupKey.value = null;
      return;
    }
    // A label whose items table lists several parts parses into 2+ rows
    // (matched against all visible items — carton labels mix parts): open the
    // multi-item table so the operator can edit every row.
    const multiRows = extractMultiItemRows(capture.text, visiblePartNos.value);
    if (multiRows.length >= 2) {
      multiReview.value = {
        rows: multiRows.map((r) => ({ partNo: r.partNo, qty: r.qty ?? null })),
      };
      multiResults.value = null;
      multiOpen.value = true;
      playScanSuccess();
      return;
    }
    // Single record: always pop the confirm form (confirmSingleMatch). The
    // match pool is all visible items so the operator can correct a misread
    // part number to any line on the order in the review form.
    const result = await processCapture(capture, {
      task: "put-away",
      receivingOrderId: orderId,
      receivingItem: group.items[0],
      putAwayItems: visibleItems.value,
      targets: group.partNo ? [group.partNo] : [],
      confirmSingleMatch: true,
      shelfCode: selectedShelf.value,
    });
    if (result.status === "review") {
      playScanSuccess();
      review.value = result;
      reviewOpen.value = true;
    } else {
      scrollTargetGroupKey.value = null;
      if (result.status === "error") {
        playScanError();
        showToast(result.message);
      } else {
        playScanSuccess();
      }
    }
  } catch (e) {
    scrollTargetGroupKey.value = null;
    playScanError();
    showToast(errorMessage(e));
  } finally {
    scanning.value = false;
  }
}

/**
 * Multi-item apply: record one put-away scan per row, sequentially so the
 * per-row guards report cleanly. Rows that already succeeded stay locked;
 * the modal closes when every row is applied.
 */
async function onApplyMulti(entries: { row: ScanMultiRow; index: number }[]) {
  if (multiApplying.value) return;
  multiApplying.value = true;
  try {
    const results: ScanMultiRowResult[] = [];
    let anyOk = false;
    for (const { row, index } of entries) {
      const qty = row.qty ?? 0;
      const portions = findPutAwayTargets(visibleItems.value, row.partNo, qty);
      if (!portions) {
        results.push({
          index,
          ok: false,
          message: t("errors.scanned_part_does_not_match_item"),
        });
        continue;
      }
      try {
        for (const portion of portions) {
          await warehouse.recordPutAwayScan(orderId, portion.item.id, portion.qty, null, null, null, null, selectedShelf.value);
        }
        results.push({ index, ok: true });
        anyOk = true;
      } catch (e) {
        results.push({ index, ok: false, message: errorMessage(e) });
      }
    }
    // Merge with earlier results (replacing by index) so locked rows stay marked.
    const merged = new Map<number, ScanMultiRowResult>();
    for (const r of multiResults.value ?? []) merged.set(r.index, r);
    for (const r of results) merged.set(r.index, r);
    multiResults.value = [...merged.values()];
    if (anyOk) await load();
    if (multiResults.value.every((r) => r.ok)) {
      multiOpen.value = false;
      multiReview.value = null;
      multiResults.value = null;
      showToast(t("common.scanSuccess"));
    }
  } finally {
    multiApplying.value = false;
  }
}

function onMultiClosed(v: boolean) {
  multiOpen.value = v;
  if (!v) {
    multiReview.value = null;
    multiResults.value = null;
  }
}

/** A removed row shifts later row indices — keep stored results aligned. */
function onMultiRowRemoved(index: number) {
  multiResults.value = (multiResults.value ?? [])
    .filter((r) => r.index !== index)
    .map((r) => (r.index > index ? { ...r, index: r.index - 1 } : r));
}

async function onRetake() {
  reviewOpen.value = false;
  const group = scanGroup.value;
  if (!group) {
    error.value = errorMessage(new I18nError("no_scan_item_to_retake"));
    return;
  }
  await openScan(group);
}
</script>

<style scoped>
.shelf-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--surface);
  font-weight: 600;
}

.shelf-banner__clear {
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}

.cn-commit {
  position: sticky;
  bottom: 0;
  margin-top: 1rem;
  padding: 0.75rem 0;
  background: var(--bg);
}

.cn-commit .btn {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
}

.cn-commit .btn--primary {
  background: var(--primary);
  color: #fff;
  border: none;
  border-radius: var(--radius);
}

.cn-commit .btn:disabled {
  opacity: 0.5;
}
</style>
