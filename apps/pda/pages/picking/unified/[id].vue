<template>
  <div class="unified-page">
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <PickingIssueBanner v-if="order.status === 'issue'" :order="order" />

      <div v-if="heldByOther" class="work-lock-banner">
        {{ $t('picking.detail.heldBy', { name: heldByOther }) }}
      </div>

      <div v-if="order.suggestedBox && actionable" class="box-match-banner">
        <span>
          {{ $t('picking.detail.boxMatchHint', { box: order.suggestedBox.id }) }}<template v-if="order.suggestedBox.shelfCode"> ({{ order.suggestedBox.shelfCode }})</template>
        </span>
        <button class="btn btn--small" :disabled="claimingBox" @click="claimBox">
          <template v-if="claimingBox">
            <InlineSpinner /> {{ $t('picking.detail.claimingBox') }}
          </template>
          <template v-else>
            {{ $t('picking.detail.useWholeBox') }}
          </template>
        </button>
      </div>

      <div
        v-if="requireShelfScan && !completed && (pendingShelf || shelfWorkRemaining)"
        class="shelf-banner"
        :class="{ 'shelf-banner--empty': !pendingShelf }"
      >
        <template v-if="pendingShelf">
          <span class="shelf-banner-label">
            {{ $t('picking.scanSession.shelfContext', { shelf: pendingShelf.label }) }}
          </span>
          <button class="btn btn--small btn--secondary" @click="session.clearPendingShelf">
            {{ $t('picking.scanSession.shelfClear') }}
          </button>
        </template>
        <span v-else>{{ $t('picking.scanSession.scanShelfFirst') }}</span>
      </div>

      <PickingUnifiedItems
        :items="order.items ?? []"
        :queue-rows="rows"
        :actionable="actionable"
        :box-selections="boxSelections"
        :adding="adding"
        :removing="removing"
        :removing-scans="removingScans"
        :open-boxes="openBoxes"
        :collapsed-style="collapsedStyle"
        @remove-queue="session.removeGroup"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
        @remove-scan="removeScan"
        @update:box-selections="updateBoxSelections"
      />

      <PickingBoxesSection
        v-model:expanded="boxesExpanded"
        :boxes="order.boxes"
        :box-contents="boxContents"
        :actionable="actionable"
        :creating-box="creatingBox"
        :scanning-box="false"
        :cancelling-box="cancellingBox"
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count="unboxedCountForOrder"
        :removing="removing"
        :scan-into-box-id="scanIntoBoxId"
        :scanning-into-box="scanningIntoBox"
        @create-box="createBox"
        @cancel-box="cancelBox"
        @add-all-to-box="addAllToBox"
        @toggle-scan-into-box="toggleScanIntoBox"
        @remove-from-box="removeFromBox"
      />

      <footer v-if="actionable" class="unified-footer">
        <button class="btn btn--small" :disabled="applying || ocrCapturing || !!heldByOther" @click="captureOcr">
          <template v-if="ocrCapturing"><InlineSpinner /> {{ $t('picking.scanSession.ocrCapture') }}</template>
          <template v-else>{{ $t('picking.scanSession.ocrCapture') }}</template>
        </button>
        <!-- Complete Picking: prominent bottom confirmation (2026-10-20) —
             appears the moment every item is picked into a box. -->
        <button
          v-if="allItemsFullyBoxed"
          class="btn unified-footer__finish"
          :disabled="finishing"
          @click="finish"
        >
          <template v-if="finishing"><InlineSpinner /> {{ $t('actions.finishing') }}</template>
          <template v-else>{{ $t('picking.detail.finishPicking') }}</template>
        </button>
      </footer>

      <PickingScanReviewModal
        v-if="review"
        :model-value="reviewOpen"
        :rows="review.rows"
        :part-nos="orderPartNos"
        :results="reviewResults"
        :applying="reviewApplying"
        @update:model-value="onReviewClosed"
        @apply="onApplyReview"
        @remove="onReviewRowRemoved"
        @retake="onReviewRetake"
      />

      <PickFromBoxDialog
        v-if="boxPickId"
        :box-id="boxPickId"
        :entries="boxPickEntries"
        @close="session.closeBoxPick"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { usePickingWorkLock } from "~/composables/usePickingWorkLock";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useBrandSymbologyScope } from "~/composables/useScannerConfig";
