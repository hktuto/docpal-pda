<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="task">
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">Picking order</span>
          <span class="card__title">{{ task.pickingOrder?.refNo || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Supplier</span>
          <span>{{ task.pickingOrder?.supplier?.name || "—" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ task.status }}</span>
        </div>
      </div>

      <div v-if="task.status === 'pending'" style="margin-bottom: 1.5rem;">
        <button class="btn" @click="createBox" :disabled="creatingBox">
          {{ creatingBox ? "Creating…" : "Create box" }}
        </button>
      </div>

      <p v-if="!task.shippingBoxes.length" class="empty">No shipping boxes yet.</p>

      <div
        v-for="box in task.shippingBoxes"
        :key="box.id"
        class="card"
        style="margin-bottom: 1.5rem;"
      >
        <div class="detail-row">
          <span class="detail-label">Box</span>
          <span class="card__title">{{ box.id }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ box.status }}</span>
        </div>

        <template v-if="box.status === 'open'">
          <div class="detail-row" style="align-items: flex-start; flex-direction: column; gap: 0.25rem;">
            <span class="detail-label">Gross weight</span>
            <input
              v-model="boxForms[box.id].grossWeight"
              type="number"
              step="0.01"
              placeholder="Gross weight"
              style="width: 100%;"
              :disabled="savingBox[box.id]"
            />
          </div>
          <div class="detail-row" style="align-items: flex-start; flex-direction: column; gap: 0.25rem;">
            <span class="detail-label">Net weight</span>
            <input
              v-model="boxForms[box.id].netWeight"
              type="number"
              step="0.01"
              placeholder="Net weight"
              style="width: 100%;"
              :disabled="savingBox[box.id]"
            />
          </div>
          <div class="detail-row" style="align-items: flex-start; flex-direction: column; gap: 0.25rem;">
            <span class="detail-label">Destination country</span>
            <input
              v-model="boxForms[box.id].destinationCountry"
              type="text"
              placeholder="Destination country"
              style="width: 100%;"
              :disabled="savingBox[box.id]"
            />
          </div>
          <div class="detail-row" style="align-items: flex-start; flex-direction: column; gap: 0.25rem;">
            <span class="detail-label">Box size</span>
            <input
              v-model="boxForms[box.id].boxSize"
              type="text"
              placeholder="Box size"
              style="width: 100%;"
              :disabled="savingBox[box.id]"
            />
          </div>
          <div style="margin-top: 0.75rem;">
            <button class="btn btn--small" @click="saveBox(box.id)" :disabled="savingBox[box.id]">
              {{ savingBox[box.id] ? "Saving…" : "Save box details" }}
            </button>
          </div>
        </template>

        <template v-else>
          <div class="detail-row">
            <span class="detail-label">Gross weight</span>
            <span>{{ box.grossWeight ?? "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Net weight</span>
            <span>{{ box.netWeight ?? "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Destination country</span>
            <span>{{ box.destinationCountry || "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Box size</span>
            <span>{{ box.boxSize || "—" }}</span>
          </div>
        </template>

        <h3 style="margin: 1rem 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Packed items</h3>
        <p v-if="!box.items.length" class="empty" style="padding: 0;">No items packed yet.</p>
        <div
          v-for="item in box.items"
          :key="item.id"
          class="packed-item"
        >
          <div class="detail-row">
            <span class="detail-label">Part</span>
            <span>{{ item.part?.partNo || "—" }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Qty</span>
            <span>{{ item.qty }}</span>
          </div>
        </div>

        <div v-if="box.status === 'open'" style="margin-top: 1rem;">
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem;">
            <select
              v-model="packSelections[box.id].pickingItemId"
              style="flex: 2; min-width: 10rem;"
              :disabled="packing[box.id]"
            >
              <option value="">Select item</option>
              <option
                v-for="item in unpackagedItems"
                :key="item.id"
                :value="item.id"
              >
                {{ item.part?.partNo || "—" }} (remaining: {{ remainingQty(item) }})
              </option>
            </select>
            <input
              v-model.number="packSelections[box.id].qty"
              type="number"
              min="1"
              :max="maxPackQty(box.id)"
              placeholder="Qty"
              style="flex: 1; min-width: 4rem;"
              :disabled="packing[box.id]"
            />
            <button
              class="btn btn--small"
              @click="pack(box.id)"
              :disabled="packing[box.id] || !canPack(box.id)"
            >
              {{ packing[box.id] ? "Packing…" : "Pack" }}
            </button>
          </div>

          <button
            class="btn"
            @click="closeBox(box.id)"
            :disabled="closingBox[box.id] || !box.items.length"
          >
            {{ closingBox[box.id] ? "Closing…" : "Close box" }}
          </button>
        </div>
      </div>

      <div v-if="canComplete" style="margin-top: 1.5rem;">
        <button class="btn" @click="complete" :disabled="completing">
          {{ completing ? "Completing…" : "Complete measuring" }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  getMeasuringTaskDetail,
  createShippingBox,
  addItemToShippingBox,
  updateShippingBox,
  closeShippingBox,
  completeMeasuringTask,
} from "~/db/measuring";
import type { MeasuringTaskDetail } from "~/db/measuring";

definePageMeta({ title: "Measuring Detail" });

const route = useRoute();
const taskId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const task = ref<MeasuringTaskDetail | null>(null);
const creatingBox = ref(false);
const savingBox = ref<Record<string, boolean>>({});
const packing = ref<Record<string, boolean>>({});
const closingBox = ref<Record<string, boolean>>({});
const completing = ref(false);

interface BoxForm {
  grossWeight: string;
  netWeight: string;
  destinationCountry: string;
  boxSize: string;
}

const boxForms = ref<Record<string, BoxForm>>({});

interface PackSelection {
  pickingItemId: string;
  qty: number | null;
}

const packSelections = ref<Record<string, PackSelection>>({});

function packedQtyForPickingItem(pickingItemId: string) {
  return (
    task.value?.shippingBoxes
      .flatMap((box) => box.items)
      .filter((item) => item.pickingItemId === pickingItemId)
      .reduce((sum, item) => sum + item.qty, 0) ?? 0
  );
}

function remainingQty(item: MeasuringTaskDetail["pickingOrder"]["items"][number]) {
  return item.pickedQty - packedQtyForPickingItem(item.id);
}

const unpackagedItems = computed(() => {
  return (
    task.value?.pickingOrder?.items.filter((item) => remainingQty(item) > 0) ?? []
  );
});

function maxPackQty(boxId: string) {
  const item = task.value?.pickingOrder?.items.find(
    (i) => i.id === packSelections.value[boxId]?.pickingItemId
  );
  return item ? remainingQty(item) : undefined;
}

function canPack(boxId: string) {
  const selection = packSelections.value[boxId];
  if (!selection?.pickingItemId) return false;
  const qty = Number(selection.qty) || 0;
  const max = maxPackQty(boxId);
  return qty > 0 && Number.isInteger(qty) && (max === undefined || qty <= max);
}

function ensureBoxForm(box: MeasuringTaskDetail["shippingBoxes"][number]) {
  if (!boxForms.value[box.id]) {
    boxForms.value[box.id] = {
      grossWeight: box.grossWeight?.toString() ?? "",
      netWeight: box.netWeight?.toString() ?? "",
      destinationCountry: box.destinationCountry ?? "",
      boxSize: box.boxSize ?? "",
    };
  }
}

function ensurePackSelection(boxId: string) {
  if (!packSelections.value[boxId]) {
    packSelections.value[boxId] = { pickingItemId: "", qty: null };
  }
}

function mergeBoxForms() {
  for (const box of task.value?.shippingBoxes ?? []) {
    ensureBoxForm(box);
  }
}

function mergePackSelections() {
  for (const box of task.value?.shippingBoxes ?? []) {
    ensurePackSelection(box.id);
  }
}

async function load() {
  try {
    const data = await getMeasuringTaskDetail(db, taskId);
    task.value = data ?? null;
    mergeBoxForms();
    mergePackSelections();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function createBox() {
  creatingBox.value = true;
  try {
    await createShippingBox(db, taskId);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    creatingBox.value = false;
  }
}

async function saveBox(boxId: string) {
  savingBox.value[boxId] = true;
  try {
    const form = boxForms.value[boxId];
    await updateShippingBox(db, boxId, {
      grossWeight: form.grossWeight,
      netWeight: form.netWeight,
      destinationCountry: form.destinationCountry,
      boxSize: form.boxSize,
    });
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    savingBox.value[boxId] = false;
  }
}

async function pack(boxId: string) {
  const selection = packSelections.value[boxId];
  const qty = Number(selection.qty) || 0;
  if (!selection.pickingItemId || qty <= 0 || !Number.isInteger(qty)) {
    error.value = "Select an item and enter a positive integer quantity";
    return;
  }
  packing.value[boxId] = true;
  try {
    await addItemToShippingBox(db, boxId, selection.pickingItemId, qty);
    selection.qty = null;
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    packing.value[boxId] = false;
  }
}

async function closeBox(boxId: string) {
  closingBox.value[boxId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await closeShippingBox(db, boxId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    closingBox.value[boxId] = false;
  }
}

const canComplete = computed(() => {
  if (!task.value || task.value.status !== "pending") return false;
  const items = task.value.pickingOrder?.items ?? [];
  const allPacked = items.every((item) => remainingQty(item) === 0);
  const allBoxesClosed = task.value.shippingBoxes.every((box) => box.status === "closed");
  return allPacked && allBoxesClosed && task.value.shippingBoxes.length > 0;
});

async function complete() {
  completing.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await completeMeasuringTask(db, taskId, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    completing.value = false;
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

.packed-item {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
  margin-bottom: 0.5rem;
}
</style>
