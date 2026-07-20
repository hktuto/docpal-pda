<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="headerStatus"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <DetailRow :label="$t('putAway.detail.supplier')" :value="order.supplier?.name" />
        <DetailRow :label="$t('putAway.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
      </DetailHeader>

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
        @new-box="openNewBoxDialog"
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

      <PutAwayLotsPanel
        v-model:box-selections="boxSelections"
        v-model:expanded-items="expandedItems"
        :items="visibleItems"
        :staged-qty-by-item="stagedQtyByItem"
        :scans="scans"
        :boxes="boxes"
        :scanning="scanning"
        :adding-scan="addingScan"
        :removing-scan="removingScan"
        @scan="openScan"
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
      :context="{ task: 'put-away', receivingOrderId: orderId, receivingItem: scanItem ?? undefined }"
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
import { findPutAwayTarget } from "~/utils/putAwayScan";
import {
  extractMultiItemRows,
  type ScanMultiRow,
  type ScanMultiRowResult,
} from "~/utils/parseOcrScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import ScanMultiItemModal from "~/components/ScanMultiItemModal.vue";
import SelectShelfDialog from "~/components/SelectShelfDialog.vue";
import ShelfBoxesPanel from "~/components/put-away/ShelfBoxesPanel.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import type {
  PutAwayExpectedItem,
  PutAwayScan,
  PutAwayBox,
  Shelf,
  ReceivingOrderDetail,
} from "~/services/types";

definePageMeta({ title: "meta.putAwayDetail", props: { noPadding: true } });

const { t } = useI18n();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

useHead({ title: t("putAway.detail.title") });

const route = useRoute();
const orderId = route.params.id as string;

const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const newBoxDialogOpen = ref(false);
const expandedItemBoxes = ref<Set<string>>(new Set());

const statusLabel = useStatusLabel();
const headerStatus = computed(() =>
  order.value ? statusLabel.receiving(order.value.status) : ""
);

const warehouse = useWarehouse();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<ReceivingOrderDetail | null>(null);
const items = ref<PutAwayExpectedItem[]>([]);
const shelves = ref<Shelf[]>([]);
const boxes = ref<PutAwayBox[]>([]);
const creating = ref(false);
const closing = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});

const scanItem = ref<PutAwayExpectedItem | null>(null);
const scrollTargetItemId = ref<string | null>(null);
const scans = ref<PutAwayScan[]>([]);
const addingScan = ref<Record<string, boolean>>({});
const removingScan = ref<Record<string, boolean>>({});
const boxSelections = ref<Record<string, string>>({});
const expandedItems = ref<Set<string>>(new Set());
const addingAll = ref<Record<string, boolean>>({});

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
useHardwareScanner({
  enabled: () =>
    !!order.value &&
    order.value.status !== "clear" &&
    !scanning.value &&
    !reviewOpen.value &&
    !multiOpen.value &&
    !newBoxDialogOpen.value,
  onScan: async (rawValue: string) => {
    if (!order.value) return;
    scanning.value = true;
    try {
      const parsedResult = await parseRawValue(
        rawValue,
        order.value.supplier?.code ?? undefined
      );
      const parsed = ocrResultToInput(parsedResult.parsed);
      const qty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
      const target = findPutAwayTarget(visibleItems.value, parsed.partNo, qty);
      if (!target) {
        showToast(t("errors.scanned_part_does_not_match_item"));
        return;
      }
      await warehouse.recordPutAwayScan(
        orderId,
        target.id,
        qty,
        rawCode(parsed.dateCode),
        rawCode(parsed.lotCode),
        rawCode(parsed.coo),
        rawCode(parsed.cow)
      );
      showToast(t("common.scanSuccess"));
      scrollTargetItemId.value = target.id;
      await load();
    } catch (e) {
      showToast(errorMessage(e));
    } finally {
      scanning.value = false;
    }
  },
});

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
      warehouse.getPutAwayDetail(orderId),
      warehouse.getShelves(),
    ]);
    order.value = orderData;
    items.value = detail.items;
    shelves.value = shelvesData;

    const previousBoxIds = new Set(boxes.value.map((b) => b.id));
    boxes.value = detail.boxes;
    scans.value = detail.scans;
    const nextExpanded = new Set(expandedItemBoxes.value);
    for (const b of detail.boxes) {
      if (b.status === "open" && !previousBoxIds.has(b.id)) {
        nextExpanded.add(b.id);
      }
    }
    expandedItemBoxes.value = nextExpanded;

    if (scrollTargetItemId.value) {
      const targetId = scrollTargetItemId.value;
      scrollTargetItemId.value = null;
      await nextTick();
      scrollToItem({ itemId: targetId });
    }
  } catch (e) {
    error.value = errorMessage(e);
    scrollTargetItemId.value = null;
  } finally {
    pending.value = false;
  }
}

function openNewBoxDialog() {
  newBoxDialogOpen.value = true;
  boxesExpanded.value = true;
}

async function createBoxFromDialog(shelfCode: string) {
  error.value = null;
  creating.value = true;
  try {
    await warehouse.createShelfBox(orderId, shelfCode);
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

async function openScan(item: PutAwayExpectedItem) {
  error.value = null;
  scrollTargetItemId.value = item.id;
  scanItem.value = item;
  scanning.value = true;
  try {
    const capture = await captureLabel();
    if (!capture) {
      scrollTargetItemId.value = null;
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
      return;
    }
    // Single record: always pop the confirm form (confirmSingleMatch).
    const result = await processCapture(capture, {
      task: "put-away",
      receivingOrderId: orderId,
      receivingItem: item,
      targets: item.partNo ? [item.partNo] : [],
      confirmSingleMatch: true,
    });
    if (result.status === "review") {
      review.value = result;
      reviewOpen.value = true;
    } else {
      scrollTargetItemId.value = null;
      if (result.status === "error") {
        showToast(result.message);
      }
    }
  } catch (e) {
    scrollTargetItemId.value = null;
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
      const target = findPutAwayTarget(visibleItems.value, row.partNo, qty);
      if (!target) {
        results.push({
          index,
          ok: false,
          message: t("errors.scanned_part_does_not_match_item"),
        });
        continue;
      }
      try {
        await warehouse.recordPutAwayScan(orderId, target.id, qty, null, null, null, null);
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
  const item = scanItem.value;
  if (!item) {
    error.value = errorMessage(new I18nError("no_scan_item_to_retake"));
    return;
  }
  await openScan(item);
}
</script>

<style scoped>
</style>
