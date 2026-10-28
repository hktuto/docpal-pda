<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="box">
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">
          {{ $t('measuring.measureBox.packagesVerified', { verified: verifiedCount, total: packages.length }) }}
        </h3>
        <p v-if="!packages.length" class="empty" style="padding: 0;">{{ $t('common.noPackages') }}</p>
        <div v-else class="pkg-list">
          <div v-for="pkg in packages" :key="pkg.id" class="pkg-row">
            <div class="pkg-main">
              <div class="pkg-title">
                <span
                  class="pkg-dot"
                  :class="isVerified(pkg) ? 'pkg-dot--verified' : 'pkg-dot--pending'"
                  :title="isVerified(pkg) ? $t('common.verified') : $t('common.pending')"
                ></span>
                <span class="pkg-item-no">{{ pkg.wclItemNo ?? pkg.partNo }}</span>
              </div>
              <div class="pkg-meta">
                <span>
                  {{ pkg.qty }}
                  <span v-if="partialQty(pkg) !== null" class="partial-qty">({{ partialQty(pkg) }})</span>
                </span>
                <span>{{ dateOriginLabel(pkg) }}</span>
              </div>
            </div>
            <button
              v-if="canScan && !isVerified(pkg)"
              class="btn btn--small"
              :disabled="scanning"
              @click="openScan(pkg.id)"
            >{{ $t('actions.scan') }}</button>
          </div>
        </div>
      </div>

      <p v-if="canScan && !allVerified" class="scan-hint">
        {{ $t('measuring.measureBox.scanHint') }}
      </p>

      <div v-if="box.status === 'closed'" class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted);">{{ $t('measuring.measureBox.measurements') }}</h3>
        <DetailRow :label="$t('measuring.measureBox.boxSize')" :value="box.boxSize" />
        <DetailRow :label="$t('measuring.measureBox.netWeight')" :value="box.netWeight != null ? `${box.netWeight} ${$t('common.kg')}` : `${$t('common.noData')} ${$t('common.kg')}`" />
        <DetailRow :label="$t('measuring.measureBox.grossWeight')" :value="box.grossWeight != null ? `${box.grossWeight} ${$t('common.kg')}` : `${$t('common.noData')} ${$t('common.kg')}`" />
        <DetailRow :label="$t('measuring.measureBox.destinationCountry')" :value="box.destinationCountry" />
      </div>

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
        :context="scanContext"
        @applied="onApplied"
        @retake="onRetake"
      />

      <BoxMeasurementsModal
        v-model="measureOpen"
        :box-id="boxId"
        :initial-values="measurementInitialValues"
        :suggested-net-weight-kg="box.suggestedNetWeightKg"
        @finished="onMeasurementsFinished"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import { useToast } from "~/composables/useToast";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { ocrResultToInput, useLabelScan } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";
import { runScanMatcher, useScanMatchers, type ScanTaskContext } from "~/composables/useScanMatchers";
import { useFlowSteps } from "~/composables/useFlowSteps";
import { toLabelDateCode } from "~/utils/dateCode";
import type { PageHeaderAction } from "~/composables/usePageHeader";
import type { MeasuringPackage } from "~/services/types";

/** Normalized box view the pages hand in via `loadDetail` (measuring box
 *  detail and verify task detail both map onto this). */
interface MeasureBoxView {
  id: string;
  /** Informational "created for" order (boxes may span orders). */
  pickingOrderId: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
  suggestedNetWeightKg?: number | null;
  destinationCountry: string | null;
}

interface MeasureBoxDetail {
  box: MeasureBoxView;
  packages: MeasuringPackage[];
}

// Shared box (re)measure body used by both the measuring and the verify box
// pages — both load one box plus its packages, so the only difference is
// which read feeds the page and which per-package flag (`verified` vs
// `verifyVerified`) gates the scan.
const props = defineProps<{
  boxId: string;
  loadDetail: () => Promise<MeasureBoxDetail>;
  mode: 'measuring' | 'verify';
  /** Order numbers of every picking order with packages in the box. */
  orderNos?: string[];
  /** Bump to force a reload from the parent (e.g. after a box reopen). */
  reloadToken?: number;
}>();

