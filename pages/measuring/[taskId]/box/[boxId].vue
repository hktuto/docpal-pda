<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="box">
      <div v-if="box.status === 'open'" style="position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 60;">
        <button
          class="btn"
          style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow);"
          aria-label="Scan item"
          :disabled="scanning"
          @click="openScan()"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </button>
      </div>

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

        <div class="detail-row">
          <span class="detail-label">Picking order</span>
          <span>{{ box.measuringTask?.pickingOrder?.refNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Destination</span>
          <span>{{ box.measuringTask?.pickingOrder?.destinationCountry || "—" }}</span>
        </div>
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
          <div class="detail-row">
            <span class="detail-label">Part</span>
            <span>{{ pkg.pickingItem?.part?.partNo || "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Qty</span>
            <span>{{ pkg.qty }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Date / Lot / Origin</span>
            <span>
              {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge" :class="{ 'badge--finished': pkg.verified }">
              {{ pkg.verified ? "Verified" : "Pending" }}
            </span>
          </div>
          <div v-if="box.status === 'open' && !pkg.verified" style="margin-top: 0.5rem;">
            <button class="btn btn--small" :disabled="scanning" @click="openScan(pkg.id)">Scan</button>
          </div>
        </div>
      </div>

      <div v-if="box.status === 'closed'" class="card" style="margin-bottom: 1.5rem;">
        <h3 style="margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted);">Box measurements</h3>
        <div class="detail-row">
          <span class="detail-label">Box size</span>
          <span>{{ box.boxSize || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Net weight</span>
          <span>{{ box.netWeight ?? "—" }} kg</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Gross weight</span>
          <span>{{ box.grossWeight ?? "—" }} kg</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Destination country</span>
          <span>{{ box.destinationCountry || "—" }}</span>
        </div>
      </div>

      <LabelScanReviewModal
        v-if="review?.status === 'review'"
        v-model="reviewOpen"
        :image-path="review.capture.imagePath"
        :text="review.capture.text"
        :parsed="review.parsed"
        :match-result="review.matchResult"
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
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";

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
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);

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
  scanTargetPackageId.value = packageId;
  const result = await scan({ task: 'measuring', boxId, targetPackageId: packageId });
  if (result.status === 'applied') {
    await onScanApplied();
  } else if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'error') {
    error.value = result.message;
  }
}

async function onApplied() {
  reviewOpen.value = false;
  await onScanApplied();
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanTargetPackageId.value);
}

async function onScanApplied() {
  await load();
  if (allVerified.value && box.value?.status === "open") {
    measureOpen.value = true;
  }
}

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});
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

.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
}

.badge--finished {
  background: #dcfce7;
  color: #166534;
}
</style>
