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

      <div style="margin-bottom: 1rem;">
        <NuxtLink :to="`/measuring/${taskId}`" class="btn btn--small">{{ $t('common.backToTask') }}</NuxtLink>
      </div>

      <DetailHeader
        v-model="headerExpanded"
        :title="`${t('measuring.detail.box')} ${box.id}`"
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

        <DetailRow :label="$t('measuring.measureBox.pickingOrder')" :value="box.measuringTask?.pickingOrder?.refNo" />
        <DetailRow :label="$t('measuring.measureBox.destination')" :value="box.measuringTask?.pickingOrder?.destinationCountry" />
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
          <DetailRow :label="$t('measuring.measureBox.part')" :value="pkg.pickingItem?.part?.partNo" />
          <DetailRow :label="$t('measuring.measureBox.qty')" :value="pkg.qty" />
          <DetailRow :label="$t('measuring.measureBox.dateLotOrigin')">
            {{ pkg.dateCode || $t('common.noData') }} / {{ pkg.lotCode || $t('common.noData') }} / {{ pkg.coo || $t('common.noData') }} / {{ pkg.cow || $t('common.noData') }}
          </DetailRow>
          <DetailRow :label="$t('measuring.measureBox.status')">
            <StatusBadge :status="pkg.verified ? 'verified' : 'pending'">
              {{ pkg.verified ? $t('common.verified') : $t('common.pending') }}
            </StatusBadge>
          </DetailRow>
          <div v-if="box.status === 'open' && !pkg.verified" style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="openScan(pkg.id)">{{ $t('actions.scan') }}</button>
          </div>
        </div>
      </div>

      <div v-if="box.status === 'closed'" class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted);">{{ $t('measuring.measureBox.measurements') }}</h3>
        <DetailRow :label="$t('measuring.measureBox.boxSize')" :value="box.boxSize" />
        <DetailRow :label="$t('measuring.measureBox.netWeight')" :value="box.netWeight != null ? `${box.netWeight} kg` : `${$t('common.noData')} kg`" />
        <DetailRow :label="$t('measuring.measureBox.grossWeight')" :value="box.grossWeight != null ? `${box.grossWeight} kg` : `${$t('common.noData')} kg`" />
        <DetailRow :label="$t('measuring.measureBox.destinationCountry')" :value="box.destinationCountry" />
      </div>

      <LabelScanReviewModal
        v-if="review?.status === 'review'"
        v-model="reviewOpen"
        :image-path="review.capture.imagePath"
        :text="review.capture.text"
        :barcodes="review.capture.barcodes"
        :parsed="review.parsed"
        :match-result="review.matchResult"
        :mode="review.capture.imagePath ? 'review' : 'manual'"
        :context="{ task: 'measuring', boxId, targetPackageId: scanTargetPackageId }"
        @applied="onApplied"
        @retake="onRetake"
      />

      <BoxMeasurementsModal
        v-model="measureOpen"
        :box-id="boxId"
        :initial-values="measurementInitialValues"
        :default-destination-country="box.measuringTask?.pickingOrder?.destinationCountry"
        @saved="load"
        @finished="load"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  getShippingBoxForMeasuring,
  type ShippingBoxForMeasuring,
} from "~/db/measuring";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";

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

const db = await useDb();
const { t } = useI18n();
const boxStatusLabel = useStatusLabel();
const errorMessage = useErrorMessage();

useHead({ title: t('measuring.measureBox.title') });

const pending = ref(true);
const error = ref<string | null>(null);
const box = ref<ShippingBoxForMeasuring | null>(null);
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
    const data = await getShippingBoxForMeasuring(db, boxId);
    if (!data) {
      error.value = t('measuring.measureBox.boxNotFound');
      box.value = null;
    } else {
      box.value = data;
      error.value = null;
    }
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

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

async function openScan(packageId?: string) {
  if (!box.value) return;
  scanTargetPackageId.value = packageId;
  const result = await scan({
    task: "measuring",
    boxId,
    targetPackageId: packageId,
  });
  if (result.status === "error") {
    error.value = result.message;
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
