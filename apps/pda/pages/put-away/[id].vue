<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <ShelfBoxesPanel
        v-model:boxes-expanded="boxesExpanded"
        v-model:expanded-item-boxes="expandedItemBoxes"
        :boxes="boxes"
        :shelves="shelves"
        :actionable="order.status !== 'clear'"
        :creating="creating"
        :closing="closing"
        :cancelling-box="cancellingBox"
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count="unboxedCountForOrder"
        :removing-item="removingScan"
        :active-box-id="activeBoxId"
        @new-box="openNewBoxDialog"
        @scan-box="openScanBoxDialog"
        @set-active="setActiveBox"
        @close-box="closeBox"
        @cancel-box="cancelBox"
        @add-all-to-box="addAllToBox"
        @remove-from-box="removeScanFromBoxHandler"
      />

      <SelectShelfDialog
        v-model="newBoxDialogOpen"
        :shelves="shelves"
        @selected="createBoxFromDialog"
      />

      <ScanBoxDialog
        v-model="scanBoxDialogOpen"
        v-model:box-id="scannedBoxId"
        :shelves="shelves"
        :initial-shelf-code="selectedShelf"
        :creating="creating"
        @confirm="confirmScanBox"
      />

      <div v-if="selectedShelf" class="shelf-banner">
        <span>{{ $t("putAway.shelfBanner", { shelf: selectedShelf }) }}</span>
        <button type="button" class="shelf-banner__clear" :aria-label="$t('putAway.shelfBannerClear')" @click="selectedShelf = null">×</button>
      </div>

      <PutAwayLotsPanel
        v-model:box-selections="boxSelections"
        v-model:expanded-items="expandedItems"
        :groups="groups"
        :scans="scans"
        :boxes="boxes"
        :scanning="scanning"
        :adding-scan="addingScan"
        :removing-scan="removingScan"
        :armed-item-id="armedItemId"
        @scan="openScan"
        @arm-scan="toggleArmScan"
        @add-to-box="addScanToBox"
        @remove-scan="removeScanHandler"
      />
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
      :context="{ task: 'put-away', receivingOrderId: orderId, receivingItem: scanItem ?? undefined, putAwayItems: scanGroup?.items, shelfBoxId: activeBoxId }"
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
  ocrResultToInput,
  useLabelScan,
  type LabelScanResult,
} from "~/composables/useLabelScan";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import { scrollToItem } from "~/utils/scroll";
import { rawCode } from "~/utils/text";
import { findPutAwayTargets, classifyPutAwayScan } from "~/utils/putAwayScan";
import {
  groupPutAwayItems,
  type PutAwayItemGroup,
} from "~/utils/putAwayGroups";
import {
  extractMultiItemRows,
  type ScanMultiRow,
  type ScanMultiRowResult,
} from "~/utils/parseOcrScan";
import { playScanError, playScanSuccess } from "~/utils/scanBeep";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import ScanMultiItemModal from "~/components/ScanMultiItemModal.vue";
import SelectShelfDialog from "~/components/SelectShelfDialog.vue";
import ScanBoxDialog from "~/components/put-away/ScanBoxDialog.vue";
import ShelfBoxesPanel from "~/components/put-away/ShelfBoxesPanel.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import type {
  PutAwayExpectedItem,
  PutAwayScan,
  PutAwayBox,
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

const boxesExpanded = ref(false);
const newBoxDialogOpen = ref(false);
const scanBoxDialogOpen = ref(false);
const scannedBoxId = ref("");
const expandedItemBoxes = ref<Set<string>>(new Set());
// The box that currently receives auto-put scans (null = scans go to staging).
const activeBoxId = ref<string | null>(null);
// Sticky shelf context set by scanning a shelf QR label: pre-selects the shelf
// in the box dialogs and lets an unknown BOX-* scan create the box directly.
const selectedShelf = ref<string | null>(null);

const statusLabel = useStatusLabel();
const headerStatus = computed(() =>
  order.value ? statusLabel.receiving(order.value.status) : ""
);

// Title, status badge and header info rows render in the AppHeader.
usePageHeader({
  title: () => order.value?.batchNo,
  badgeText: () => headerStatus.value || undefined,
  badgeClass: () => badgeClass(order.value?.status),
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

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<ReceivingOrderDetail | null>(null);
const items = ref<PutAwayExpectedItem[]>([]);
const shelves = ref<Shelf[]>([]);
const boxes = ref<PutAwayBox[]>([]);
const stagingBoxId = ref<string | null>(null);
const creating = ref(false);
const closing = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});

