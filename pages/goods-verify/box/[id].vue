<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="box">
      <DetailHeader
        v-model="headerExpanded"
        :title="$t('goodsVerify.box.boxTitle', { id: box.id })"
        :label="headerStatus"
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
            {{ marking ? $t('goodsVerify.box.marking') : $t('goodsVerify.box.markVerified') }}
          </button>
        </template>

        <DetailRow :label="$t('goodsVerify.box.shelf')" :value="box.shelfCode" />
      </DetailHeader>

      <ScanFab
        v-if="box.status !== 'verified'"
        :loading="scanning"
        :aria-label="$t('actions.scan')"
        @click="openScan()"
      />

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">{{ $t('goodsVerify.box.expectedItems') }}</h2>
      <EmptyState v-if="box.items.length === 0" style="padding: 0;">{{ $t('goodsVerify.box.noItems') }}</EmptyState>

      <div
        v-for="item in box.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.verified }"
      >
        <DetailRow :label="$t('goodsVerify.box.part')" :value="item.part?.partNo" />
        <DetailRow :label="$t('goodsVerify.box.qty')" :value="item.qty" />
        <DetailRow :label="$t('goodsVerify.box.verified')">
          <StatusBadge :status="item.verified ? 'verified' : 'pending'">
            {{ item.verified ? (item.verifiedAt ? new Date(item.verifiedAt).toLocaleString() : $t('common.yes')) : $t('common.no') }}
          </StatusBadge>
        </DetailRow>
        <div v-if="!item.verified && box.status !== 'verified'" style="margin-top: 0.75rem;">
          <button class="btn btn--small" :disabled="scanning" @click="openScan()">{{ $t('actions.scan') }}</button>
        </div>
      </div>
    </template>

    <EmptyState v-else>{{ $t('goodsVerify.box.notFound') }}</EmptyState>

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
      :context="{ task: 'goods-verify', items: box?.items ?? [] }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import { I18nError } from "~/composables/i18nError";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getShelfBoxDetail,
  markShelfBoxVerified,
  type ShelfBoxDetail,
} from "~/db/goodsVerify";
import { badgeClass } from "~/composables/useStatusBadge";
import { useStatusLabel } from "~/composables/useStatusLabel";

const { t } = useI18n();
useHead({ title: t('goodsVerify.box.title') });

definePageMeta({ title: "meta.goodsVerifyBox", props: { noPadding: true } });

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

const route = useRoute();
const boxId = route.params.id as string;

const db = await useDb();
const { currentUser } = useAuth();
const errorMessage = useErrorMessage();
const statusLabel = useStatusLabel();

const headerStatus = computed(() =>
  box.value ? statusLabel.box(box.value.status) : ""
);

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

const allVerified = computed(
  () =>
    !!box.value &&
    box.value.items.length > 0 &&
    box.value.items.every((item) => item.verified)
);

const scanTargets = computed(() => {
  if (!box.value) return [];
  return box.value.items
    .filter((item) => !item.verified)
    .map((item) => item.part?.partNo)
    .filter((partNo): partNo is string => !!partNo);
});

async function load() {
  pending.value = true;
  error.value = null;
  try {
    box.value = await getShelfBoxDetail(db, boxId);
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

useVisibleReload(load);

async function markVerified() {
  if (!box.value) return;
  if (!currentUser.value) {
    error.value = errorMessage(new I18nError("no_operator_user_found"));
    return;
  }

  error.value = null;
  marking.value = true;
  try {
    await markShelfBoxVerified(db, box.value.id, currentUser.value.id);
    await load();
  } catch (e: unknown) {
    error.value = errorMessage(e);
  } finally {
    marking.value = false;
  }
}

async function openScan() {
  if (!box.value) return;
  const result = await scan({
    task: "goods-verify",
    items: box.value.items,
    targets: scanTargets.value,
  });
  if (result.status === "error") {
    error.value = result.message;
  }
  // applied/review/manual are handled by useLabelScanReview.
}
</script>
