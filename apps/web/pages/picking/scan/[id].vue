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
          <div v-for="item in order.items" :key="item.id" class="scan-session__progress-row">
            <span class="scan-session__part">{{ item.partNo }}</span>
            <span class="scan-session__counts">
              {{ $t('picking.scanSession.progress', {
                required: item.qty,
                scanned: serverScannedQty(item),
                queued: queuedQtyByItem[item.id] ?? 0,
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
              <td>{{ row.partNo }}</td>
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
          <button class="btn btn--small" :disabled="applying || ocrCapturing" @click="captureOcr">
            <template v-if="ocrCapturing"><InlineSpinner /> {{ $t('picking.scanSession.ocrCapture') }}</template>
            <template v-else>{{ $t('picking.scanSession.ocrCapture') }}</template>
          </button>
          <button class="btn" :disabled="applying || queuedCount === 0" @click="confirm">
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
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
import EmptyState from "~/components/EmptyState.vue";
import InlineSpinner from "~/components/InlineSpinner.vue";
import PickingScanReviewModal from "~/components/picking/PickingScanReviewModal.vue";
import ScanMultiItemModal from "~/components/ScanMultiItemModal.vue";
import type { OcrInput } from "~/composables/useMockOcr";
import type { PickingOrderDetail } from "~/services/types";

definePageMeta({ title: "meta.pickingScan", props: { noPadding: true } });

const route = useRoute();
const router = useRouter();
const orderId = route.params.id as string;
const warehouse = useWarehouse();
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
const completed = ref(false);

const orderItems = computed(() => order.value?.items ?? []);
const { rows, queuedQtyByItem, addScan, removeRow, reresolveQueued, applyAll } = usePickingScanQueue(orderItems);
const queuedCount = computed(() => rows.value.filter((r) => r.status === "queued").length);

// The table aggregates scans of the same item + batch fields into one row
// with the total qty — the queue itself stays one row per scan so Confirm
// applies each label exactly as scanned.
interface DisplayRow {
  key: string;
  keys: string[];
  partNo: string;
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
    const gk = [row.itemId, row.lotCode ?? "", row.dateCode ?? "", row.coo ?? "", row.cow ?? ""].join("|");
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

async function load() {
  try {
    order.value = await warehouse.getPickingOrder(orderId);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function handleParsed(parsed: ReturnType<typeof ocrResultToInput>, raw: string, source: "qr" | "ocr") {
  const result = addScan(parsed, raw, source);
  if (!result.ok) {
    showToast(t(`picking.scanSession.${result.message}`));
    return;
  }
  showToast(t("common.scanSuccess"));
}

useHardwareScanner({
  enabled: () =>
    !applying.value &&
    !ocrCapturing.value &&
    !completed.value &&
    !reviewOpen.value &&
    !multiOpen.value &&
    !!order.value,
  onScan: async (rawValue: string) => {
    if (!order.value) return;
    const parsedResult = await parseRawValue(rawValue);
    handleParsed(ocrResultToInput(parsedResult.parsed), rawValue, "qr");
  },
});

async function captureOcr() {
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
      const parsedResult = await parseRawValue(qrValue);
      handleParsed(ocrResultToInput(parsedResult.parsed), qrValue, "qr");
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
  } catch (e) {
    showToast(errorMessage(e));
  } finally {
    ocrCapturing.value = false;
  }
}

function onReviewConfirm(parsed: OcrInput) {
  if (!review.value) return;
  handleParsed(parsed, review.value.raw, "ocr");
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
  if (applying.value || queuedCount.value === 0) return;
  applying.value = true;
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
    if (failed === 0) {
      completed.value = true;
    } else {
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
  completed.value = false;
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
  padding: 1rem;
  max-width: 960px;
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
