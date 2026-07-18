<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="box">
      <ScanFab
        v-if="box.status === 'open'"
        :loading="scanning"
        :aria-label="$t('actions.scan')"
        @click="openScan()"
      />


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

        <DetailRow :label="$t('measuring.measureBox.pickingOrder')" :value="detail?.order.refNo" />
        <DetailRow :label="$t('measuring.measureBox.destination')" :value="detail?.order.destinationCountry" />
      </DetailHeader>

      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">
          {{ $t('measuring.measureBox.packagesVerified', { verified: verifiedCount, total: box.packages.length }) }}
        </h3>
        <p v-if="!box.packages.length" class="empty" style="padding: 0;">{{ $t('common.noPackages') }}</p>
        <div
          v-for="pkg in box.packages"
          :key="pkg.id"
          class="packed-item"
        >
          <DetailRow :label="$t('measuring.measureBox.part')" :value="pkg.partNo" />
          <DetailRow :label="$t('measuring.measureBox.qty')" :value="pkg.qty" />
          <DetailRow :label="$t('measuring.measureBox.dateLotOrigin')">
            {{ pkg.dateCode || $t('common.noData') }} / {{ pkg.lotCode || $t('common.noData') }} / {{ pkg.coo || $t('common.noData') }} / {{ pkg.cow || $t('common.noData') }}
          </DetailRow>
          <DetailRow :label="$t('measuring.measureBox.status')">
            <span class="badge" :class="badgeClass(pkg.verified ? 'verified' : 'pending')">
              {{ pkg.verified ? $t('common.verified') : $t('common.pending') }}
            </span>
          </DetailRow>
          <div v-if="box.status === 'open' && !pkg.verified" style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="openScan(pkg.id)">{{ $t('actions.scan') }}</button>
          </div>
        </div>
      </div>

      <div v-if="box.status === 'closed'" class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted);">{{ $t('measuring.measureBox.measurements') }}</h3>
        <DetailRow :label="$t('measuring.measureBox.boxSize')" :value="box.boxSize" />
        <DetailRow :label="$t('measuring.measureBox.netWeight')" :value="box.netWeight != null ? `${box.netWeight} ${$t('common.grams')}` : `${$t('common.noData')} ${$t('common.grams')}`" />
        <DetailRow :label="$t('measuring.measureBox.grossWeight')" :value="box.grossWeight != null ? `${box.grossWeight} ${$t('common.grams')}` : `${$t('common.noData')} ${$t('common.grams')}`" />
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
        :default-destination-country="detail?.order.destinationCountry"
        @saved="load"
        @finished="load"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { useToast } from "~/composables/useToast";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";
import { badgeClass } from "~/composables/useStatusBadge";
import type { ScanTaskContext } from "~/composables/useScanMatchers";
import type { MeasuringTaskDetail } from "~/services/types";

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
const taskId = route.params.taskId as string;
const boxId = route.params.boxId as string;

definePageMeta({ title: "meta.measureBox", props: { noPadding: true } });

const warehouse = useWarehouse();
const { t } = useI18n();
const boxStatusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const { showToast } = useToast();

useHead({ title: t('measuring.measureBox.title') });

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

useVisibleReload(load);

async function load() {
  try {
    const data = await warehouse.getMeasuringTask(taskId);
    detail.value = data;
    if (!data.boxes.some((b) => b.id === boxId)) {
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

const box = computed(() => detail.value?.boxes.find((b) => b.id === boxId) ?? null);

const verifiedCount = computed(() => box.value?.packages.filter((p) => p.verified).length ?? 0);
const allVerified = computed(
  () =>
    !!box.value &&
    box.value.packages.length > 0 &&
    box.value.packages.every((p) => p.verified)
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
    .filter((pkg) => !pkg.verified)
    .map((pkg) => pkg.partNo)
    .filter((partNo): partNo is string => !!partNo);
});

const scanContext = computed<ScanTaskContext>(() => ({
  task: "measuring",
  packages: box.value?.packages ?? [],
  targetPackageId: scanTargetPackageId.value,
}));

async function openScan(packageId?: string) {
  if (!box.value) return;
  scanTargetPackageId.value = packageId;
  const result = await scan({
    ...scanContext.value,
    targets: scanTargets.value,
    confirmSingleMatch: true,
  });
  if (result.status === "error") {
    showToast(result.message);
  }
  // applied/review/manual are handled by useLabelScanReview.
}
</script>

<style scoped>
.packed-item {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.5rem;
}
</style>