import { usePickingScanSession } from "~/composables/usePickingScanSession";
import { useViewConfig } from "~/composables/useViewConfig";
import { useFlowSteps } from "~/composables/useFlowSteps";
import { captureLabel, ocrResultToInput, useLabelScan } from "~/composables/useLabelScan";
import { badgeClass } from "~/composables/useStatusBadge";
import {
  extractPickingScanDrafts,
  type CandidateOptions,
  type OcrBarcode,
  type ScanMultiRowResult,
} from "~/utils/parseOcrScan";
import { playScanComplete, playScanError, playScanSuccess } from "~/utils/scanBeep";
import { rawCode } from "~/utils/text";
import { ApiError } from "~/services/apiClient";
import EmptyState from "~/components/EmptyState.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import PickingBoxesSection, { type BoxContentEntry } from "~/components/picking/PickingBoxesSection.vue";
import PickingIssueBanner from "~/components/picking/PickingIssueBanner.vue";
import PickingScanReviewModal from "~/components/picking/PickingScanReviewModal.vue";
import PickFromBoxDialog from "~/components/picking/PickFromBoxDialog.vue";
import PickingUnifiedItems from "~/components/picking/PickingUnifiedItems.vue";
import type { OcrInput } from "~/utils/ocrNormalize";
import type { PickingOrderDetail } from "~/services/types";
import type { ScanSessionResult } from "~/composables/usePickingScanSession";

definePageMeta({ title: "meta.pickingDetail" });

const route = useRoute();
const orderId = route.params.id as string;
const warehouse = useWarehouse();
const { heldByOther } = usePickingWorkLock(orderId);
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();
const { flowSteps, pickingShelfScan: shelfScanMode, dateCodeFormat } = useFlowSteps();
const { viewConfig } = useViewConfig();
const { parseRawValue } = useLabelScan();

