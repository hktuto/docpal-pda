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
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue'">
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              <template v-if="finishing">
                <InlineSpinner /> {{ $t('actions.finishing') }}
              </template>
              <template v-else>
                {{ $t('picking.detail.finishPicking') }}
              </template>
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
        :adding-all="addingAll"
        :any-adding-all="anyAddingAll"
        :unboxed-count="unboxedCountForOrder"
        @create-box="createBox"
        @cancel-box="cancelBox"
        @add-all-to-box="addAllToBox"
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
import { useToast } from "~/composables/useToast";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { badgeClass } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import { useLabelScan, buildRawCapture, ocrResultToInput } from "~/composables/useLabelScan";
import { useHardwareScanner } from "~/composables/useHardwareScanner";
import { normalize } from "~/composables/useMockOcr";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import PickingBoxesSection from "~/components/picking/PickingBoxesSection.vue";
import PickingItemsSection from "~/components/picking/PickingItemsSection.vue";
import PickingIssueBanner from "~/components/picking/PickingIssueBanner.vue";
import type {
  PickingOrderDetail,
  PickingAllocation,
  PickingItemTransitionLog,
} from "~/services/types";

type PickingItem = PickingOrderDetail["items"][number];
type ShippingBox = PickingOrderDetail["shippingBoxes"][number];

definePageMeta({ title: "meta.pickingDetail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;
const warehouse = useWarehouse();
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
const addingAll = ref<Record<string, boolean>>({});
const finishing = ref(false);
const transitionLogs = ref<Record<string, PickingItemTransitionLog[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const scanAllocation = ref<PickingAllocation | null>(null);
const boxSelections = ref<Record<string, string>>({});

const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});
const { processCapture, parseRawValue } = useLabelScan();
const { showToast } = useToast();

function findMatchingAllocation(parsed: { partNo: string | number; qty: string | number }) {
  if (!order.value) return null;
  const scannedPartNo = normalize(String(parsed.partNo ?? ""));
  const scannedQty = typeof parsed.qty === "number" ? parsed.qty : Number(parsed.qty);
  if (!scannedPartNo || !Number.isInteger(scannedQty) || scannedQty <= 0) return null;

  for (const item of order.value.items) {
    const itemPartNo = normalize(item.part?.partNo ?? "");
    if (itemPartNo !== scannedPartNo) continue;
    for (const allocation of item.allocations ?? []) {
      if (allocation.qty > 0 && scannedQty <= allocation.qty) {
        return allocation;
      }
    }
  }
  return null;
}

useHardwareScanner({
  enabled: () => !reviewOpen.value,
  onScan: async (rawValue: string) => {
    if (!order.value) return;
    const parsedResult = await parseRawValue(rawValue, order.value.supplier?.code);
    const parsed = ocrResultToInput(parsedResult.parsed);
    const allocation = findMatchingAllocation(parsed);
    if (!allocation) {
      showToast(t("picking.detail.noMatchingAllocation"));
      return;
    }
    const result = await processCapture(buildRawCapture(rawValue), {
      task: "picking",
      allocation,
      targets: [allocation.pickingItem?.part?.partNo ?? ""],
    });
    if (result.status === "error") {
      showToast(result.message);
    } else if (result.status === "applied") {
      await onApplied();
    }
  },
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
const unboxedCountForOrder = computed(() => {
  return (order.value?.items ?? []).reduce((sum, item) => {
    const unboxed = (item.packages ?? []).filter((p) => !p.shippingBoxId);
    return sum + unboxed.length;
  }, 0);
});
const anyAddingAll = computed(() => Object.values(addingAll.value).some(Boolean));
const scanTargets = computed(() => {
  const partNo = scanAllocation.value?.pickingItem?.part?.partNo;
  return partNo ? [partNo] : [];
});

async function load() {
  try {
    const data = await warehouse.getPickingOrder(orderId);
    order.value = data;
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
    const logs = await warehouse.getPickingItemTransitionLogs(itemIds);
    const nextLogs: Record<string, PickingItemTransitionLog[]> = {};
    for (const log of logs) {
      const list = nextLogs[log.entityId] ?? [];
      list.push(log);
      nextLogs[log.entityId] = list;
    }
    transitionLogs.value = nextLogs;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function openScan(allocation: PickingAllocation) {
  scanAllocation.value = allocation;
  const result = await scan({
    task: "picking",
    allocation: scanAllocation.value,
    targets: scanTargets.value,
  });
  if (result.status === "error") {
    showToast(result.message);
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
    await warehouse.createShippingBoxForPickingOrder(orderId);
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
    await warehouse.cancelShippingBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addAllToBox(boxId: string) {
  if (anyAddingAll.value) return;
  const count = unboxedCountForOrder.value;
  if (count === 0) return;
  const confirmed = window.confirm(t("picking.boxesSection.addAllConfirm", { count }));
  if (!confirmed) return;

  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await warehouse.addAllUnboxedPackagesToBox(boxId);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  adding.value[packageId] = true;
  try {
    await warehouse.addPackageToBox(packageId, boxId);
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
    await warehouse.removePackageFromBox(packageId);
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
    await warehouse.finishPickingOrder(orderId);
    await load();
    if (order.value?.measuringTask) {
      showToast(t("picking.detail.measuringTaskCreated"), {
        action: {
          label: t("picking.detail.goToMeasuring"),
          to: `/measuring/${order.value.measuringTask.id}`,
        },
      });
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
</style>