const scanItem = ref<PutAwayExpectedItem | null>(null);
// The group card the OCR review was opened from — its member lines ride in
// the review context so one label's qty can span them (spec 2026-10-05).
const scanGroup = ref<PutAwayItemGroup | null>(null);
const scrollTargetGroupKey = ref<string | null>(null);
// Item-first hardware scan mode: while set, the next gun scan is validated
// strictly against this part group's lines instead of free-matching across
// all visible items. Holds the group key (normalized part no).
const armedItemId = ref<string | null>(null);
const scans = ref<PutAwayScan[]>([]);
const addingScan = ref<Record<string, boolean>>({});
const removingScan = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const expandedItems = ref<Set<string>>(new Set());
const addingAll = ref<Record<string, boolean>>({});

// Restrict the hardware decoder to the supplier's barcode-type whitelist
// while this order is open (no-op when the profile has none). Shelf/box QR
// labels stay decodable — put-away requires shelf scans.
useSupplierSymbologyScope(computed(() => order.value?.supplier?.code ?? undefined), { withShelfCodes: true });

// scans[] are the staging rows (never boxed), so they are all unboxed.
const unboxedCountForOrder = computed(() => scans.value.length);

const stagedQtyByItem = computed(() => {
  const map: Record<string, number> = {};
  for (const scan of scans.value) {
    if (!scan.receivingInvoiceItemId) continue;
    map[scan.receivingInvoiceItemId] =
      (map[scan.receivingInvoiceItemId] ?? 0) + scan.qty;
  }
  return map;
});

// Same visibility rule as the old lots list: items with anything left to put
// away, or with scans still sitting in the staging box.
const visibleItems = computed(() =>
  items.value.filter(
    (item) =>
      item.remainingQty > 0 || (stagedQtyByItem.value[item.id] ?? 0) > 0
  )
);

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

const anyAddingAll = computed(() =>
  Object.values(addingAll.value).some(Boolean)
);

const { processCapture, parseRawValue } = useLabelScan();
const scanning = ref(false);
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

