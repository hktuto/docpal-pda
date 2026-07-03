<template>
  <div>
    <EmptyState v-if="pending">Loading…</EmptyState>
    <EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
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
              {{ finishing ? "Finishing…" : "Finish picking" }}
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            Measuring
          </NuxtLink>
        </template>

        <DetailRow label="Supplier" :value="order.supplier?.name" />
        <DetailRow label="Delivery date" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
        <DetailRow label="PO No." :value="order.poNo" />
        <DetailRow label="Ship to" :value="order.shipTo" />
        <DetailRow label="Date-code notice" :value="order.requiredDateCodeNotice" />
      </DetailHeader>

      <div v-if="order.status === 'issue'" class="card card--danger" style="margin-bottom: 1.5rem;">
        <DetailRow label="Issue reason" :value="issueReasonLabel(order.issueReason)" />
        <DetailRow v-if="order.issueQty != null" label="Actual qty available" :value="order.issueQty" />
        <DetailRow v-if="order.issuePackSize != null" label="Pack size" :value="order.issuePackSize" />
        <DetailRow v-if="order.issueRemark" label="Remark" :value="order.issueRemark" />
        <DetailRow v-if="order.issueNote" label="Note" :value="order.issueNote" />
        <DetailRow label="Reported">
          {{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : "—" }}
          by {{ order.issueReportedByUser?.displayName || order.issueReportedBy || "—" }}
        </DetailRow>
      </div>

      <PickingBoxesSection
        v-model:expanded="boxesExpanded"
        :boxes="order.shippingBoxes"
        :actionable="order.status !== 'finished' && order.status !== 'issue'"
        :creating-box="creatingBox"
        :cancelling-box="cancellingBox"
        @create-box="createBox"
        @cancel-box="cancelBox"
      />

      <PickingItemsSection
        v-model:expanded-items="expandedItems"
        v-model:box-selections="boxSelections"
        :items="order.items ?? []"
        :order="order"
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
import { useStatusBadge } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getPickingOrderDetail,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  cancelShippingBox,
  finishPickingOrder,
  getPickingItemTransitionLogs,
} from "~/db/picking";
import { type PickingIssueReason } from "~/db/schema";

definePageMeta({ title: "Picking Detail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const adding = ref<Record<string, boolean>>({});
const removing = ref<Record<string, boolean>>({});
const creatingBox = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});
const finishing = ref(false);
const transitionLogs = ref<Record<string, any[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const scanAllocation = ref<any>(null);
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});
const boxSelections = ref<Record<string, string>>({});

const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i: any) => i.pickedQty >= i.qty) ?? false
);

const { badgeClass } = useStatusBadge();
const headerBadgeClass = computed(() => badgeClass(order.value?.status));

function issueReasonLabel(reason: PickingIssueReason | null) {
  if (reason === "insufficient_stock") return "Insufficient stock";
  if (reason === "cannot_divide") return "Cannot divide quantity";
  if (reason === "merge") return "Merge orders";
  if (reason === "other") return "Other";
  return "—";
}

const openBoxes = computed(() =>
  (order.value?.shippingBoxes ?? []).filter((b: any) => b.status === "open")
);

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

      const itemIds = data.items.map((i: any) => i.id);
      const logs = await getPickingItemTransitionLogs(db, itemIds);
      const nextLogs: Record<string, any[]> = {};
      for (const log of logs) {
        const list = nextLogs[log.entityId] ?? [];
        list.push(log);
        nextLogs[log.entityId] = list;
      }
      transitionLogs.value = nextLogs;
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function openScan(allocation: any) {
  scanAllocation.value = allocation;
  const result = await scan({ task: "picking", allocation });
  if (result.status === "error") {
    error.value = result.message;
  }
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanAllocation.value);
}

async function createBox() {
  creatingBox.value = true;
  boxesExpanded.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await createShippingBoxForPickingOrder(db, orderId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    creatingBox.value = false;
  }
}

async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await cancelShippingBox(db, boxId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function addToBox(packageId: string) {
  const boxId = boxSelections.value[packageId];
  if (!boxId) return;
  adding.value[packageId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await addPackageToBox(db, packageId, boxId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    adding.value[packageId] = false;
  }
}

async function removeFromBox(packageId: string) {
  removing.value[packageId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await removePackageFromBox(db, packageId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    removing.value[packageId] = false;
  }
}

async function finish() {
  finishing.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await finishPickingOrder(db, orderId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    finishing.value = false;
  }
}

useVisibleReload(load);
</script>

<style scoped>
</style>
