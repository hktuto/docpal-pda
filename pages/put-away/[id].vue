<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
        :badge-class="badgeClass(order.status)"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ order.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Delivery date</span>
          <span>{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</span>
        </div>
      </DetailHeader>

      <div class="card" style="margin-bottom: 1.5rem;">
        <h2 style="margin-top: 0; margin-bottom: 1rem;">Shelf boxes</h2>

        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem;">
          <select v-model="selectedShelf" style="flex: 1; min-width: 10rem;" :disabled="creating">
            <option value="">Select a shelf</option>
            <option v-for="shelf in shelves" :key="shelf.code" :value="shelf.code">
              {{ shelf.zone ? `${shelf.code} — ${shelf.zone}` : shelf.code }}
            </option>
          </select>
          <button class="btn" :disabled="creating || !selectedShelf" @click="createBox">
            {{ creating ? "Creating…" : "Create box" }}
          </button>
        </div>

        <p v-if="boxes.length === 0" class="empty" style="padding: 0;">No boxes yet.</p>

        <div
          v-for="box in boxes"
          :key="box.id"
          class="card"
          style="margin-bottom: 0.75rem;"
          :class="{ 'card--done': box.status !== 'open' }"
        >
          <div class="detail-row">
            <span class="detail-label">Box</span>
            <span class="card__title">{{ box.id }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Shelf</span>
            <span>{{ box.shelfCode || "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status</span>
            <span class="badge" :class="badgeClass(box.status)">{{ box.status }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Items</span>
            <span>{{ box.items?.length || 0 }} lines · {{ boxTotalQty(box) }} pcs</span>
          </div>

          <div v-if="box.items?.length" style="margin-top: 0.5rem;">
            <p style="margin: 0 0 0.25rem; font-size: 0.8125rem; color: var(--muted);">Contents:</p>
            <div
              v-for="item in box.items"
              :key="item.id"
              class="lot"
            >
              <span>{{ item.part?.partNo || "—" }}</span>
              <span style="color: var(--muted);">× {{ item.qty }}</span>
            </div>
          </div>

          <div v-if="box.status === 'open'" style="margin-top: 1rem;">
            <button
              class="btn"
              :disabled="closing || !box.items?.length"
              @click="closeBox(box.id)"
            >
              {{ closing ? "Closing…" : "Close box" }}
            </button>
          </div>
        </div>
      </div>

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Available receiving-area lots</h2>
      <p v-if="lots.length === 0" class="empty">No lots available for put-away.</p>

      <div
        v-for="lot in lots"
        :key="lot.receiving_invoice_item_id"
        class="card"
      >
        <div class="detail-row">
          <span class="detail-label">Part</span>
          <span class="card__title">{{ lot.part_no || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Available qty</span>
          <span>{{ lot.available_qty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Date / Lot</span>
          <span>{{ lot.date_code || "—" }} / {{ lot.lot_code || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">COO / COW</span>
          <span>{{ lot.coo || "—" }} / {{ lot.cow || "—" }}</span>
        </div>

        <div style="margin-top: 0.75rem;">
          <select
            v-model="targetBoxSelections[lot.receiving_invoice_item_id]"
            :disabled="scanning"
            style="min-width: 10rem; margin-right: 0.5rem;"
          >
            <option value="">Select target box</option>
            <option v-for="box in openBoxes" :key="box.id" :value="box.id">
              {{ box.id }} — {{ box.shelfCode || "—" }}
            </option>
          </select>
          <button
            class="btn btn--small"
            :disabled="!hasOpenBox || scanning || !targetBoxSelections[lot.receiving_invoice_item_id]"
            @click="openScan(lot)"
          >
            Scan
          </button>
          <p v-if="!hasOpenBox" style="margin: 0.5rem 0 0; font-size: 0.8125rem; color: var(--muted);">
            Create an open box first.
          </p>
        </div>
      </div>
    </template>

    <LabelScanReviewModal
      v-if="review?.status === 'review'"
      v-model="reviewOpen"
      :image-path="review.capture.imagePath"
      :text="review.capture.text"
      :parsed="review.parsed"
      :match-result="review.matchResult"
      :context="{ task: 'put-away', receivingItem: scanItem, targetBoxId: scanBoxId }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import * as schema from "~/db/schema";
import { getReceivingOrderDetail } from "~/db/receiving";
import {
  getPutAwayLots,
  createShelfBox,
  closeShelfBox,
  getShelfBoxesForReceivingOrder,
} from "~/db/putAway";
import type { PutAwayLot } from "~/db/putAway";

definePageMeta({ title: "Put-away Detail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;

const headerExpanded = ref(false);

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const lots = ref<PutAwayLot[]>([]);
const shelves = ref<typeof schema.shelves.$inferSelect[]>([]);
const boxes = ref<any[]>([]);
const selectedShelf = ref("");
const creating = ref(false);
const closing = ref(false);

const scanItem = ref<any>(null);
const scanBoxId = ref<string>("");
const targetBoxSelections = ref<Record<string, string>>({});
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);

const openBoxes = computed(() => boxes.value.filter((b) => b.status === "open"));
const hasOpenBox = computed(() => openBoxes.value.length > 0);

async function load() {
  pending.value = true;
  error.value = null;
  try {
    const [orderData, lotsData, shelvesData, boxesData] = await Promise.all([
      getReceivingOrderDetail(db, orderId),
      getPutAwayLots(db, orderId),
      db.query.shelves.findMany(),
      getShelfBoxesForReceivingOrder(db, orderId),
    ]);
    order.value = orderData;
    lots.value = lotsData;
    shelves.value = shelvesData;
    boxes.value = boxesData;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

function boxTotalQty(box: any) {
  return (box.items || []).reduce((sum: number, item: any) => sum + (item.qty || 0), 0);
}

function badgeClass(status: string) {
  if (status === "open" || status === "pending") return "badge--pending";
  if (["closed", "verified", "finished", "completed", "in_hand", "clear"].includes(status)) return "badge--finished";
  return "";
}

async function createBox() {
  if (!selectedShelf.value) return;
  if (!currentUser?.id) {
    error.value = "Operator not signed in";
    return;
  }
  creating.value = true;
  try {
    await createShelfBox(db, orderId, selectedShelf.value, currentUser.id);
    selectedShelf.value = "";
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
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
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    closing.value = false;
  }
}

async function openScan(lot: PutAwayLot) {
  scanItem.value = lot;
  scanBoxId.value = targetBoxSelections.value[lot.receiving_invoice_item_id] ?? "";
  if (!scanBoxId.value) {
    error.value = "Select a target box";
    return;
  }
  const result = await scan({ task: 'put-away', receivingItem: lot, targetBoxId: scanBoxId.value });
  if (result.status === 'applied') {
    await load();
  } else if (result.status === 'review') {
    review.value = result;
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
  await openScan(scanItem.value);
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

.lot {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.35rem 0;
  font-size: 0.875rem;
  border-bottom: 1px solid var(--border);
}

.lot:last-child {
  border-bottom: none;
}

.badge--pending {
  background: #fef3c7;
  color: #92400e;
}

.badge--finished {
  background: #dcfce7;
  color: #166534;
}

.card--done {
  border-left: 4px solid #22c55e;
}
</style>
