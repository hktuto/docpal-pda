<template>
  <div>
    <EmptyState v-if="pending">Loading…</EmptyState>
    <EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        class="detail-header"
      >
        <DetailRow label="Supplier" :value="order.supplier?.name" />
        <DetailRow label="Delivery date" :value="order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : null" />
      </DetailHeader>

      <ShelfBoxesPanel
        v-model:boxes-expanded="boxesExpanded"
        v-model:expanded-item-boxes="expandedItemBoxes"
        :boxes="boxes"
        :shelves="shelves"
        :actionable="order.status !== 'clear'"
        :creating="creating"
        :closing="closing"
        :cancelling-box="cancellingBox"
        @new-box="openNewBoxDialog"
        @close-box="closeBox"
        @cancel-box="cancelBox"
      />

      <SelectShelfDialog
        v-model="newBoxDialogOpen"
        :shelves="shelves"
        @selected="createBoxFromDialog"
      />

      <PutAwayLotsPanel
        v-model:target-box-selections="targetBoxSelections"
        :lots="lots"
        :boxes="boxes"
        :scanning="scanning"
        @scan="openScan"
      />
    </template>

    <LabelScanReviewModal
      v-if="review && (review.status === 'review' || review.status === 'manual')"
      v-model="reviewOpen"
      :image-path="review.capture.imagePath"
      :text="review.capture.text"
      :barcodes="review.capture.barcodes"
      :parsed="review.parsed"
      :match-result="review.matchResult"
      :mode="review.capture.imagePath ? 'review' : 'manual'"
      :context="{ task: 'put-away', receivingItem: scanLot ?? undefined, targetBoxId: scanBoxId }"
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
import SelectShelfDialog from "~/components/SelectShelfDialog.vue";
import ShelfBoxesPanel from "~/components/put-away/ShelfBoxesPanel.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import * as schema from "~/db/schema";
import {
  getPutAwayLots,
  createShelfBox,
  closeShelfBox,
  cancelShelfBox,
  getShelfBoxesForReceivingOrder,
  type ShelfBox,
} from "~/db/putAway";
import type { PutAwayLot } from "~/db/putAway";
import { getReceivingOrderDetail } from "~/db/receiving";

type ReceivingOrderDetail = NonNullable<Awaited<ReturnType<typeof getReceivingOrderDetail>>>;

definePageMeta({ title: "Put-away Detail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;

const headerExpanded = ref(false);
const boxesExpanded = ref(false);
const newBoxDialogOpen = ref(false);
const expandedItemBoxes = ref<Set<string>>(new Set());

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<ReceivingOrderDetail | null>(null);
const lots = ref<PutAwayLot[]>([]);
const shelves = ref<typeof schema.shelves.$inferSelect[]>([]);
const boxes = ref<ShelfBox[]>([]);
const creating = ref(false);
const closing = ref(false);
const cancellingBox = ref<Record<string, boolean>>({});
const lastOrderId = ref<string>(orderId);

const scanLot = ref<PutAwayLot | null>(null);
const scanBoxId = ref<string>("");
const targetBoxSelections = ref<Record<string, string>>({});
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({ onApplied: load });
const { badgeClass } = useStatusBadge();

useVisibleReload(load);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function load() {
  pending.value = true;
  error.value = null;
  try {
    if (lastOrderId.value !== orderId) {
      lastOrderId.value = orderId;
      targetBoxSelections.value = {};
      expandedItemBoxes.value = new Set();
    }

    const [orderData, lotsData, shelvesData, boxesData] = await Promise.all([
      getReceivingOrderDetail(db, orderId),
      getPutAwayLots(db, orderId),
      db.query.shelves.findMany(),
      getShelfBoxesForReceivingOrder(db, orderId),
    ]);
    if (!orderData) {
      error.value = "Receiving order not found";
      return;
    }
    order.value = orderData;
    lots.value = lotsData;
    shelves.value = shelvesData;

    const previousBoxIds = new Set(boxes.value.map((b) => b.id));
    boxes.value = boxesData;

    const openBoxIds = new Set(boxesData.filter((b) => b.status === "open").map((b) => b.id));
    if (!reviewOpen.value) {
      scanBoxId.value = "";
      targetBoxSelections.value = Object.fromEntries(
        Object.entries(targetBoxSelections.value).filter(([, boxId]) => openBoxIds.has(boxId))
      );
    }

    const nextExpanded = new Set(expandedItemBoxes.value);
    for (const b of boxesData) {
      if (b.status === "open" && !previousBoxIds.has(b.id)) {
        nextExpanded.add(b.id);
      }
    }
    expandedItemBoxes.value = nextExpanded;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

function openNewBoxDialog() {
  newBoxDialogOpen.value = true;
  boxesExpanded.value = true;
}

async function createBoxFromDialog(shelfCode: string) {
  if (!currentUser?.id) {
    error.value = "Operator not signed in";
    return;
  }
  creating.value = true;
  try {
    await createShelfBox(db, orderId, shelfCode, currentUser.id);
    await load();
    boxesExpanded.value = true;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    creating.value = false;
  }
}

async function closeBox(boxId: string) {
  if (!currentUser?.id) {
    error.value = "Operator not signed in";
    return;
  }
  closing.value = true;
  try {
    await closeShelfBox(db, boxId, currentUser.id);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    closing.value = false;
  }
}

async function cancelBox(boxId: string) {
  if (!currentUser?.id) {
    error.value = "Operator not signed in";
    return;
  }
  cancellingBox.value[boxId] = true;
  try {
    await cancelShelfBox(db, boxId, currentUser.id);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}

async function openScan(lot: PutAwayLot) {
  error.value = null;
  scanLot.value = lot;
  scanBoxId.value = targetBoxSelections.value[lot.receiving_invoice_item_id] ?? "";
  if (!scanBoxId.value) {
    error.value = "Select a target box";
    return;
  }
  if (!boxes.value.some((b) => b.id === scanBoxId.value && b.status === "open")) {
    error.value = "Selected box is no longer open";
    return;
  }
  const result = await scan({ task: 'put-away', receivingItem: lot, targetBoxId: scanBoxId.value });
  if (result.status === 'error') {
    error.value = result.message;
  }
}

async function onRetake() {
  reviewOpen.value = false;
  const lot = scanLot.value;
  if (!lot) {
    error.value = "No scan item to retake";
    return;
  }
  await openScan(lot);
}
</script>

<style scoped>
.detail-header {
  margin-bottom: 1.5rem;
}
</style>