// After the measurements modal confirms (update + close): the box is
// closed, the page decides what comes next (measuring → back to the list,
// verify → stay and re-scan).
const emit = defineEmits<{ (e: "finished"): void }>();

// The measurements modal is the measuring step's close flow: it opens in
// measuring mode, or in verify mode for a reopened box — but never when the
// measuring step is disabled (the verify completion closes the box instead).
const canMeasure = computed(() => props.mode === 'measuring' || flowSteps.value.measuring);

async function onScanApplied() {
  await load();
  if (canMeasure.value && allVerified.value && box.value?.status === "open") {
    measureOpen.value = true;
  }
}

async function onMeasurementsFinished() {
  await load();
  emit("finished");
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanTargetPackageId.value);
}

const { t } = useI18n();
const boxStatusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
// The page's loader is the one read (box + packages); no per-package fetch,
// no server-side package search.
const detail = ref<MeasureBoxDetail | null>(null);
const scanTargetPackageId = ref<string | undefined>(undefined);
const measureOpen = ref(false);

const {
  scan,
  scanning,
  review,
  reviewOpen,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });

const matchers = useScanMatchers();
const { parseRawValue } = useLabelScan();
const { dateCodeFormat, flowSteps } = useFlowSteps();
const verifying = ref(false);

// Packages store canonical YYWW — render the date code in the label format
// (spec 2026-10-22); scan matching keeps comparing canonical values.
function labelDateCode(code: string | null): string {
  return toLabelDateCode(code, dateCodeFormat.value) || t('common.noData');
}

// Line-2 batch label: [datecode]-[coo]-[cow], skipping empty coo/cow.
function dateOriginLabel(pkg: MeasuringPackage): string {
  return [labelDateCode(pkg.dateCode), pkg.coo, pkg.cow].filter(Boolean).join("-");
}

useVisibleReload(load);

watch(
  () => props.reloadToken,
  (value, prev) => {
    if (value != null && value !== prev) load();
  }
);

