<template>
  <div>
    <div style="margin-bottom: 1rem;">
      <NuxtLink :to="`/goods-verify/shelf/${box?.shelfCode ?? ''}`" class="btn btn--small">
        ← Shelf boxes
      </NuxtLink>
    </div>

    <EmptyState v-if="pending">Loading…</EmptyState>
    <EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>

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

        <DetailRow label="Shelf" :value="box.shelfCode" />
      </DetailHeader>

      <ScanFab
        v-if="box.status !== 'verified'"
        :loading="scanning"
        aria-label="Scan item"
        @click="openScan()"
      />

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Expected items</h2>
      <EmptyState v-if="box.items.length === 0" style="padding: 0;">No items in this box.</EmptyState>

      <div
        v-for="item in box.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.verified }"
      >
        <DetailRow label="Part" :value="item.part?.partNo" />
        <DetailRow label="Qty" :value="item.qty" />
        <DetailRow label="Verified">
          <StatusBadge :status="item.verified ? 'verified' : 'pending'">
            {{ item.verified ? (item.verifiedAt ? new Date(item.verifiedAt).toLocaleString() : "Yes") : "No" }}
          </StatusBadge>
        </DetailRow>
        <div v-if="!item.verified && box.status !== 'verified'" style="margin-top: 0.75rem;">
          <button class="btn btn--small" :disabled="scanning" @click="openScan()">Scan</button>
        </div>
      </div>
    </template>

    <EmptyState v-else>Box not found.</EmptyState>

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
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getShelfBoxDetail,
  markShelfBoxVerified,
  type ShelfBoxDetail,
} from "~/db/goodsVerify";

async function onScanApplied() {
  await load();
  if (box.value && box.value.status !== "verified" && allVerified.value) {
    await markVerified();
  }
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan();
}

definePageMeta({ title: "Verify Box", props: { noPadding: true } });

const route = useRoute();
const boxId = route.params.id as string;

const db = await useDb();
const { currentUser } = useAuth();

const pending = ref(true);
const error = ref<string | null>(null);
const box = ref<ShelfBoxDetail | null>(null);
const marking = ref(false);
const headerExpanded = ref(false);
const {
  scan,
  scanning,
  review,
  reviewOpen,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });

import { badgeClass } from "~/composables/useStatusBadge";

const allVerified = computed(
  () =>
    !!box.value &&
    box.value.items.length > 0 &&
    box.value.items.every((item) => item.verified)
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

useVisibleReload(load);

async function markVerified() {
  if (!box.value) return;
  if (!currentUser.value) {
    error.value = "No operator user found";
    return;
  }

  error.value = null;
  marking.value = true;
  try {
    await markShelfBoxVerified(db, box.value.id, currentUser.value.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    marking.value = false;
  }
}

async function openScan() {
  if (!box.value) return;
  const result = await scan({ task: "goods-verify", items: box.value.items });
  if (result.status === "error") {
    error.value = result.message;
  }
  // applied/review/manual are handled by useLabelScanReview.
}
</script>
