<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="box">
      <DetailHeader
        v-model="headerExpanded"
        :title="t('measuring.measureBox.boxTitle', { id: box.id })"
        :status="box.status"
        :label="boxStatusLabel.box(box.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <button
            v-if="box.status === 'open' && allVerified"
            class="btn btn--small"
            @click="measureOpen = true"
          >
            {{ $t('actions.enterMeasurements') }}
          </button>
        </template>

        <DetailRow :label="$t('measuring.measureBox.pickingOrder')" :value="detail?.order.orderNo" />
      </DetailHeader>

      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">
          {{ $t('measuring.measureBox.packagesVerified', { verified: verifiedCount, total: box.packages.length }) }}
        </h3>
        <p v-if="!box.packages.length" class="empty" style="padding: 0;">{{ $t('common.noPackages') }}</p>
        <table v-else class="pkg-table">
          <thead>
            <tr>
              <th>{{ $t('measuring.measureBox.part') }}</th>
              <th>{{ $t('measuring.measureBox.qty') }}</th>
              <th>{{ $t('measuring.measureBox.dateLotOrigin') }}</th>
              <th>{{ $t('measuring.measureBox.status') }}</th>
              <th v-if="canScan"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pkg in box.packages" :key="pkg.id">
              <td>{{ pkg.partNo }}</td>
              <td>{{ pkg.qty }}</td>
              <td>{{ pkg.dateCode || $t('common.noData') }} / {{ pkg.lotCode || $t('common.noData') }} / {{ pkg.coo || $t('common.noData') }} / {{ pkg.cow || $t('common.noData') }}</td>
              <td>
                <span class="badge" :class="badgeClass(isVerified(pkg) ? 'verified' : 'pending')">
                  {{ isVerified(pkg) ? $t('common.verified') : $t('common.pending') }}
                </span>
              </td>
              <td v-if="canScan">
                <button
                  v-if="!isVerified(pkg)"
                  class="btn btn--small"
                  :disabled="scanning"
                  @click="openScan(pkg.id)"
                >{{ $t('actions.scan') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
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
        @finished="load"
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
import { badgeClass } from "~/composables/useStatusBadge";
import { runScanMatcher, useScanMatchers, type ScanTaskContext } from "~/composables/useScanMatchers";
import type { MeasuringTaskDetail, MeasuringPackage } from "~/services/types";

// Shared box (re)measure body used by both the measuring and the verify box
// pages — the two flows have the identical {task, order, boxes} detail
// shape, so the only difference is which task read feeds the page and which
// per-package flag (`verified` vs `verifyVerified`) gates the scan.
const props = defineProps<{
  taskId: string;
  boxId: string;
  loadDetail: (taskId: string) => Promise<MeasuringTaskDetail>;
  mode: 'measuring' | 'verify';
}>();

async function onScanApplied() {
  await load();
  if (allVerified.value && box.value?.status === "open") {
    measureOpen.value = true;
  }
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanTargetPackageId.value);
}

const route = useRoute();

const { t } = useI18n();
const boxStatusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

const pending = ref(true);
const error = ref<string | null>(null);
// The consolidated task detail is the one read; the box is a view onto it
// (no per-box fetch, no server-side package search).
const detail = ref<MeasuringTaskDetail | null>(null);
const scanTargetPackageId = ref<string | undefined>(undefined);
const measureOpen = ref(false);
const headerExpanded = ref(false);

const {
  scan,
  scanning,
  review,
  reviewOpen,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });

const matchers = useScanMatchers();
const { parseRawValue } = useLabelScan();
const verifying = ref(false);

useVisibleReload(load);

async function load() {
  try {
    const data = await props.loadDetail(props.taskId);
    detail.value = data;
    if (!data.boxes.some((b) => b.id === props.boxId)) {
      error.value = t("measuring.measureBox.boxNotFound");
      return;
    }
    error.value = null;
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

const box = computed(() => detail.value?.boxes.find((b) => b.id === props.boxId) ?? null);

// The verify pass re-scans every package against the verify-specific flag.
function isVerified(pkg: MeasuringPackage) {
  return props.mode === 'verify' ? pkg.verifyVerified : pkg.verified;
}

const verifiedCount = computed(() => box.value?.packages.filter(isVerified).length ?? 0);
const allVerified = computed(
  () =>
    !!box.value &&
    box.value.packages.length > 0 &&
    box.value.packages.every(isVerified)
);

// Scanning is allowed on open boxes in both modes; the verify pass also
// scans closed boxes (verifying contents against the sealed box).
const canScan = computed(
  () => !!box.value && (box.value.status === 'open' || props.mode === 'verify')
);

const measurementInitialValues = computed(() => {
  const b = box.value;
  if (!b) return {};
  return {
    boxSize: b.boxSize ?? "",
    netWeight: b.netWeight?.toString() ?? "",
    grossWeight: b.grossWeight?.toString() ?? "",
    destinationCountry: b.destinationCountry ?? "",
  };
});

const scanTargets = computed(() => {
  if (!box.value) return [];
  return box.value.packages
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
  packages: box.value?.packages ?? [],
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
    if (!box.value) return;
    verifying.value = true;
    try {
      const parsedResult = await parseRawValue(rawValue);
      const result = await runScanMatcher(scanContext.value, ocrResultToInput(parsedResult.parsed), matchers);
      if (result.type === "single") {
        await result.apply();
        showToast(t("common.scanSuccess"));
        await onScanApplied();
      } else if (result.type === "none") {
        showToast(t("measuring.measureBox.noMatch"));
      } else if (result.type === "error") {
        showToast(result.message);
      }
    } finally {
      verifying.value = false;
    }
  },
});
</script>

<style scoped>
.pkg-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.pkg-table th,
.pkg-table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.pkg-table tbody tr:last-child td {
  border-bottom: none;
}

.scan-hint {
  margin: 0 0 1.5rem;
  color: var(--muted);
  font-size: 0.8125rem;
}
</style>
