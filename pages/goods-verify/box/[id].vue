<template>
  <div>
    <div style="margin-bottom: 1rem;">
      <NuxtLink :to="`/goods-verify/shelf/${box?.shelfCode ?? ''}`" class="btn btn--small">
        ← Shelf boxes
      </NuxtLink>
    </div>

    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="box">
      <DetailHeader
        v-model="headerExpanded"
        :title="`Box ${box.id}`"
        :status="box.status"
        :badge-class="badgeClass(box.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <button
            v-if="box.status !== 'verified' && allVerified"
            class="btn btn--small"
            :disabled="marking"
            @click="markVerified"
          >
            {{ marking ? "Marking…" : "Mark box verified" }}
          </button>
        </template>

        <div class="detail-row">
          <span class="detail-label">Shelf</span>
          <span>{{ box.shelfCode || "—" }}</span>
        </div>
      </DetailHeader>

      <div
        v-if="box.status !== 'verified'"
        style="position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 60;"
      >
        <button
          class="btn"
          style="border-radius: 9999px; width: 3.5rem; height: 3.5rem; padding: 0; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow);"
          aria-label="Scan item"
          :disabled="scanning"
          @click="openScan"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </button>
      </div>

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Expected items</h2>
      <p v-if="box.items.length === 0" class="empty" style="padding: 0;">No items in this box.</p>

      <div
        v-for="item in box.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.verified }"
      >
        <div class="detail-row">
          <span class="detail-label">Part</span>
          <span class="card__title">{{ item.part?.partNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Qty</span>
          <span>{{ item.qty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Verified</span>
          <span>{{ item.verified ? (item.verifiedAt ? new Date(item.verifiedAt).toLocaleString() : "Yes") : "No" }}</span>
        </div>
        <div v-if="!item.verified && box.status !== 'verified'" style="margin-top: 0.75rem;">
          <button class="btn btn--small" :disabled="scanning" @click="openScan">Scan</button>
        </div>
      </div>
    </template>

    <p v-else class="empty">Box not found.</p>

    <LabelScanReviewModal
      v-if="review?.status === 'review'"
      v-model="reviewOpen"
      :image-path="review.capture.imagePath"
      :text="review.capture.text"
      :barcodes="review.capture.barcodes"
      :parsed="review.parsed"
      :match-result="review.matchResult"
      :mode="review.capture.imagePath ? 'review' : 'manual'"
      :context="{ task: 'goods-verify', items: box?.items ?? [] }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getShelfBoxDetail,
  markShelfBoxVerified,
  type ShelfBoxDetail,
} from "~/db/goodsVerify";

definePageMeta({ title: "Verify Box", props: { noPadding: true } });

const route = useRoute();
const boxId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const box = ref<ShelfBoxDetail | null>(null);
const marking = ref(false);
const headerExpanded = ref(false);
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);

const allVerified = computed(() =>
  box.value ? box.value.items.every((item) => item.verified) : false
);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    box.value = await getShelfBoxDetail(db, boxId);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

function badgeClass(status: string) {
  if (status === "open") return "badge--pending";
  if (status === "closed") return "badge--in-hand";
  if (status === "verified") return "badge--finished";
  return "";
}

async function markVerified() {
  if (!box.value) return;
  if (!currentUser) {
    error.value = "No operator user found";
    return;
  }

  error.value = null;
  marking.value = true;
  try {
    await markShelfBoxVerified(db, box.value.id, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    marking.value = false;
  }
}

async function openScan() {
  if (!box.value) return;
  const result = await scan({ task: 'goods-verify', items: box.value.items });
  if (result.status === 'applied') {
    await onScanApplied();
  } else if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'manual') {
    review.value = createManualReview();
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
  await openScan();
}

async function onScanApplied() {
  await load();
  if (
    box.value &&
    box.value.status !== "verified" &&
    allVerified.value &&
    currentUser
  ) {
    await markVerified();
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

.card--done {
  border-left: 4px solid #22c55e;
}

.badge--pending {
  background: #fef3c7;
  color: #92400e;
}

.badge--in-hand {
  background: #dbeafe;
  color: #1e40af;
}

.badge--finished {
  background: #dcfce7;
  color: #166534;
}
</style>
