<template>
  <div class="scan-session">
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <header class="scan-session__header">
        <h1 class="scan-session__title">{{ $t('picking.scanSession.title', { orderNo: order.orderNo }) }}</h1>
        <button class="btn btn--small btn--secondary" :disabled="applying" @click="goBack">
          {{ $t('picking.scanSession.back') }}
        </button>
      </header>

      <div v-if="heldByOther" class="scan-session__lock-banner">
        {{ $t('picking.scanSession.heldBy', { name: heldByOther }) }}
      </div>

      <div
        v-if="requireShelfScan && !completed"
        class="scan-session__shelf-banner"
        :class="{ 'scan-session__shelf-banner--empty': !pendingShelf }"
      >
        <template v-if="pendingShelf">
          <span class="scan-session__shelf-banner-label">
            {{ $t('picking.scanSession.shelfContext', { shelf: pendingShelf.label }) }}
          </span>
          <button class="btn btn--small btn--secondary" @click="pendingShelf = null">
            {{ $t('picking.scanSession.shelfClear') }}
          </button>
        </template>
        <span v-else>{{ $t('picking.scanSession.scanShelfFirst') }}</span>
      </div>

      <div v-if="completed" class="card scan-session__done">
        <p class="scan-session__done-text">{{ $t('picking.scanSession.allApplied') }}</p>
        <p class="scan-session__done-hint">{{ $t('picking.scanSession.boxingHint') }}</p>
        <div class="scan-session__done-actions">
          <button class="btn" @click="router.push(backTarget)">
            {{ $t('picking.scanSession.goBoxing') }}
          </button>
          <button class="btn btn--secondary" @click="continueScanning">
            {{ $t('picking.scanSession.continueScan') }}
          </button>
        </div>
      </div>

      <template v-else>
        <div class="card scan-session__progress">
          <div v-for="group in partGroups" :key="group.key" class="scan-session__progress-row">
            <span class="scan-session__part">
              <span class="scan-session__line">L{{ group.lines }}/S{{ group.shipments }}</span>
              {{ group.partNo }}
              <span v-if="group.sources" class="scan-session__sources" :title="group.warnings || undefined">
                {{ group.sources }}
              </span>
            </span>
            <span class="scan-session__counts">
              {{ $t('picking.scanSession.progress', {
                required: formatCompactQty(group.required),
                scanned: formatCompactQty(group.scanned),
              }) }}
            </span>
          </div>
        </div>

        <p v-if="rows.length === 0" class="empty">{{ $t('picking.scanSession.emptyQueue') }}</p>

        <table v-else class="scan-session__table">
          <thead>
            <tr>
              <th>#</th>
              <th>{{ $t('picking.scanSession.colPart') }}</th>
              <th>{{ $t('picking.scanSession.colQty') }}</th>
              <th>{{ $t('picking.scanSession.colLot') }}</th>
              <th>{{ $t('picking.scanSession.colSource') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in displayRows"
              :key="row.key"
              :class="{ 'scan-session__row--failed': row.status === 'failed' }"
            >
              <td>{{ displayRows.length - index }}</td>
              <td>{{ row.wclItemNo ?? row.partNo }}</td>
              <td>{{ row.qty }}</td>
              <td>{{ row.lotCode || $t('common.stateNone') }} / {{ row.dateCode || $t('common.stateNone') }}</td>
              <td>{{ row.source === 'mixed' ? 'QR/OCR' : row.source === 'ocr' ? 'OCR' : 'QR' }}</td>
              <td>
                <span v-if="row.status === 'failed'" class="scan-session__error">{{ row.error }}</span>
                <button class="btn btn--small btn--secondary" :disabled="applying" @click="removeGroup(row.keys)">
                  {{ $t('picking.scanSession.removeRow') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <footer class="scan-session__footer">
          <button class="btn btn--small" :disabled="applying || ocrCapturing || !!heldByOther || (requireShelfScan && !pendingShelf)" @click="captureOcr">
            <template v-if="ocrCapturing"><InlineSpinner /> {{ $t('picking.scanSession.ocrCapture') }}</template>
            <template v-else>{{ $t('picking.scanSession.ocrCapture') }}</template>
          </button>
          <button class="btn" :disabled="applying || queuedCount === 0 || !!heldByOther" @click="confirm">
            <template v-if="applying"><InlineSpinner /> {{ $t('picking.scanSession.confirming') }}</template>
            <template v-else>{{ $t('picking.scanSession.confirm', { count: queuedCount }) }}</template>
          </button>
        </footer>
      </template>

      <PickingScanReviewModal
        v-if="review"
        :model-value="reviewOpen"
        :parsed="review.parsed"
        :options="review.options"
        :part-nos="orderPartNos"
        @update:model-value="onReviewClosed"
        @confirm="onReviewConfirm"
        @retake="onReviewRetake"
      />

      <ScanMultiItemModal
        v-if="multiReview"
        :model-value="multiOpen"
        :rows="multiReview.rows"
        :part-nos="orderPartNos"
        :results="multiResults"
        @update:model-value="onMultiClosed"
        @apply="onApplyMulti"
        @remove="onMultiRowRemoved"
      />

      <PickFromBoxDialog
        v-if="boxPickId"
        :box-id="boxPickId"
        :entries="boxPickEntries"
        @close="boxPickId = null"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { usePickingWorkLock } from "~/composables/usePickingWorkLock";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { useBrandSymbologyScope } from "~/composables/useScannerConfig";
import { usePickingScanQueue } from "~/composables/usePickingScanQueue";
import { captureLabel, ocrResultToInput, useLabelScan } from "~/composables/useLabelScan";
import {
  extractMultiItemRows,
  parseAndIdentify,
  type CandidateOptions,
  type OcrBarcode,
  type ScanMultiRow,
  type ScanMultiRowResult,
} from "~/utils/parseOcrScan";
import { playScanComplete, playScanError, playScanSuccess } from "~/utils/scanBeep";
import EmptyState from "~/components/EmptyState.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import PickingScanReviewModal from "~/components/picking/PickingScanReviewModal.vue";
import PickFromBoxDialog, { type PickFromBoxEntry } from "~/components/picking/PickFromBoxDialog.vue";
import ScanMultiItemModal from "~/components/ScanMultiItemModal.vue";
import { normalize, type OcrInput } from "~/utils/ocrNormalize";
import { normalizePartNo } from "~/utils/text";
import { formatCompactQty } from "~/utils/formatNumber";
import { createShelfStockChecker } from "~/utils/shelfStockCheck";
import type { PickingOrderDetail } from "~/services/types";

definePageMeta({ title: "meta.pickingScan", props: { noPadding: true } });

const route = useRoute();
const router = useRouter();
const orderId = route.params.id as string;
const warehouse = useWarehouse();
const { heldByOther } = usePickingWorkLock(orderId);
const { t } = useI18n();
const errorMessage = useErrorMessage();
const { showToast } = useToast();
const { parseRawValue } = useLabelScan();

useHead({ title: t("meta.pickingScan") });

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PickingOrderDetail | null>(null);
const applying = ref(false);
const ocrCapturing = ref(false);

const orderItems = computed(() => order.value?.items ?? []);

// Picking shelf-scan mode (flow config pickingShelfScan, spec
// 2026-10-02-picking-shelf-scan-config-design.md): in the require-* modes one
// sticky shelf scan sets the location banner — the operator scans the shelf
// once per location visit, then keeps scanning items there; the banner is
// replaced by the next shelf scan or cleared manually. No pick-from-box
// dialog opens on a shelf scan in these modes.
const { pickingShelfScan: shelfScanMode } = useFlowSteps();
const requireShelfScan = computed(() => shelfScanMode.value !== "off");
const pendingShelf = ref<{ label: string; shelfCode: string | null; boxId: string | null } | null>(null);
// require-match presence check: the scanned part must have stock on the
// pending shelf (cached per location+part for the session; the backend's
// no_stock_at_location 409 is the safety net when stock moves mid-session).
const shelfStockChecker = createShelfStockChecker(async (q) => (await warehouse.getPickingShelfStock(q)).qty);
const { rows, addScan, matchBoxAllocations, matchCartonAllocations, addCartonScan, allocationRemaining, addAllocationScan, removeRow, reresolveQueued, applyAll } = usePickingScanQueue(orderItems);
const queuedCount = computed(() => rows.value.filter((r) => r.status === "queued").length);

// The table aggregates scans of the same part + batch fields (lot/date/coo/
// cow) into one row with the total qty — one label may span several order
// lines of the same part, so portions carry different item ids. Display
// only; the queue stays one row per portion so Confirm applies each label
// exactly as scanned.
interface DisplayRow {
  key: string;
  keys: string[];
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  lotCode: string | null;
  dateCode: string | null;
  source: "qr" | "ocr" | "mixed";
  status: "queued" | "failed";
  error: string | null;
}

const displayRows = computed<DisplayRow[]>(() => {
  const groups = new Map<string, DisplayRow>();
  for (const row of rows.value) {
    const gk = [normalizePartNo(row.partNo), row.lotCode ?? "", row.dateCode ?? "", row.coo ?? "", row.cow ?? ""].join("|");
    const g = groups.get(gk);
    if (g) {
      g.keys.push(row.key);
      g.qty += row.qty;
      if (g.source !== row.source) g.source = "mixed";
      if (row.status === "failed") {
        g.status = "failed";
        g.error = row.error;
      }
    } else {
      groups.set(gk, {
        key: row.key,
        keys: [row.key],
        partNo: row.partNo,
        wclItemNo: orderItems.value.find((i) => normalizePartNo(i.partNo) === normalizePartNo(row.partNo))?.wclItemNo ?? null,
        qty: row.qty,
        lotCode: row.lotCode,
        dateCode: row.dateCode,
        source: row.source,
        status: row.status === "failed" ? "failed" : "queued",
        error: row.error,
      });
    }
  }
  return [...groups.values()];
});

function removeGroup(keys: string[]) {
  for (const key of keys) removeRow(key);
}
const orderPartNos = computed(() => orderItems.value.map((i) => i.partNo));
// Distinct parts.brand values of the order's items — brand-scoped template
// lookup tries these suppliers' QR templates first (rest as fallback).
const orderBrands = computed(() => [
  ...new Set(orderItems.value.map((i) => i.brand).filter((b): b is string => !!b)),
]);
// Restrict the hardware decoder to the order brands' barcode-type whitelist
// (e.g. KOA → PDF417) while this page is open; restored on leave. Shelf/box
// QR labels stay decodable — the scan session matches them for the
// pick-from-box dialog and the shelf-scan modes.
useBrandSymbologyScope(orderBrands, { withShelfCodes: true });

// OCR review state: a single parsed record opens the confirm form; a label
// that parses into 2+ item rows opens the multi-item table instead.
const review = ref<{ parsed: OcrInput; options: CandidateOptions; raw: string } | null>(null);
const reviewOpen = ref(false);
const multiReview = ref<{ rows: ScanMultiRow[]; raw: string } | null>(null);
const multiOpen = ref(false);
const multiResults = ref<ScanMultiRowResult[] | null>(null);

const backTarget = computed(() =>
  route.query.from === "receiving" && typeof route.query.ro === "string"
    ? `/receiving/${route.query.ro}?tab=picking`
    : `/picking/${orderId}`
);

function serverScannedQty(item: PickingOrderDetail["items"][number]): number {
  return (item.packages ?? []).reduce((sum, p) => sum + p.qty, 0);
}

type OrderItem = PickingOrderDetail["items"][number];

/** Distinct non-null values joined for display (e.g. line numbers of merged
 *  same-part lines); "—" when every value is null. */
function joinDistinct(values: (number | string | null | undefined)[]): string {
  const distinct = [...new Set(values.filter((v): v is number | string => v != null))];
  return distinct.length ? distinct.join("·") : "—";
}

/** Progress rows: order lines merged by part — one row per part no with the
 *  required/scanned totals across its lines (a part often spans several
 *  upstream lines, and one scanned package may cover more than one of them). */
const partGroups = computed(() => {
  const groups = new Map<string, OrderItem[]>();
  for (const item of orderItems.value) {
    const key = normalizePartNo(item.partNo);
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    partNo: items[0].wclItemNo ?? items[0].partNo,
    lines: joinDistinct(items.map((i) => i.lineNumber)),
    shipments: joinDistinct(items.map((i) => i.shipmentNumber)),
    required: items.reduce((sum, i) => sum + i.qty, 0),
    scanned: items.reduce((sum, i) => sum + serverScannedQty(i), 0),
    sources: allocationSources(items),
    warnings: allocationWarnings(items),
  }));
});

// Progress-based completion (2026-10-03 design): the queue is empty and
// every part group is fully scanned (scanned = Σ packages from the last
// order fetch) — independent of confirm failure history.
const completed = computed(
  () =>
    partGroups.value.length > 0 &&
    queuedCount.value === 0 &&
    partGroups.value.every((g) => g.scanned >= g.required)
);

// Queued (not yet confirmed) qty per part group key.
const queuedQtyByPart = computed(() => {
  const map: Record<string, number> = {};
  for (const row of rows.value) {
    if (row.status !== "queued") continue;
    const key = normalizePartNo(row.partNo);
    map[key] = (map[key] ?? 0) + row.qty;
  }
  return map;
});

// The queued scans cover what the server has not confirmed yet — every part
// group's required qty is matched. On the transition into this state play a
// success cue and offer to confirm right away (one prompt per transition;
// removing a row and re-matching re-arms it).
const orderMatched = computed(
  () =>
    partGroups.value.length > 0 &&
    queuedCount.value > 0 &&
    partGroups.value.every((g) => g.scanned + (queuedQtyByPart.value[g.key] ?? 0) >= g.required)
);

watch(orderMatched, (matched) => {
  if (!matched || applying.value || heldByOther.value) return;
  playScanComplete();
  if (window.confirm(t("picking.scanSession.matchConfirm"))) void confirm();
});

/** Where these items' open qty is allocated from — the "what/where to scan"
 *  hint shown under each part: receiving carton (CTN), shelf box @ shelf, or
 *  a bare shelf code for loose lots. */
function allocationSources(items: OrderItem[]): string {
  return items
    .flatMap((item) => item.allocations ?? [])
    .filter((a) => a.qty > 0)
    .map((a) => {
      const warn = a.lot?.shelfWarning ? " ⚠️" : "";
      if (a.lot?.boxId) return `${a.lot.boxId}${a.lot.shelfCode ? ` @ ${a.lot.shelfCode}` : ""} ×${a.qty}${warn}`;
      if (a.lot?.shelfCode) return `${a.lot.shelfCode} ×${a.qty}${warn}`;
      if (a.boxId) return `CTN ${a.boxId} ×${a.qty}`;
      return null;
    })
    .filter((s): s is string => !!s)
    .join(" · ");
}

/** Distinct shelf warnings across the items' open allocations — tooltip for
 *  the ⚠️ markers in allocationSources. */
function allocationWarnings(items: OrderItem[]): string {
  return [
    ...new Set(
      items
        .flatMap((item) => item.allocations ?? [])
        .filter((a) => a.qty > 0)
        .map((a) => a.lot?.shelfWarning)
        .filter((w): w is string => !!w)
    ),
  ].join("\n");
}

async function load() {
  try {
    order.value = await warehouse.getPickingOrder(orderId);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function handleParsed(parsed: ReturnType<typeof ocrResultToInput>, raw: string, source: "qr" | "ocr"): Promise<boolean> {
  if (requireShelfScan.value && !pendingShelf.value) {
    showToast(t("picking.scanSession.scanShelfFirst"));
    return false;
  }
  // require-match scan-time presence check: the part must have stock on the
  // pending shelf (item matching itself is the normal picking flow — the
  // allocation candidates are NOT filtered by shelf).
  if (shelfScanMode.value === "require-match" && pendingShelf.value) {
    const stocked = await shelfStockChecker.hasStock({
      partNo: String(parsed.partNo ?? ""),
      wclItemNo: parsed.wclItemNo || undefined,
      shelfCode: pendingShelf.value.shelfCode ?? undefined,
      boxId: pendingShelf.value.boxId ?? undefined,
      orgId: order.value?.orgId ?? undefined,
      subInventoryCode: order.value?.subInventoryCode ?? undefined,
    });
    if (!stocked) {
      showToast(t("picking.scanSession.item_not_on_shelf"));
      return false;
    }
  }
  const result = addScan(parsed, raw, source);
  if (!result.ok) {
    showToast(t(`picking.scanSession.${result.message}`));
    return false;
  }
  showToast(t("common.scanSuccess"));
  return true;
}

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

// "Pick from box" flow: scanning a shelf box/shelf barcode opens a dialog
// listing what the order still needs from it; part-label scans while it is
// open are queued against that box's allocations only (never auto-picked).
// Receiving cartons skip the dialog — a carton scan queues everything the
// order needs from it in one go (queueCarton).
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

/** Shelf/box scan handling. In the require-* modes a shelf scan ONLY
 *  sets/replaces the location banner (never opens the pick-from-box dialog);
 *  in off mode it opens the dialog as a lookup shortcut. */
function openBoxPick(rawValue: string): boolean {
  const matches = matchBoxAllocations(rawValue);
  if (requireShelfScan.value) {
    if (matches.length > 0) {
      setPendingShelfFromMatch(rawValue);
    } else if (shelfScanMode.value === "require-any") {
      // require-any: an unmatched non-label scan is still a shelf scan — the
      // operator is at a shelf this order has no allocations on, which is
      // allowed; the confirm 409 (no_stock_at_location) is the guard.
      pendingShelf.value = { label: rawValue.trim(), shelfCode: rawValue.trim(), boxId: null };
    } else {
      showToast(t("picking.scanSession.no_match"));
      return false;
    }
    showToast(t("picking.scanSession.shelfContext", { shelf: rawValue.trim() }));
    playScanSuccess();
    return true;
  }
  if (matches.length === 0) {
    showToast(t("picking.scanSession.no_match"));
    return false;
  }
  boxPickId.value = rawValue.trim();
  return true;
}

/** Receiving-carton scan: queue everything this order still needs from the
 *  carton (known, sealed contents — no per-part scans). */
function queueCarton(rawValue: string): boolean {
  const matches = matchCartonAllocations(rawValue);
  if (matches.length === 0) return false;
  const result = addCartonScan(matches, rawValue.trim());
  if (!result.ok) {
    showToast(t(`picking.scanSession.${result.message}`));
    return true;
  }
  showToast(
    t("picking.scanSession.cartonQueued", {
      carton: rawValue.trim(),
      count: result.count,
      qty: result.qty,
    })
  );
  playScanSuccess();
  return true;
}

/** A scan while the pick-from-box dialog is open: a new box/shelf barcode
 * switches the dialog; a carton barcode queues the carton (and closes the
 * dialog); anything else must be a part label for one of the box's items. */
async function handleBoxPickScan(rawValue: string): Promise<boolean> {
  if (matchBoxAllocations(rawValue).length > 0) {
    boxPickId.value = rawValue.trim();
    return true;
  }
  if (matchCartonAllocations(rawValue).length > 0) {
    boxPickId.value = null;
    return queueCarton(rawValue);
  }
  const parsedResult = await parseRawValue(rawValue, undefined, orderBrands.value);
  if (!parsedResult.matched) {
    showToast(t("picking.scanSession.no_match"));
    return false;
  }
  const parsed = ocrResultToInput(parsedResult.parsed);
  const wanted = normalize(String(parsed.partNo ?? ""));
  const entry = boxPickEntries.value.find((e) => normalize(e.partNo) === wanted);
  if (!entry) {
    showToast(t("picking.scanSession.part_not_in_box"));
    return false;
  }
  const result = addAllocationScan(entry.itemId, entry.allocationId, parsed, rawValue, "qr");
  if (!result.ok) {
    showToast(t(`picking.scanSession.${result.message}`));
    return false;
  }
  showToast(t("common.scanSuccess"));
  return true;
}

/** Hardware/camera QR path: supplier label first, receiving carton second
 *  (auto-queue), shelf box/shelf barcode last (pick-from-box dialog). */
async function handleQrOrBoxScan(rawValue: string): Promise<boolean> {
  const parsedResult = await parseRawValue(rawValue, undefined, orderBrands.value);
  if (parsedResult.matched) {
    return handleParsed(ocrResultToInput(parsedResult.parsed), rawValue, "qr");
  }
  if (matchCartonAllocations(rawValue).length > 0) {
    return queueCarton(rawValue);
  }
  return openBoxPick(rawValue);
}

useHardwareScanner({
  enabled: () =>
    !applying.value &&
    !ocrCapturing.value &&
    !completed.value &&
    !reviewOpen.value &&
    !multiOpen.value &&
    !heldByOther.value &&
    !!order.value,
  onScan: async (rawValue: string) => {
    if (!order.value) return false;
    // handleParsed awaits the require-match presence fetch — surface its
    // rejections as a toast instead of losing the scan silently.
    try {
      if (boxPickId.value) return await handleBoxPickScan(rawValue);
      return await handleQrOrBoxScan(rawValue);
    } catch (e) {
      playScanError();
      showToast(errorMessage(e));
      return false;
    }
  },
});

async function captureOcr() {
  // In the require-* shelf-scan modes an OCR scan needs the sticky shelf
  // context (sent with every scan POST at confirm) — capture only after a
  // shelf/box scan; one confirmed OCR record queues exactly like one scan.
  if (requireShelfScan.value && !pendingShelf.value) {
    showToast(t("picking.scanSession.scanShelfFirst"));
    return;
  }
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
      const qrValue = barcodes[0].value;
      const ok = await handleQrOrBoxScan(qrValue);
      if (ok) playScanSuccess();
      else playScanError();
      return;
    }
    const targets = orderPartNos.value;
    // A label whose items table lists several parts parses into 2+ rows:
    // open the multi-item table so the operator can edit every row.
    const multiRows = extractMultiItemRows(capture.text, targets);
    if (multiRows.length >= 2) {
      multiReview.value = {
        rows: multiRows.map((r) => ({ partNo: r.partNo, qty: r.qty ?? null })),
        raw: capture.text,
      };
      multiResults.value = null;
      multiOpen.value = true;
      playScanSuccess();
      return;
    }
    // Single record: pop the confirm form with the OCR candidates as chips.
    const parsedResult = parseAndIdentify({ text: capture.text, barcodes }, targets);
    review.value = {
      parsed: ocrResultToInput(parsedResult.parsed),
      options: parsedResult.options,
      raw: capture.text,
    };
    reviewOpen.value = true;
    playScanSuccess();
  } catch (e) {
    playScanError();
    showToast(errorMessage(e));
  } finally {
    ocrCapturing.value = false;
  }
}

function onReviewConfirm(parsed: OcrInput) {
  if (!review.value) return;
  void handleParsed(parsed, review.value.raw, "ocr");
  reviewOpen.value = false;
  review.value = null;
}

function onReviewRetake() {
  reviewOpen.value = false;
  review.value = null;
  captureOcr();
}

function onReviewClosed(v: boolean) {
  reviewOpen.value = v;
  if (!v) review.value = null;
}

function onApplyMulti(entries: { row: ScanMultiRow; index: number }[]) {
  if (!multiReview.value) return;
  const raw = multiReview.value.raw;
  const results: ScanMultiRowResult[] = [];
  for (const { row, index } of entries) {
    // Suffix the raw per part so the queue's duplicate-raw guard treats each
    // row of one multi-item label as a distinct scan.
    const result = addScan(
      {
        partNo: row.partNo,
        qty: row.qty ?? "",
        dateCode: "",
        lotCode: "",
        coo: "",
        cow: "",
      },
      `${raw} [${row.partNo}]`,
      "ocr"
    );
    results.push({
      index,
      ok: result.ok,
      message: result.ok ? undefined : t(`picking.scanSession.${result.message}`),
    });
  }
  // Merge with earlier results (replacing by index) so locked rows stay marked.
  const merged = new Map<number, ScanMultiRowResult>();
  for (const r of multiResults.value ?? []) merged.set(r.index, r);
  for (const r of results) merged.set(r.index, r);
  multiResults.value = [...merged.values()];
  if (multiResults.value.every((r) => r.ok)) {
    multiOpen.value = false;
    multiReview.value = null;
    multiResults.value = null;
    showToast(t("common.scanSuccess"));
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

async function confirm() {
  if (applying.value || queuedCount.value === 0 || heldByOther.value) return;
  applying.value = true;
  boxPickId.value = null;
  try {
    const failed = await applyAll(
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
        reresolveQueued();
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
  } finally {
    applying.value = false;
  }
}

function goBack() {
  if (queuedCount.value > 0 && !window.confirm(t("picking.scanSession.leaveWarning"))) return;
  router.push(backTarget.value);
}

async function continueScanning() {
  pending.value = true;
  await load();
}

onBeforeRouteLeave(() => {
  if (queuedCount.value > 0 && !applying.value) {
    return window.confirm(t("picking.scanSession.leaveWarning"));
  }
});

function beforeUnload(e: BeforeUnloadEvent) {
  if (queuedCount.value > 0) e.preventDefault();
}

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  load();
});
onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));
</script>

<style scoped>
.scan-session {
  padding: 0;
  max-width: 60rem;
  margin: 0 auto;
}

.scan-session__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.scan-session__title {
  font-size: 1.15rem;
  margin: 0;
}

.scan-session__progress {
  margin-bottom: 1rem;
  padding: 0.75rem 1rem;
}

.scan-session__lock-banner {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 0.375rem;
  color: #92400e;
  font-size: 0.875rem;
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
}

.scan-session__shelf-banner {
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

.scan-session__shelf-banner--empty {
  justify-content: center;
  background: #fef3c7;
  border-color: #f59e0b;
  color: #92400e;
}

.scan-session__shelf-banner-label {
  font-weight: 700;
}

.scan-session__progress-row {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.875rem;
  padding: 0.2rem 0;
}

.scan-session__part {
  font-weight: 600;
}

.scan-session__line {
  font-weight: 400;
  color: var(--muted);
  margin-right: 0.25rem;
}

.scan-session__sources {
  display: block;
  font-weight: 400;
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 0.1rem;
}

.scan-session__counts {
  color: var(--muted);
}

.scan-session__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  background: #fff;
}

.scan-session__table th,
.scan-session__table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid var(--muted-light, #e5e7eb);
}

.scan-session__row--failed td {
  background: #fef2f2;
}

.scan-session__error {
  color: #b91c1c;
  font-size: 0.75rem;
  margin-right: 0.5rem;
}

.scan-session__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 0.75rem 0;
  background: var(--bg, #f3f4f6);
}

.scan-session__done {
  padding: 1.5rem 1rem;
  text-align: center;
}

.scan-session__done-text {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
}

.scan-session__done-hint {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 1rem;
}

.scan-session__done-actions {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
}
</style>