useHead({ title: t("picking.detail.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PickingOrderDetail | null>(null);
const adding = ref<Record<string, boolean>>({});
const removing = ref<Record<string, boolean>>({});
const removingScans = ref<Record<string, boolean>>({});
const creatingBox = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});
const addingAll = ref<Record<string, boolean>>({});
const finishing = ref(false);
const claimingBox = ref(false);
const boxesExpanded = ref(false);
const boxSelections = ref<Record<string, string>>({});
const ocrCapturing = ref(false);
const scanIntoBoxId = ref<string | null>(null);
const scanningIntoBox = ref(false);

const review = ref<{
  rows: { parsed: OcrInput; options: CandidateOptions }[];
  raw: string;
} | null>(null);
const reviewOpen = ref(false);
const reviewResults = ref<ScanMultiRowResult[] | null>(null);
const reviewApplying = ref(false);

// The scan session (queue as a transient in-flight buffer, sticky shelf
// context, pick-from-box dialog, carton auto-queue) — spec
// docs/superpowers/specs/2026-10-12-picking-unified-detail-scan-design.md,
// auto-apply amendment
// docs/superpowers/specs/2026-10-14-picking-unified-scan-auto-apply-design.md:
// every queued scan is applied immediately (the queuedCount watch below), so
// there is no Confirm button; a mis-scan is undone via Remove scan.
const session = usePickingScanSession({
  orderItems: computed(() => order.value?.items ?? []),
  scope: computed(() => ({
    orgId: order.value?.orgId ?? undefined,
    subInventoryCode: order.value?.subInventoryCode ?? undefined,
    orderId: order.value?.id ?? undefined,
  })),
  shelfMode: shelfScanMode,
  dateCodeFormat,
  shelfStockFn: async (q) => (await warehouse.getPickingShelfStock(q)).qty,
});
const {
  rows,
  queuedCount,
  pendingShelf,
  boxPickId,
  boxPickEntries,
  completed,
  requireShelfScan,
  shelfWorkRemaining,
  applying,
} = session;

const orderItems = computed(() => order.value?.items ?? []);
const orderPartNos = computed(() => orderItems.value.map((i) => i.partNo));

function updateBoxSelections(value: Record<string, string>) {
  boxSelections.value = value;
}

// Restrict the hardware decoder to the order brands' barcode-type whitelist
// (e.g. KOA → PDF417) while this page is open; restored on leave. Shelf/box
// QR labels stay decodable — every scan path on this page matches them.
useBrandSymbologyScope(session.orderBrands, { withShelfCodes: true });

// Collapsed-row format (spec §5): the new allocations chips by default, the
// old itemFields-driven meta line when the admin configured "fields".
const collapsedStyle = computed(() => viewConfig.value.pickingDetail.collapsedStyle ?? "allocations");

// Cross-order packing: with a box armed ("scan into box"), item barcode
// scans from ANY order pick straight into that box (404
// no_matching_picking_item / 409 ambiguous_picking_item surface as toasts).
function toggleScanIntoBox(boxId: string) {
  scanIntoBoxId.value = scanIntoBoxId.value === boxId ? null : boxId;
}

async function scanIntoBox(boxId: string, barcode: string): Promise<boolean> {
  if (scanningIntoBox.value) return false;
  scanningIntoBox.value = true;
  try {
    // The backend's outdated date-code check needs the label's parsed date
    // code — best-effort supplier-template parse (the barcode may belong to
    // another order, so a parse miss just sends no dateCode).
    let dateCode: string | undefined;
    try {
      const parsedResult = await parseRawValue(barcode);
      if (parsedResult.matched) {
        dateCode = rawCode(ocrResultToInput(parsedResult.parsed).dateCode) ?? undefined;
      }
    } catch { /* parsing is best-effort — the scan still goes through */ }
    // require-* modes: forward the sticky shelf context — the backend needs
    // it when the barcode resolves to a lot-sourced allocation (409
    // shelf_scan_required); dock targets ignore it.
    await warehouse.scanIntoShippingBox(boxId, {
      barcode,
      dateCode,
      shelfCode: requireShelfScan.value ? pendingShelf.value?.shelfCode ?? undefined : undefined,
      boxId: requireShelfScan.value ? pendingShelf.value?.boxId ?? undefined : undefined,
    });
    await load();
    showToast(t("picking.boxesSection.scanIntoBoxSuccess", { box: boxId }));
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body?.message === "box_coo_mismatch") {
      showToast(t("errors.box_coo_mismatch", { coos: boxCoos(boxId).join(" / ") }));
    } else {
      showToast(errorMessage(e));
    }
    return false;
  } finally {
    scanningIntoBox.value = false;
  }
}

// The scan router: the armed "scan into box" takes every scan, then the
// pick-from-box dialog, then the scan-session routing (label → carton →
// shelf/box). Success kinds map to toasts here; the composable owns logic.
async function deliverScan(rawValue: string): Promise<boolean> {
  if (!order.value) return false;
  try {
    console.log("boxPickId", boxPickId.value)
    if (scanIntoBoxId.value) {
      return await scanIntoBox(scanIntoBoxId.value, rawValue);
    }
    const result: ScanSessionResult = boxPickId.value
      ? await session.handleBoxPickScan(rawValue)
      : await session.handleQrOrBoxScan(rawValue);
    if (!result.ok) {
      playScanError();
      showToast(t(`picking.scanSession.${result.message}`));
      return false;
    }
    playScanSuccess();
    if (result.kind === "queued") {
      showToast(t("common.scanSuccess"));
    } else if (result.kind === "carton") {
      showToast(
        t("picking.scanSession.cartonQueued", {
          carton: rawValue.trim(),
          count: result.count ?? 0,
          qty: result.qty ?? 0,
        })
      );
    } else if (result.kind === "shelf") {
      showToast(t("picking.scanSession.shelfContext", { shelf: rawValue.trim() }));
    }
    return true;
  } catch (e) {
    playScanError();
    showToast(errorMessage(e));
    return false;
  }
}

