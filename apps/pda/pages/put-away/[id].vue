<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <div v-if="selectedShelf" class="shelf-banner">
        <span>{{ $t("putAway.shelfBanner", { shelf: selectedShelf }) }}</span>
        <button type="button" class="shelf-banner__clear" :aria-label="$t('putAway.shelfBannerClear')" @click="selectedShelf = null">×</button>
      </div>

      <PutAwayPendingPanel
        :scans="scans"
        :shelf-code="selectedShelf"
        :adding-scan="addingScan"
        :removing-scan="removingScan"
        @add-to-shelf="addPendingToShelf"
        @remove-scan="removeScanHandler"
      />

      <PutAwayLotsPanel
        v-model:expanded-items="expandedItems"
        :groups="groups"
        :scanning="scanning"
        :armed-item-id="armedItemId"
        @scan="openScan"
        @arm-scan="toggleArmScan"
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
      :context="{ task: 'put-away', receivingOrderId: orderId, receivingItem: scanItem ?? undefined, putAwayItems: scanGroup?.items, shelfCode: selectedShelf }"
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
import { findPutAwayTargets } from "~/utils/putAwayScan";
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
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import PutAwayPendingPanel from "~/components/put-away/PutAwayPendingPanel.vue";
import type {
  PutAwayExpectedItem,
  PutAwayScan,
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
// scans[] are the order's PENDING pieces (never committed to a shelf yet).
const scans = ref<PutAwayScan[]>([]);

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
    map[scan.receivingInvoiceItemId] =
      (map[scan.receivingInvoiceItemId] ?? 0) + scan.qty;
  }
  return map;
});

// Same visibility rule as the old lots list: items with anything left to put
// away, or with scans still pending.
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
          selectedShelf.value
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
  if (scans.value.length === 0) return;
  const total = scans.value.reduce((sum, s) => sum + s.qty, 0);
  const confirmed = window.confirm(
    t("putAway.pendingPanel.commitPrompt", { count: total, shelf: code })
  );
  if (!confirmed) return;
  await commitPendingToShelf(code);
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
    scans.value = detail.scans;

    // Auto-disarm when the armed group has left the visible list (fully put
    // away with no pending scans left).
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
</style>
