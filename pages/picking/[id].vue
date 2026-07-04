<template>
  <div>
    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="headerStatus"
        :badge-class="headerBadgeClass"
        :flush-top="route.meta.props?.noPadding"
        class="detail-header"
      >
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue'">
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              {{ finishing ? $t('actions.finishing') : $t('picking.detail.finishPicking') }}
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            {{ $t('picking.detail.measuring') }}
          </NuxtLink>
        </template>

        <DetailRow :label="$t('picking.detail.supplier')" :value="order.supplier?.name" />
        <DetailRow :label="$t('picking.detail.deliveryDate')" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
        <DetailRow :label="$t('picking.detail.poNo')" :value="order.poNo" />
        <DetailRow :label="$t('picking.detail.shipTo')" :value="order.shipTo" />
        <DetailRow :label="$t('picking.detail.dateCodeNotice')" :value="order.requiredDateCodeNotice" />
      </DetailHeader>

      <PickingIssueBanner v-if="order.status === 'issue'" :order="order" />

      <PickingBoxesSection
        v-model:expanded="boxesExpanded"
        :boxes="order.shippingBoxes"
        :actionable="actionable"
        :creating-box="creatingBox"
        :cancelling-box="cancellingBox"
        @create-box="createBox"
        @cancel-box="cancelBox"
      />

      <PickingItemsSection
        v-model:expanded-items="expandedItems"
        v-model:box-selections="boxSelections"
        :items="order.items ?? []"
        :actionable="actionable"
        :transition-logs="transitionLogs"
        :adding="adding"
        :removing="removing"
        :scanning="scanning"
        :open-boxes="openBoxes"
        @scan="openScan"
        @add-to-box="addToBox"
        @remove-from-box="removeFromBox"
      />
    </template>

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
      :context="{ task: 'picking', allocation: scanAllocation }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useErrorMessage } from "~/composables/errorMessage";
import { I18nError } from "~/composables/i18nError";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import PickingBoxesSection from "~/components/picking/PickingBoxesSection.vue";
import PickingItemsSection from "~/components/picking/PickingItemsSection.vue";
import PickingIssueBanner from "~/components/picking/PickingIssueBanner.vue";
import {
  getPickingOrderDetail,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  cancelShippingBox,
  finishPickingOrder,
  getPickingItemTransitionLogs,
  type PickingOrderDetail,
  type PickingItemTransitionLog,
} from "~/db/picking";

type PickingItem = PickingOrderDetail["items"][number];
type Allocation = PickingItem["allocations"][number];
type ShippingBox = PickingOrderDetail["shippingBoxes"][number];

definePageMeta({ title: "meta.pickingDetail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;
const db = await useDb();
const { currentUser } = useAuth();
const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();

useHead({ title: t("picking.detail.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<PickingOrderDetail | null>(null);
const adding = ref<Record<string, boolean>>({});
const removing = ref<Record<string, boolean>>({});
const creatingBox = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});
const finishing = ref(false);
const transitionLogs = ref<Record<string, PickingItemTransitionLog[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const scanAllocation = ref<Allocation | null>(null);
const boxSelections = ref<Record<string, string>>({});

const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});
const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i) => i.pickedQty >= i.qty) ?? false
);
const headerBadgeClass = computed(() => badgeClass(order.value?.status));
const headerStatus = computed(() => statusLabel.picking(order.value?.status ?? ""));
const openBoxes = computed(() =>
  (order.value?.shippingBoxes ?? []).filter((b) => b.status === "open")
);
const actionable = computed(
  () => order.value?.status !== "finished" && order.value?.status !== "issue"
);
const scanTargets = computed(() => {
  const partNo = scanAllocation.value?.pickingItem?.part?.partNo;
  return partNo ? [partNo] : [];
});

function currentUserId(): string {
  if (!currentUser.value) throw new I18nError("no_operator_user_found");
  return currentUser.value.id;
}

async function load() {
  try {
    const data = await getPickingOrderDetail(db, orderId);
    order.value = data;
    if (data) {
      const nextBoxSelections: Record<string, string> = {};
      for (const item of data.items) {
        for (const pkg of item.packages ?? []) {
          if (!pkg.shippingBoxId) {
            nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
          }
        }
      }
      boxSelections.value = nextBoxSelections;

      const itemIds = data.items.map((i) => i.id);
      const logs = await getPickingItemTransitionLogs(db, itemIds);
      const nextLogs: Record<string, PickingItemTransitionLog[]> = {};
      for (const log of logs) {
        const list = nextLogs[log.entityId] ?? [];
        list.push(log);
        nextLogs[log.entityId] = list;
      }
      transitionLogs.value = nextLogs;
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function openScan(allocation: Allocation) {
  scanAllocation.value = allocation;
  const result = await scan({
    task: "picking",
    allocation: scanAllocation.value,
    targets: scanTargets.value,
  });
  if (result.status === "error") {
    error.value = result.message;
  }
}

async function onRetake() {
  reviewOpen.value = false;
  if (!scanAllocation.value) return;
  await openScan(scanAllocation.value);
}

async function createBox() {
  creatingBox.value = true;
  boxesExpanded.value = true;
  try {
    await createShippingBoxForPickingOrder(db, orderId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creatingBox.value = false;
  }
}

async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    await cancelShippingBox(db, boxId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  adding.value[packageId] = true;
  try {
    await addPackageToBox(db, packageId, boxId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    adding.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  removing.value[packageId] = true;
  try {
    await removePackageFromBox(db, packageId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    removing.value[packageId] = false;
  }
}

async function finish() {
  finishing.value = true;
  try {
    await finishPickingOrder(db, orderId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
.detail-header {
  margin-bottom: 1.5rem;
}
</style>
