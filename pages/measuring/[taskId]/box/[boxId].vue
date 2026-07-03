<template>
  <div>
    <EmptyState v-if="pending">Loading…</EmptyState>
    <EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>

    <template v-else-if="box">
      <ScanFab
        v-if="box.status === 'open'"
        :loading="scanning"
        aria-label="Scan item"
        @click="openScan()"
      />

      <div style="margin-bottom: 1rem;">
        <NuxtLink :to="`/measuring/${taskId}`" class="btn btn--small">← Back to task</NuxtLink>
      </div>

      <DetailHeader
        v-model="headerExpanded"
        :title="`Box ${box.id}`"
        :status="box.status"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <button
            v-if="box.status === 'open' && allVerified"
            class="btn btn--small"
            @click="measureOpen = true"
          >
            Enter measurements
          </button>
        </template>

        <DetailRow label="Picking order" :value="box.measuringTask?.pickingOrder?.refNo" />
        <DetailRow label="Destination" :value="box.measuringTask?.pickingOrder?.destinationCountry" />
      </DetailHeader>

      <div class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">
          Packages — {{ verifiedCount }} / {{ box.packages.length }} verified
        </h3>
        <p v-if="!box.packages.length" class="empty" style="padding: 0;">No packages in this box.</p>
        <div
          v-for="pkg in box.packages"
          :key="pkg.id"
          class="packed-item"
        >
          <DetailRow label="Part" :value="pkg.pickingItem?.part?.partNo" />
          <DetailRow label="Qty" :value="pkg.qty" />
          <DetailRow label="Date / Lot / Origin">
            {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
          </DetailRow>
          <DetailRow label="Status">
            <StatusBadge :status="pkg.verified ? 'verified' : 'pending'">
              {{ pkg.verified ? "Verified" : "Pending" }}
            </StatusBadge>
          </DetailRow>
          <div v-if="box.status === 'open' && !pkg.verified" style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="openScan(pkg.id)">Scan</button>
          </div>
        </div>
      </div>

      <div v-if="box.status === 'closed'" class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted);">Box measurements</h3>
        <DetailRow label="Box size" :value="box.boxSize" />
        <DetailRow label="Net weight" :value="box.netWeight != null ? `${box.netWeight} kg` : '— kg'" />
        <DetailRow label="Gross weight" :value="box.grossWeight != null ? `${box.grossWeight} kg` : '— kg'" />
        <DetailRow label="Destination country" :value="box.destinationCountry" />
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

definePageMeta({ title: "Measure Box", props: { noPadding: true } });

const route = useRoute();
const taskId = route.params.taskId as string;
const boxId = route.params.boxId as string;

const db = await useDb();

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
  handleResult,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });

useVisibleReload(load);

async function load() {
  try {
    const data = await getShippingBoxForMeasuring(db, boxId);
    if (!data) {
      error.value = "Box not found";
      box.value = null;
    } else {
      box.value = data;
      error.value = null;
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
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
  } else {
    await handleResult(result);
  }
}
</script>

<style scoped>
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.packed-item {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.5rem;
}

.badge--finished {
  background: #dcfce7;
  color: #166534;
}
</style>