useHardwareScanner({
  // No `!applying` gate: scans arriving while a drain is running still queue
  // (the drain loop picks them up) — dropping them would lose operator scans.
  enabled: () =>
    !ocrCapturing.value &&
    !completed.value &&
    !reviewOpen.value &&
    !heldByOther.value &&
    !!order.value,
  onScan: async (rawValue: string) => await deliverScan(rawValue),
});

async function captureOcr() {
  // The shelf gate is per-scan (handleParsed checks the matched sources) — a
  // dock/receiving-carton label needs no shelf scan, so capture is never
  // pre-blocked; a lot-sourced match is rejected after the review confirm.
  ocrCapturing.value = true;
  try {
    const capture = await captureLabel();
    if (!capture) return;
    let barcodes: OcrBarcode[] = [];
    try {
      const parsed = JSON.parse(capture.barcodes);
      if (Array.isArray(parsed)) barcodes = parsed;
    } catch { /* ignore malformed barcode JSON */ }
    // Mirror useLabelScan.processCapture: QR-only captures (e.g. the browser
    // prompt fallback) go through the supplier-template QR parser; real
    // camera captures go through OCR text parsing.
    if (!capture.imagePath && barcodes.length === 1 && barcodes[0].format === "4") {
      // deliverScan owns the beeps + toasts for this path.
      await deliverScan(barcodes[0].value);
      return;
    }
    const drafts = extractPickingScanDrafts(
      { text: capture.text, barcodes },
      orderPartNos.value
    );
    review.value = {
      rows: drafts.map((draft) => ({
        parsed: ocrResultToInput(draft.parsed),
        options: draft.options,
      })),
      raw: capture.text,
    };
    reviewResults.value = null;
    reviewOpen.value = true;
    playScanSuccess();
  } catch (e) {
    playScanError();
    showToast(errorMessage(e));
  } finally {
    ocrCapturing.value = false;
  }
}

async function onApplyReview(entries: { row: OcrInput; index: number; rowId: number }[]) {
  if (!review.value || reviewApplying.value) return;
  reviewApplying.value = true;
  const raw = review.value.raw;
  const results: ScanMultiRowResult[] = [];
  try {
    for (const { row, index, rowId } of entries) {
      const result = await session.handleParsed(
        row,
        `${raw} [row ${rowId}]`,
        "ocr"
      );
      results.push({
        index,
        ok: result.ok,
        message: result.ok ? undefined : t(`picking.scanSession.${result.message}`),
      });
    }
    const merged = new Map<number, ScanMultiRowResult>();
    for (const result of reviewResults.value ?? []) merged.set(result.index, result);
    for (const result of results) merged.set(result.index, result);
    reviewResults.value = [...merged.values()];
    if (reviewResults.value.every((result) => result.ok)) {
      reviewOpen.value = false;
      review.value = null;
      reviewResults.value = null;
      showToast(t("common.scanSuccess"));
    }
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    reviewApplying.value = false;
  }
}

function onReviewRetake() {
  reviewOpen.value = false;
  review.value = null;
  reviewResults.value = null;
  captureOcr();
}

function onReviewClosed(v: boolean) {
  reviewOpen.value = v;
  if (!v) {
    review.value = null;
    reviewResults.value = null;
  }
}

function onReviewRowRemoved(index: number) {
  reviewResults.value = (reviewResults.value ?? [])
    .filter((result) => result.index !== index)
    .map((result) => (result.index > index ? { ...result, index: result.index - 1 } : result));
}