// Hardware / wedge QR scans: parse via the supplier QR templates, match the
// part against the order's visible items, and apply immediately (no review).
// While the scan-box dialog is open the scan is the box id instead; with an
// active box set the scan is assigned straight into it.
useHardwareScanner({
  enabled: () =>
    !!order.value &&
    order.value.status !== "clear" &&
    !scanning.value &&
    !reviewOpen.value &&
    !multiOpen.value &&
    (scanBoxDialogOpen.value || !newBoxDialogOpen.value),
  onScan: async (rawValue: string) => {
    if (scanBoxDialogOpen.value) {
      scannedBoxId.value = rawValue.trim();
      return;
    }
    if (!order.value) return false;
    // Shelf / box QR labels short-circuit the supplier-label flow.
    const scanClass = classifyPutAwayScan(rawValue, shelves.value, boxes.value, stagingBoxId.value);
    if (scanClass.type === "shelf") {
      selectedShelf.value = scanClass.code;
      showToast(t("putAway.shelfSelected", { shelf: scanClass.code }));
      return true;
    }
    if (scanClass.type === "box") return handleBoxScan(scanClass);
    scanning.value = true;
    try {
      const parsedResult = await parseRawValue(
        rawValue,
        order.value.supplier?.code ?? undefined
      );
      console.log("parsedResult", parsedResult)
      const parsed = ocrResultToInput(parsedResult.parsed);
      console.log("parsed", parsed)
      const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
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
      const batch = [
        rawCode(parsed.dateCode),
        rawCode(parsed.lotCode),
        rawCode(parsed.coo),
        rawCode(parsed.cow),
      ];
      for (const portion of portions) {
        await warehouse.recordPutAwayScan(
          orderId,
          portion.item.id,
          portion.qty,
          batch[0],
          batch[1],
          batch[2],
          batch[3],
          activeBoxId.value
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

// Tapping the armed group's button disarms; tapping another group re-arms.
function toggleArmScan(group: PutAwayItemGroup) {
  armedItemId.value = armedItemId.value === group.key ? null : group.key;
}

// Box QR scan: an existing open box of the order becomes active; the order's
// staging box switches scanning back to staging (clears the active box); an
// unknown BOX-* id is created on the selected shelf (or via the scan-box
// dialog when no shelf is selected).
async function handleBoxScan(scanClass: {
  boxId: string;
  existing: PutAwayBox | null;
  staging: boolean;
}) {
  const { boxId, existing, staging } = scanClass;
  if (staging) {
    activeBoxId.value = null;
    showToast(t("putAway.stagingBoxSelected", { box: boxId }));
    return true;
  }
  if (existing) {
    if (existing.status !== "open") {
      showToast(t("putAway.boxNotOpen", { box: boxId }));
      return false;
    }
    activeBoxId.value = boxId;
    showToast(t("putAway.boxActivated", { box: boxId }));
    return true;
  }
  if (!selectedShelf.value) {
    scannedBoxId.value = boxId;
    scanBoxDialogOpen.value = true;
    boxesExpanded.value = true;
    return true;
  }
  error.value = null;
  creating.value = true;
  try {
    const box = await warehouse.createShelfBox(orderId, selectedShelf.value, boxId);
    activeBoxId.value = box.id;
    showToast(t("putAway.boxCreatedAndActivated", { box: box.id }));
    await load();
    boxesExpanded.value = true;
    return true;
  } catch (e) {
    showToast(errorMessage(e));
    return false;
  } finally {
    creating.value = false;
  }
}

async function addScanToBox(scanId: string) {
  const boxId = boxSelections.value[scanId];
  if (!boxId) return;
  addingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.assignPutAwayScanToBox(scanId, boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingScan.value[scanId] = false;
  }
}

async function removeScanFromBoxHandler(boxId: string, scanId: string) {
  removingScan.value[scanId] = true;
  error.value = null;
  try {
    await warehouse.removePutAwayScanFromBox(scanId, boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScan.value[scanId] = false;
  }
}

// Hard-delete a staged scan (mis-scan correction).
async function removeScanHandler(scanId: string) {
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

useVisibleReload(load);

async function load() {
  pending.value = true;
  error.value = null;
  try {
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

    const previousBoxIds = new Set(boxes.value.map((b) => b.id));
    boxes.value = detail.boxes;
    scans.value = detail.scans;
    stagingBoxId.value = detail.stagingBoxId ?? null;
    // The active box is only valid while it is still open on this order.
    if (
      activeBoxId.value &&
      !detail.boxes.some((b) => b.id === activeBoxId.value && b.status === "open")
    ) {
      activeBoxId.value = null;
    }
    const nextExpanded = new Set(expandedItemBoxes.value);
    for (const b of detail.boxes) {
      if (b.status === "open" && !previousBoxIds.has(b.id)) {
        nextExpanded.add(b.id);
      }
    }
    expandedItemBoxes.value = nextExpanded;

    // Auto-disarm when the armed group has left the visible list (fully put
    // away with no staged scans left).
    if (
      armedItemId.value &&
      !groups.value.some((g) => g.key === armedItemId.value)
    ) {
      armedItemId.value = null;
    }

    if (scrollTargetGroupKey.value) {
      const targetKey = scrollTargetGroupKey.value;
      scrollTargetGroupKey.value = null;
      await nextTick();
      scrollToItem({ itemId: targetKey });
    }
  } catch (e) {
    error.value = errorMessage(e);
    scrollTargetGroupKey.value = null;
  } finally {
    pending.value = false;
  }
}

function openNewBoxDialog() {
  // A scanned shelf context short-circuits the shelf picker.
  if (selectedShelf.value) {
    createBoxFromDialog(selectedShelf.value);
    return;
  }
  newBoxDialogOpen.value = true;
  boxesExpanded.value = true;
}

function openScanBoxDialog() {
  scannedBoxId.value = "";
  scanBoxDialogOpen.value = true;
  boxesExpanded.value = true;
}

async function confirmScanBox(boxId: string, shelfCode: string) {
  error.value = null;
  creating.value = true;
  try {
    const box = await warehouse.createShelfBox(orderId, shelfCode, boxId);
    activeBoxId.value = box.id;
    await load();
    boxesExpanded.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

function setActiveBox(boxId: string) {
  activeBoxId.value = boxId;
}

async function createBoxFromDialog(shelfCode: string) {
  error.value = null;
  creating.value = true;
  try {
    const box = await warehouse.createShelfBox(orderId, shelfCode);
    activeBoxId.value = box.id;
    await load();
    boxesExpanded.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

async function closeBox(boxId: string) {
  error.value = null;
  closing.value = true;
  try {
    await warehouse.closeShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    closing.value = false;
  }
}

async function cancelBox(boxId: string) {
  error.value = null;
  cancellingBox.value[boxId] = true;
  try {
    await warehouse.cancelShelfBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;
  const count = unboxedCountForOrder.value;
  if (count === 0) return;
  const confirmed = window.confirm(t('putAway.shelfBoxesPanel.addAllConfirm', { count }));
  if (!confirmed) return;

  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedScansToBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function openScan(group: PutAwayItemGroup) {
  error.value = null;
  scrollTargetGroupKey.value = group.key;
  scanItem.value = group.items[0];
  scanGroup.value = group;
  scanning.value = true;
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
    // Single record: always pop the confirm form (confirmSingleMatch).
    const result = await processCapture(capture, {
      task: "put-away",
      receivingOrderId: orderId,
      receivingItem: group.items[0],
      putAwayItems: group.items,
      targets: group.partNo ? [group.partNo] : [],
      confirmSingleMatch: true,
      shelfBoxId: activeBoxId.value,
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
          await warehouse.recordPutAwayScan(orderId, portion.item.id, portion.qty, null, null, null, null, activeBoxId.value);
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
</style>
