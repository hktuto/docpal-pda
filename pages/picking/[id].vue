<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <DetailHeader
        v-model="headerExpanded"
        :title="order.refNo"
        :status="order.status"
        :flush-top="route.meta.props?.noPadding"
        style="margin-bottom: 1.5rem;"
      >
        <template #actions>
          <template v-if="order.status !== 'finished'">
            <button class="btn btn--small" :disabled="creatingBox" @click="createBox">
              {{ creatingBox ? "Creating…" : "Create box" }}
            </button>
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

      <h2 class="section-title">Boxes</h2>
      <p v-if="!order.shippingBoxes?.length" class="empty" style="margin-bottom: 1.5rem;">No boxes yet.</p>
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
      </div>

      <h2 class="section-title">Items</h2>
      <div
        v-for="item in order.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.pickedQty >= item.qty }"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">Part</span>
          <span class="card__title">{{ item.part?.partNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Required qty</span>
          <span>{{ item.qty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Scanned qty</span>
          <span>{{ scannedQty(item) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Boxed qty</span>
          <span>{{ item.pickedQty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Required date code</span>
          <span>{{ item.requiredDateCode || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge" :class="{ 'badge--finished': item.pickedQty >= item.qty }">
            {{ item.pickedQty >= item.qty ? "Finished" : "Picking" }}
          </span>
        </div>

        <div v-if="item.allocations?.filter((a: any) => a.qty > 0).length && order.status !== 'finished' && item.pickedQty < item.qty" style="margin-top: 0.75rem;">
          <h3 class="subsection-title">Allocations</h3>
          <div
            v-for="allocation in item.allocations.filter((a: any) => a.qty > 0)"
            :key="allocation.id"
            class="lot"
          >
            <template v-if="allocation.inventoryLot">
              <div class="detail-row">
                <span class="detail-label">Location</span>
                <span>{{ allocation.inventoryLot.shelfCode || allocation.inventoryLot.boxId || "Receiving area" }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date / Lot / COO / COW</span>
                <span>
                  {{ allocation.inventoryLot.dateCode || "—" }} /
                  {{ allocation.inventoryLot.lotCode || "—" }} /
                  {{ allocation.inventoryLot.coo || "—" }} /
                  {{ allocation.inventoryLot.cow || "—" }}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Allocated qty</span>
                <span>{{ allocation.qty }}</span>
              </div>
              <div style="margin-top: 0.5rem;">
                <button class="btn btn--small" :disabled="scanning" @click="openScan(allocation, item)">Scan</button>
              </div>
            </template>

            <template v-else-if="allocation.receivingInvoiceItem">
              <div class="detail-row">
                <span class="detail-label">Source</span>
                <span>
                  Receiving area
                  <span v-if="allocation.receivingInvoiceItem.invoice?.receivingOrder?.refNo">
                    ({{ allocation.receivingInvoiceItem.invoice.receivingOrder.refNo }})
                  </span>
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Allocated qty</span>
                <span>{{ allocation.qty }}</span>
              </div>
              <div style="margin-top: 0.5rem;">
                <button class="btn btn--small" :disabled="scanning" @click="openScan(allocation, item)">Scan</button>
              </div>
            </template>
          </div>
        </div>

        <div v-if="unboxedPackages(item).length" style="margin-top: 0.75rem;">
          <h3 class="subsection-title">Unboxed packages</h3>
          <div
            v-for="pkg in unboxedPackages(item)"
            :key="pkg.id"
            class="lot"
            style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
          >
            <span style="font-size: 0.875rem;">
              {{ pkg.qty }} pcs · {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
            </span>
            <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
              <select v-model="boxSelections[pkg.id]" :disabled="adding[pkg.id]" style="min-width: 8rem;">
                <option value="">Select box</option>
                <option v-for="box in openBoxes" :key="box.id" :value="box.id">{{ box.id }}</option>
              </select>
              <button
                class="btn btn--small"
                @click="addToBox(pkg.id)"
                :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
              >
                {{ adding[pkg.id] ? "Adding…" : "Add to box" }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="boxedPackages(item).length" style="margin-top: 0.75rem;">
          <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Boxed packages</h3>
          <div
            v-for="pkg in boxedPackages(item)"
            :key="pkg.id"
            class="lot"
            style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
          >
            <span style="font-size: 0.875rem;">
              {{ pkg.qty }} pcs · {{ pkg.shippingBoxId }}
            </span>
            <button
              v-if="boxById[pkg.shippingBoxId!]?.status === 'open'"
              class="btn btn--small"
              @click="removeFromBox(pkg.id)"
              :disabled="removing[pkg.id]"
            >
              {{ removing[pkg.id] ? "Removing…" : "Remove" }}
            </button>
          </div>
        </div>

        <div style="margin-top: 0.75rem;">
          <button class="btn btn--small" @click="toggleExpand(item.id)">
            {{ expandedItems.has(item.id) ? "Hide picking logs" : "Show picking logs" }}
            ({{ (transitionLogs[item.id] || []).length }})
          </button>

          <div v-if="expandedItems.has(item.id)" style="margin-top: 0.5rem;">
            <p v-if="!(transitionLogs[item.id] || []).length" class="card__meta">No picking logs.</p>
            <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
              <li v-for="log in transitionLogs[item.id]" :key="log.id" style="margin-bottom: 0.35rem;">
                {{ new Date(log.createdAt).toLocaleString() }}
                · {{ log.actorName || "System" }}
                · {{ log.fromState || "—" }} → {{ log.toState }}
                <span v-if="log.metadata">
                  · {{ JSON.parse(log.metadata).qty ?? JSON.parse(log.metadata).note }}
                </span>
              </li>
            </ul>
          </div>
        </div>

        <div v-if="order.status !== 'finished'" style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <input
            v-model="notes[item.id]"
            type="text"
            placeholder="Report mismatch note"
            style="flex: 1; min-width: 8rem;"
          />
          <button class="btn btn--small" @click="saveMismatch(item.id)" :disabled="reporting[item.id]">
            {{ reporting[item.id] ? "Saving…" : "Save mismatch" }}
          </button>
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
      :context="{ task: 'picking', allocation: scanAllocation, item: scanItem }"
      @applied="onApplied"
      @retake="onRetake"
    />
  </div>
</template>

<script setup lang="ts">
import { useLabelScan, type LabelScanResult } from "~/composables/useLabelScan";
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
import {
  getPickingOrderDetail,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  reportPickingItemMismatch,
  finishPickingOrder,
  getPickingItemTransitionLogs,
} from "~/db/picking";

definePageMeta({ title: "Picking Detail", props: { noPadding: true } });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const notes = ref<Record<string, string>>({});
const adding = ref<Record<string, boolean>>({});
const removing = ref<Record<string, boolean>>({});
const reporting = ref<Record<string, boolean>>({});
const creatingBox = ref(false);
const finishing = ref(false);
const transitionLogs = ref<Record<string, any[]>>({});
const expandedItems = ref<Set<string>>(new Set());
const headerExpanded = ref(false);
const scanAllocation = ref<any>(null);
const scanItem = ref<any>(null);
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
const boxSelections = ref<Record<string, string>>({});

const allItemsFullyBoxed = computed(
  () => order.value?.items?.every((i: any) => i.pickedQty >= i.qty) ?? false
);

const openBoxes = computed(() =>
  (order.value?.shippingBoxes ?? []).filter((b: any) => b.status === "open")
);

const boxById = computed(() => {
  const map: Record<string, any> = {};
  for (const box of order.value?.shippingBoxes ?? []) {
    map[box.id] = box;
  }
  return map;
});

function scannedQty(item: any) {
  return (item.packages ?? []).reduce((sum: number, p: any) => sum + p.qty, 0);
}

function unboxedPackages(item: any) {
  return (item.packages ?? []).filter((p: any) => !p.shippingBoxId);
}

function boxedPackages(item: any) {
  return (item.packages ?? []).filter((p: any) => p.shippingBoxId);
}

async function load() {
  try {
    const data = await getPickingOrderDetail(db, orderId);
    order.value = data;
    if (data) {
      const nextNotes: Record<string, string> = {};
      const nextBoxSelections: Record<string, string> = {};
      for (const item of data.items) {
        nextNotes[item.id] = notes.value[item.id] ?? "";
        for (const pkg of item.packages ?? []) {
          if (!pkg.shippingBoxId) {
            nextBoxSelections[pkg.id] = boxSelections.value[pkg.id] ?? "";
          }
        }
      }
      notes.value = nextNotes;
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

function toggleExpand(itemId: string) {
  const next = new Set(expandedItems.value);
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
  }
  expandedItems.value = next;
}

async function openScan(allocation: any, item: any) {
  scanAllocation.value = allocation;
  scanItem.value = item;
  const result = await scan({ task: 'picking', allocation, item });
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
  await openScan(scanAllocation.value, scanItem.value);
}

async function createBox() {
  creatingBox.value = true;
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

async function saveMismatch(itemId: string) {
  reporting.value[itemId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await reportPickingItemMismatch(db, itemId, notes.value[itemId], currentUser.id);
    notes.value[itemId] = "";
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    reporting.value[itemId] = false;
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

onMounted(load);
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
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.5rem;
}

.card--done {
  border-left: 4px solid #16a34a;
}

</style>