// Auto-apply: every queued scan is sent right away (no Confirm button).
// session.confirm no-ops while a drain is running, and the drain loop picks
// up rows queued mid-drain — so rapid successive scans all apply exactly once.
watch(queuedCount, (count) => {
  if (count > 0) void confirm();
});

// Completion cue: the queue has drained and every item's packages cover its
// required qty (spec 2026-10-03 progress-based completion). One cue per
// transition; finishing stays manual — the bottom-bar Complete Picking
// button once every item is boxed.
watch(completed, (done) => {
  if (done) playScanComplete();
});

async function confirm() {
  const failed = await session.confirm(
    async (row) => {
      await warehouse.scanPickingItem(row.itemId, {
        allocationId: row.allocationId,
        qty: row.qty,
        dateCode: row.dateCode,
        lotCode: row.lotCode,
        coo: row.coo,
        cow: row.cow,
        // Hardware-scan rows carry the raw label string so the backend can
        // record it on every portion; OCR rows have no scan string.
        barcode: row.source === "qr" ? row.raw : undefined,
        // The label's part keys as scanned — the backend stores them on the
        // package so measuring/verify show + match the scanned part, not
        // the allocated item's part.
        scannedPartNo: row.scannedPartNo,
        scannedWclItemNo: row.scannedWclItemNo ?? undefined,
        // Sticky shelf-scan context (require-* modes): every scan POST
        // carries the shelf/box the operator last scanned.
        shelfCode: requireShelfScan.value ? pendingShelf.value?.shelfCode ?? undefined : undefined,
        boxId: requireShelfScan.value ? pendingShelf.value?.boxId ?? undefined : undefined,
      });
    },
    errorMessage,
    async () => {
      // The backend rebuilds allocation rows (new ids) after every applied
      // scan — refetch and re-resolve the remaining queued rows.
      order.value = await warehouse.getPickingOrder(orderId);
      session.reresolveQueued();
    }
  );
  for (const row of rows.value) {
    if (row.error === "allocation_changed") {
      row.error = t("picking.scanSession.allocationChanged");
    }
  }
  if (failed > 0) {
    showToast(t("picking.scanSession.partialFail", { count: failed }));
  }
}

const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i) => i.pickedQty >= i.qty) ?? false
);
const headerBadgeClass = computed(() => badgeClass(order.value?.status));
const headerStatus = computed(() => statusLabel.picking(order.value?.status ?? ""));
const openBoxes = computed(() =>
  (order.value?.boxes ?? []).filter((b) => b.status === "open")
);
const actionable = computed(
  () =>
    order.value?.status !== "picking_finished" &&
    order.value?.status !== "measuring_finished" &&
    order.value?.status !== "issue" &&
    !heldByOther.value
);
const unboxedCountForOrder = computed(() => {
  return (order.value?.items ?? []).reduce((sum, item) => {
    const unboxed = (item.packages ?? []).filter((p) => !p.shippingBoxId);
    return sum + unboxed.length;
  }, 0);
});
const anyAddingAll = computed(() => Object.values(addingAll.value).some(Boolean));

// The boxes' contents derived from the order's packages — feeds each box
// card's expandable contents list, the mixed-COO warning chip, and the
// client-side one-COO-per-box guard (spec 2026-10-16).
const boxContents = computed<Record<string, BoxContentEntry[]>>(() => {
  const map: Record<string, BoxContentEntry[]> = {};
  for (const item of order.value?.items ?? []) {
    const partLabel = item.wclItemNo ?? item.partNo;
    for (const pkg of item.packages ?? []) {
      if (!pkg.shippingBoxId) continue;
      (map[pkg.shippingBoxId] ??= []).push({
        packageId: pkg.id,
        partLabel,
        qty: pkg.qty,
        dateCode: pkg.dateCode,
        lotCode: pkg.lotCode,
        coo: pkg.coo,
        cow: pkg.cow,
      });
    }
  }
  return map;
});

/** Distinct non-null COOs currently in a box. */
function boxCoos(boxId: string): string[] {
  return [...new Set((boxContents.value[boxId] ?? []).map((e) => e.coo).filter((c): c is string => !!c))];
}