async function load() {
  try {
    detail.value = await props.loadDetail();
    error.value = null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

const box = computed(() => detail.value?.box ?? null);
const packages = computed(() => detail.value?.packages ?? []);

const orderNosText = computed(() =>
  props.orderNos?.length ? props.orderNos.join(", ") : t("common.noData")
);

// Completion is the aggregate re-scan counter (mode-agnostic): a package is
// done when rescannedQty >= qty; a partial credit shows "rescanned/qty".
function isVerified(pkg: MeasuringPackage) {
  return (pkg.rescannedQty ?? 0) >= pkg.qty;
}

function partialQty(pkg: MeasuringPackage): string | null {
  const rescanned = pkg.rescannedQty ?? 0;
  return rescanned > 0 && rescanned < pkg.qty ? `${rescanned}/${pkg.qty}` : null;
}

const verifiedCount = computed(() => packages.value.filter(isVerified).length);
const allVerified = computed(
  () =>
    !!box.value &&
    packages.value.length > 0 &&
    packages.value.every(isVerified)
);

// Scanning is allowed on open boxes in both modes; the verify pass also
// scans closed boxes (verifying contents against the sealed box).
const canScan = computed(
  () => !!box.value && (box.value.status === 'open' || props.mode === 'verify')
);

// Title, status badge, header info row and actions render in the AppHeader.
usePageHeader({
  title: () => (box.value ? t("measuring.measureBox.boxTitle", { id: box.value.id }) : undefined),
  badgeText: () => (box.value ? boxStatusLabel.box(box.value.status) : undefined),
  info: () =>
    box.value
      ? [{ label: t("measuring.measureBox.pickingOrders"), value: orderNosText.value }]
      : [],
  actions: () => {
    const b = box.value;
    if (!b) return [];
    const list: PageHeaderAction[] = [];
    if (b.pickingOrderId) {
      list.push({
        key: "view-picking-order",
        label: t("actions.viewPickingOrder"),
        to: `/picking/${b.pickingOrderId}`,
      });
    }
    if (b.status === "open" && allVerified.value && canMeasure.value) {
      list.push({
        key: "enter-measurements",
        label: t("actions.enterMeasurements"),
        onClick: () => {
          measureOpen.value = true;
        },
      });
    }
    return list;
  },
});

const measurementInitialValues = computed(() => {
  const b = box.value;
  if (!b) return {};
  return {
    boxSize: b.boxSize ?? "",
    netWeight: b.netWeight?.toString() ?? "",
    grossWeight: b.grossWeight?.toString() ?? "",
  };
});

const scanTargets = computed(() => {
  return packages.value
    .filter((pkg) => !isVerified(pkg))
    .map((pkg) => pkg.partNo)
    .filter((partNo): partNo is string => !!partNo);
});

// The measuring matcher (apply = verifyPackage) serves both flows — the
// backend accepts package verification while either the measuring or the
// verify task is pending; `flow` tells it which flag gates re-scans.
const scanContext = computed<ScanTaskContext>(() => ({
  task: "measuring",
  flow: props.mode,
  packages: packages.value,
  dateCodeFormat: dateCodeFormat.value,
}));

async function openScan(packageId?: string) {
  if (!box.value) return;
  scanTargetPackageId.value = packageId;
  const result = await scan({
    ...scanContext.value,
    targetPackageId: packageId,
    targets: scanTargets.value,
    confirmSingleMatch: true,
  });
  if (result.status === "error") {
    showToast(result.message);
  }
  // applied/review/manual are handled by useLabelScanReview.
}

// Hardware/wedge QR scans verify packages straight from the table — the camera
// flow (per-row Scan buttons) stays as the fallback for OCR-only labels.
useHardwareScanner({
  enabled: () =>
    !!box.value &&
    canScan.value &&
    !allVerified.value &&
    !scanning.value &&
    !verifying.value &&
    !reviewOpen.value &&
    !measureOpen.value,
  onScan: async (rawValue: string) => {
    if (!box.value) return false;
    verifying.value = true;
    try {
      const parsedResult = await parseRawValue(rawValue);
      const result = await runScanMatcher(
        { ...scanContext.value, rawLabel: rawValue },
        ocrResultToInput(parsedResult.parsed),
        matchers
      );
      if (result.type === "single") {
        await result.apply();
        showToast(t("common.scanSuccess"));
        await onScanApplied();
        return true;
      }
      if (result.type === "already-verified") {
        showToast(t("measuring.measureBox.alreadyRescanned", { count: result.count }));
        return false;
      }
      if (result.type === "none") {
        showToast(t("measuring.measureBox.noMatch"));
      } else if (result.type === "error") {
        showToast(result.message);
      }
      return false;
    } finally {
      verifying.value = false;
    }
  },
});
</script>

<style scoped>
.pkg-list {
  display: flex;
  flex-direction: column;
}

.pkg-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--border);
}

.pkg-row:last-child {
  border-bottom: none;
}

.pkg-main {
  flex: 1;
  min-width: 0;
}

.pkg-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-weight: 500;
}

.pkg-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
}

.pkg-dot--verified {
  background: var(--success);
}

.pkg-dot--pending {
  background: var(--warning);
}

.pkg-item-no {
  word-break: break-all;
}

.pkg-meta {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.125rem;
  padding-left: 0.875rem;
  color: var(--muted);
  font-size: 0.8125rem;
}

.scan-hint {
  margin: 0 0 1.5rem;
  color: var(--muted);
  font-size: 0.8125rem;
}

.partial-qty {
  color: var(--muted);
  font-size: 0.8125rem;
}
</style>
