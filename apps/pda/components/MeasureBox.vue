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

        <template v-else>
          <!-- Labels to verify (spec 2026-10-30): packages of labeled orders
               need their printed label scanned on top of the qty re-scan. -->
          <template v-if="labelPackages.length || (box.cartonLabelRequired && !box.cartonLabelVerified)">
            <h4 class="section-title">{{ $t('measuring.measureBox.labelsToVerify') }}</h4>
            <div class="pkg-list" style="margin-bottom: 1rem;">
              <div v-if="box.cartonLabelRequired && !box.cartonLabelVerified" class="pkg-row">
                <div class="pkg-main">
                  <div class="pkg-title">
                    <span class="pkg-dot pkg-dot--pending" :title="$t('common.pending')"></span>
                    <span class="pkg-item-no">{{ $t('measuring.measureBox.cartonLabel') }}</span>
                  </div>
                  <div class="pkg-meta">
                    <span>{{ $t('measuring.measureBox.scanCartonLabel') }}</span>
                  </div>
                </div>
                <button
                  v-if="canScan"
                  class="btn btn--small"
                  :disabled="scanning"
                  @click="openScan()"
                >{{ $t('actions.scan') }}</button>
              </div>
              <div v-for="pkg in labelPackages" :key="pkg.id" class="pkg-row">
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
                  <div class="pkg-meta">
                    <span v-if="pkg.labelVerified" class="label-state label-state--ok">
                      {{ $t('measuring.measureBox.labelScanned', { rescanned: pkg.rescannedQty ?? 0, qty: pkg.qty }) }}
                    </span>
                    <span v-else class="label-state">
                      {{ $t('measuring.measureBox.scanLabel') }}
                    </span>
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
          </template>

          <!-- Items to re-scan: aggregate-mode packages grouped per item +
               batch combo with summed totals (spec 2026-10-30). -->
          <template v-if="aggregateGroups.length">
            <h4 v-if="labelPackages.length" class="section-title">{{ $t('measuring.measureBox.itemsToRescan') }}</h4>
            <div class="pkg-list">
              <div v-for="group in aggregateGroups" :key="group.key" class="pkg-row">
                <div class="pkg-main">
                  <div class="pkg-title">
                    <span
                      class="pkg-dot"
                      :class="groupFullyRescanned(group) ? 'pkg-dot--verified' : 'pkg-dot--pending'"
                      :title="groupFullyRescanned(group) ? $t('common.verified') : $t('common.pending')"
                    ></span>
                    <span class="pkg-item-no">{{ group.wclItemNo ?? group.partNo }}</span>
                  </div>
                  <div class="pkg-meta">
                    <span>{{ group.rescannedQty }}/{{ group.totalQty }}</span>
                    <span>{{ groupBatchLabel(group) }}</span>
                  </div>
                </div>
                <button
                  v-if="canScan && !groupFullyRescanned(group)"
                  class="btn btn--small"
                  :disabled="scanning"
                  @click="openScan()"
                >{{ $t('actions.scan') }}</button>
              </div>
            </div>
          </template>
        </template>
      </div>

      <p v-if="canScan && !allVerified" class="scan-hint">
        {{ labelScanActive ? $t('measuring.measureBox.scanHintLabels') : $t('measuring.measureBox.scanHint') }}
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
import { useWarehouse } from "~/composables/useWarehouse";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { ocrResultToInput, useLabelScan } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";
import { runScanMatcher, useScanMatchers, type ScanTaskContext } from "~/composables/useScanMatchers";
import { useFlowSteps } from "~/composables/useFlowSteps";
import { toLabelDateCode } from "~/utils/dateCode";
import {
  dispatchVerifyScan,
  groupAggregatePackages,
  groupFullyRescanned,
  hasLabelWork,
  isLabelModePackage,
  type VerifyAggregateGroup,
} from "~/utils/verifyDisplayGroups";
import type { PageHeaderAction } from "~/composables/usePageHeader";
import type { MeasuringPackage, ScanVerifyTaskLabelResult, VerifyLabelLookup } from "~/services/types";

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
  /** Carton label gate (spec 2026-10-30). */
  cartonLabelRequired?: boolean;
  cartonLabelVerified?: boolean;
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
  /** Pending verify task id (verify mode only) — needed by the scan-label
   *  endpoint (spec 2026-10-30). */
  verifyTaskId?: string | null;
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
const warehouse = useWarehouse();

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

// Label-mode vs aggregate display split (spec 2026-10-30): label-mode
// packages render per package in "labels to verify"; the rest group per
// item + batch combo in "items to re-scan".
const labelPackages = computed(() => packages.value.filter(isLabelModePackage));
const aggregateGroups = computed(() => groupAggregatePackages(packages.value));

function groupBatchLabel(group: VerifyAggregateGroup): string {
  return [labelDateCode(group.dateCode), group.coo, group.cow].filter(Boolean).join("-");
}

// Label-scan dispatch runs before the aggregate matcher whenever the box has
// label work: label-mode packages, or an unverified required carton label.
const labelScanActive = computed(() => hasLabelWork(packages.value, box.value));

/**
 * Try the raw scan as a printed label (spec 2026-10-30). Verify mode goes to
 * the task's scan-label endpoint (carton + item/item_box labels); measuring
 * mode has no verify task yet, so only the carton-label lookup applies (it
 * also matches open measuring boxes and stamps carton_label_verified).
 * Returns the hit (and shows the toast) or null to fall through to the
 * aggregate matcher.
 */
async function scanLabelForBox(raw: string): Promise<ScanVerifyTaskLabelResult | VerifyLabelLookup | null> {
  if (props.mode === 'verify') {
    if (!props.verifyTaskId) return null;
    const hit = await warehouse.scanVerifyTaskLabel(props.verifyTaskId, raw);
    if (!hit) return null;
    if (hit.kind === 'carton') {
      showToast(t('verify.cartonLabelVerified'));
    } else {
      const part = hit.expectations?.wclItemNo ?? hit.expectations?.partNo ?? '';
      showToast(t('verify.labelScanned', { part }));
    }
    return hit;
  }
  const hit = await warehouse.lookupVerifyTaskByLabel(raw);
  if (!hit || hit.shippingBoxId !== props.boxId) return null;
  showToast(t('verify.cartonLabelVerified'));
  return hit;
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
  // Printed-label dispatch before the aggregate matcher (spec 2026-10-30);
  // a handled label scan reports as 'applied' and the reload runs via
  // onScanApplied.
  tryLabel: async (raw: string) => {
    if (!labelScanActive.value) return false;
    return (await scanLabelForBox(raw)) !== null;
  },
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
      const dispatch = await dispatchVerifyScan(rawValue, {
        labelModeActive: labelScanActive.value,
        scanLabel: scanLabelForBox,
        aggregate: async (raw) => {
          const parsedResult = await parseRawValue(raw);
          return runScanMatcher(
            { ...scanContext.value, rawLabel: raw },
            ocrResultToInput(parsedResult.parsed),
            matchers
          );
        },
      });
      if (dispatch.kind === "label") {
        await load();
        return true;
      }
      const result = dispatch.result;
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
    } catch (e: unknown) {
      showToast(errorMessage(e));
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

.section-title {
  margin: 0 0 0.375rem;
  font-size: 0.8125rem;
  color: var(--muted);
}

.label-state--ok {
  color: var(--success);
}
</style>