/** One COO per box (spec 2026-10-16): true when packing a package with a
 *  non-null COO into a box that already holds other non-null COOs. */
function cooConflict(boxId: string, coo: string | null): boolean {
  const c = coo?.trim() ? coo.trim() : null;
  if (!c) return false;
  const coos = boxCoos(boxId);
  return coos.length > 0 && !coos.includes(c);
}

// Title, status badge, header info rows and actions render in the AppHeader.
usePageHeader({
  title: () => order.value?.orderNo,
  badgeText: () => (order.value ? headerStatus.value : undefined),
  badgeClass: () => headerBadgeClass.value,
  warningText: () =>
    order.value && order.value.outdatedWarningCount > 0
      ? t("outdatedWarning.chip", { count: order.value.outdatedWarningCount })
      : undefined,
  info: () => {
    const o = order.value;
    if (!o) return [];
    const rows = [
      { label: t("picking.detail.customer"), value: o.customerCode || t("common.noData") },
      {
        label: t("picking.detail.deliveryDate"),
        value: o.deliveryDate ? new Date(o.deliveryDate).toLocaleDateString() : t("common.noData"),
      },
      { label: t("picking.detail.poNo"), value: o.poNo || t("common.noData") },
      { label: t("picking.detail.shipTo"), value: o.shipTo || t("common.noData") },
    ];
    if (o.orgId != null) rows.push({ label: t("picking.detail.org"), value: `Org ${o.orgId}` });
    if (o.subInventoryCode) rows.push({ label: t("picking.detail.subInventory"), value: o.subInventoryCode });
    if (o.workingByName) rows.push({ label: t("picking.detail.lockedBy"), value: o.workingByName });
    return rows;
  },
});

