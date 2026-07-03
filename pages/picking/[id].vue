<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

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

        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ order.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Delivery date</span>
          <span>{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">PO No.</span>
          <span>{{ order.poNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Ship to</span>
          <span>{{ order.shipTo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Date-code notice</span>
          <span>{{ order.requiredDateCodeNotice || "—" }}</span>
        </div>
      </DetailHeader>

      <div v-if="order.status === 'issue'" class="card card--danger" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">Issue reason</span>
          <span>{{ issueReasonLabel(order.issueReason) }}</span>
        </div>
        <div v-if="order.issueQty != null" class="detail-row">
          <span class="detail-label">Actual qty available</span>
          <span>{{ order.issueQty }}</span>
        </div>
        <div v-if="order.issuePackSize != null" class="detail-row">
          <span class="detail-label">Pack size</span>
          <span>{{ order.issuePackSize }}</span>
        </div>
        <div v-if="order.issueRemark" class="detail-row">
          <span class="detail-label">Remark</span>
          <span>{{ order.issueRemark }}</span>
        </div>
        <div v-if="order.issueNote" class="detail-row">
          <span class="detail-label">Note</span>
          <span>{{ order.issueNote }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Reported</span>
          <span>
            {{ order.issueReportedAt ? new Date(order.issueReportedAt).toLocaleString() : "—" }}
            by {{ order.issueReportedByUser?.displayName || order.issueReportedBy || "—" }}
          </span>
        </div>
      </div>

      <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
        <h2 style="margin: 0;">Boxes({{ order.shippingBoxes?.length ?? 0 }})</h2>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button
            v-if="order.status !== 'finished' && order.status !== 'issue'"
            class="btn btn--small"
            :disabled="creatingBox"
            @click="createBox"
          >
            {{ creatingBox ? "Creating…" : "New box" }}
          </button>
          <button
            class="btn btn--small btn--ghost"
            :aria-expanded="boxesExpanded"
            @click="boxesExpanded = !boxesExpanded"
          >
            {{ boxesExpanded ? "Hide" : "Show" }}
          </button>
        </div>
      </div>

      <div v-if="boxesExpanded" style="margin-bottom: 1.5rem;">
        <p v-if="!order.shippingBoxes?.length" class="empty">No boxes yet.</p>

        <div
          v-for="box in order.shippingBoxes"
          :key="box.id"
          class="card"
          style="margin-bottom: 1rem;"
          :class="{ 'card--done': box.status !== 'open' }"
        >
          <div class="detail-row">
            <span class="detail-label">Box ID</span>
            <span class="card__title">{{ box.id }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge">{{ box.status }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Packages</span>
            <span>{{ box.packages?.length ?? 0 }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Qty</span>
            <span>{{ box.packages?.reduce((sum, p) => sum + p.qty, 0) ?? 0 }}</span>
          </div>
          <div v-if="box.status === 'open' && (box.packages?.length ?? 0) === 0" style="margin-top: 1rem;">
            <button
              class="btn btn--small btn--danger"
              :disabled="cancellingBox[box.id]"
              @click="cancelBox(box.id)"
            >
              {{ cancellingBox[box.id] ? "Canceling…" : "Cancel box" }}
            </button>
          </div>
        </div>
      </div>

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
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
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
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
const boxSelections = ref<Record<string, string>>({});

const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i: any) => i.pickedQty >= i.qty) ?? false
);

const headerBadgeClass = computed(() => {
  if (order.value?.status === "finished") return "badge--finished";
  if (order.value?.status === "issue") return "badge--danger";
  return "";
});

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
  const result = await scan({ task: 'picking', allocation });
  if (result.status === 'applied') {
    await load();
  } else if (result.status === 'review') {
    review.value = result;
    reviewOpen.value = true;
  } else if (result.status === 'manual') {
    review.value = createManualReview();
    scanAllocation.value = allocation;
    reviewOpen.value = true;
  } else if (result.status === 'error') {
    error.value = result.message;
  }
}

async function onApplied() {
  reviewOpen.value = false;
  await load();
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

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});

function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}
</script>

<style scoped>
</style>