async function load() {
  try {
    order.value = await warehouse.getPickingOrder(orderId);
    // An armed scan-into box that left the open state (closed/cancelled
    // elsewhere) disarms itself.
    if (
      scanIntoBoxId.value &&
      !order.value.boxes.some((b) => b.id === scanIntoBoxId.value && b.status === "open")
    ) {
      scanIntoBoxId.value = null;
    }
    const nextBoxSelections: Record<string, string> = {};
    for (const item of order.value.items) {
      for (const pkg of item.packages ?? []) {
        if (!pkg.shippingBoxId) {
          nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
        }
      }
    }
    boxSelections.value = nextBoxSelections;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function createBox() {
  creatingBox.value = true;
  boxesExpanded.value = true;
  try {
    await warehouse.createShippingBoxForPickingOrder(orderId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creatingBox.value = false;
  }
}

// Whole-box exact-match claim: the hinted shelf carton becomes this order's
// (prefilled) shipping box with everything already packed.
async function claimBox() {
  const box = order.value?.suggestedBox;
  if (!box || claimingBox.value) return;
  const confirmed = window.confirm(t("picking.detail.useWholeBoxConfirm", { box: box.id }));
  if (!confirmed) return;
  claimingBox.value = true;
  try {
    const result = await warehouse.claimShelfBox(orderId, box.id);
    boxesExpanded.value = true;
    await load();
    showToast(t("picking.detail.boxMatchClaimed", { box: result.shippingBoxId }));
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    claimingBox.value = false;
  }
}

async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    await warehouse.cancelShippingBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;
  if (unboxedCountForOrder.value === 0) return;
  const confirmed = window.confirm(t("picking.boxesSection.addAllConfirm"));
  if (!confirmed) return;
  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedPackagesToBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  // One COO per box (spec 2026-10-16) — client-side guard for a friendly
  // message; the backend's 409 box_coo_mismatch is the safety net.
  const pkg = order.value?.items
    .flatMap((i) => i.packages ?? [])
    .find((p) => p.id === packageId);
  if (pkg && cooConflict(boxId, pkg.coo)) {
    showToast(t("errors.box_coo_mismatch", { coos: boxCoos(boxId).join(" / ") }));
    return;
  }
  adding.value[packageId] = true;
  try {
    await warehouse.addPackageToBox(packageId, boxId);
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body?.message === "box_coo_mismatch") {
      showToast(t("errors.box_coo_mismatch", { coos: boxCoos(boxId).join(" / ") }));
    } else {
      error.value = errorMessage(e);
    }
  } finally {
    adding.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  const pkg = order.value?.items
    .flatMap((i) => i.packages ?? [])
    .find((p) => p.id === packageId);
  if (!pkg?.shippingBoxId) return;
  removing.value[packageId] = true;
  try {
    await warehouse.removePackageFromBox(pkg.shippingBoxId, packageId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removing.value[packageId] = false;
  }
}

/** Undo a confirmed scan (mis-scan correction): the backend reverses the
 *  PICK ledger + returns the stock + reopens the allocation — so confirm
 *  first, like put-away's committed-scan removal. 409 package_already_in_box
 *  / package_already_verified keep boxed/verified packages safe. */
async function removeScan(packageId: string) {
  const pkg = order.value?.items
    .flatMap((i) => i.packages ?? [])
    .find((p) => p.id === packageId);
  if (!pkg || pkg.shippingBoxId) return;
  if (!window.confirm(t("picking.itemsSection.removeScanConfirm", { qty: pkg.qty }))) return;
  removingScans.value[packageId] = true;
  try {
    await warehouse.removeScannedPackage(packageId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removingScans.value[packageId] = false;
  }
}

async function finish() {
  finishing.value = true;
  try {
    // Finish only flips the order — measuring follows the boxes, not the
    // order. With the measuring step off the finish spawned the boxes'
    // verify tasks instead, so hand the operator straight over to verify.
    await warehouse.finishPickingOrder(orderId);
    if (!flowSteps.value.measuring && flowSteps.value.verify) {
      await navigateTo("/verify");
      return;
    }
    await load();
  } catch (e) {
    // 409 unresolved_outdated_warnings (spec 2026-10-07): the order stays
    // open — toast the count and reload so the header warning chip shows.
    if (
      e instanceof ApiError &&
      e.status === 409 &&
      e.body?.error === "unresolved_outdated_warnings"
    ) {
      const count = typeof e.body.count === "number" ? e.body.count : 0;
      showToast(t("errors.unresolved_outdated_warnings", { count }));
      await load();
    } else {
      error.value = errorMessage(e);
    }
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load);

// Scans queue and auto-apply in a drain — leaving mid-drain abandons the
// not-yet-sent rows, so warn whenever anything is still queued (in-flight
// applies included).
onBeforeRouteLeave(() => {
  if (queuedCount.value > 0) {
    return window.confirm(t("picking.scanSession.leaveWarning"));
  }
});

function beforeUnload(e: BeforeUnloadEvent) {
  if (queuedCount.value > 0) e.preventDefault();
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
});
onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));
</script>

<style scoped>
/* Clearance so the fixed footer never covers the last list row. */
.unified-page {
  padding-bottom: 4.5rem;
}

.work-lock-banner {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 0.375rem;
  color: #92400e;
  font-size: 0.875rem;
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
}

.box-match-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  background: #ecfdf5;
  border: 1px solid #10b981;
  border-radius: 0.375rem;
  color: #065f46;
  font-size: 0.875rem;
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
}

.shelf-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: #dbeafe;
  border: 1px solid #3b82f6;
  border-radius: 0.375rem;
  color: #1e40af;
  font-size: 1rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.shelf-banner--empty {
  justify-content: center;
  background: #fef3c7;
  border-color: #f59e0b;
  color: #92400e;
}

.shelf-banner-label {
  font-weight: 700;
}

.unified-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg, #f3f4f6);
  border-top: 1px solid var(--muted-light, #e5e7eb);
  z-index: 50;
}

.unified-footer__finish {
  min-width: 10rem;
}
</style>
