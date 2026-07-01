<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">Status</span>
          <span class="badge">{{ order.status }}</span>
        </div>
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

        <div v-if="order.status !== 'finished' && allItemsFullyPicked" style="margin-top: 1rem;">
          <button class="btn" @click="finish" :disabled="finishing">
            {{ finishing ? "Finishing…" : "Finish picking" }}
          </button>
        </div>
      </div>

      <h2>Items</h2>
      <div
        v-for="item in order.items"
        :key="item.id"
        class="card"
        :class="{ 'card--done': item.pickedQty >= item.qty }"
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
          <span class="detail-label">Picked qty</span>
          <span>{{ item.pickedQty }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Required date code</span>
          <span>{{ item.requiredDateCode || "—" }}</span>
        </div>

        <div v-if="item.allocations?.length" style="margin-top: 0.75rem;">
          <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Allocations</h3>
          <div
            v-for="allocation in item.allocations"
            :key="allocation.id"
            class="lot"
          >
            <template v-if="allocation.inventoryLot">
              <div class="detail-row">
                <span class="detail-label">Location</span>
                <span>{{ allocation.inventoryLot.shelfCode || allocation.inventoryLot.boxId || "Receiving area" }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date / Lot / Origin</span>
                <span>
                  {{ allocation.inventoryLot.dateCode || "—" }} /
                  {{ allocation.inventoryLot.lotCode || "—" }} /
                  {{ allocation.inventoryLot.originCountry || "—" }}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Allocated qty</span>
                <span>{{ allocation.qty }}</span>
              </div>
              <div v-if="order.status !== 'finished' && item.pickedQty < item.qty" style="margin-top: 0.5rem;">
                <button
                  class="btn btn--small"
                  @click="markPicked(allocation.id, allocation.qty)"
                  :disabled="picking[allocation.id]"
                >
                  {{ picking[allocation.id] ? "Saving…" : "Mark picked" }}
                </button>
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
              <div
                v-if="order.status !== 'finished' && item.pickedQty < item.qty"
                style="margin-top: 0.5rem; display: grid; gap: 0.5rem;"
              >
                <input
                  v-model="receivingForm[allocation.id].dateCode"
                  type="text"
                  placeholder="Date code"
                />
                <input
                  v-model="receivingForm[allocation.id].lotCode"
                  type="text"
                  placeholder="Lot code"
                />
                <input
                  v-model="receivingForm[allocation.id].originCountry"
                  type="text"
                  placeholder="Origin country"
                />
                <input
                  v-model.number="receivingForm[allocation.id].qty"
                  type="number"
                  min="1"
                  :max="allocation.qty"
                  placeholder="Qty"
                />
                <button
                  class="btn btn--small"
                  @click="markPickedFromReceiving(allocation.id)"
                  :disabled="picking[allocation.id]"
                >
                  {{ picking[allocation.id] ? "Saving…" : "Materialize and mark picked" }}
                </button>
              </div>
            </template>
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
  </div>
</template>

<script setup lang="ts">
import {
  getPickingOrderDetail,
  confirmAllocationPicked,
  materializeReceivingAllocation,
  reportPickingItemMismatch,
  finishPickingOrder,
} from "~/db/picking";

definePageMeta({ title: "Picking Detail" });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const notes = ref<Record<string, string>>({});
const picking = ref<Record<string, boolean>>({});
const reporting = ref<Record<string, boolean>>({});
const finishing = ref(false);
const receivingForm = ref<
  Record<string, { dateCode: string; lotCode: string; originCountry: string; qty: number }>
>({});

const allItemsFullyPicked = computed(
  () => order.value?.items?.every((i: any) => i.pickedQty >= i.qty) ?? false
);

async function load() {
  try {
    const data = await getPickingOrderDetail(db, orderId);
    order.value = data;
    if (data) {
      const nextNotes: Record<string, string> = {};
      const nextForm: Record<string, { dateCode: string; lotCode: string; originCountry: string; qty: number }> = {};
      for (const item of data.items) {
        nextNotes[item.id] = notes.value[item.id] ?? "";
        for (const allocation of item.allocations ?? []) {
          if (allocation.receivingInvoiceItem) {
            nextForm[allocation.id] = receivingForm.value[allocation.id] ?? {
              dateCode: "",
              lotCode: "",
              originCountry: "",
              qty: allocation.qty,
            };
          }
        }
      }
      notes.value = nextNotes;
      receivingForm.value = nextForm;
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function markPicked(allocationId: string, qty: number) {
  picking.value[allocationId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await confirmAllocationPicked(db, allocationId, qty, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    picking.value[allocationId] = false;
  }
}

async function markPickedFromReceiving(allocationId: string) {
  const form = receivingForm.value[allocationId];
  if (!form) return;
  picking.value[allocationId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    const materializedAllocationId = await materializeReceivingAllocation(
      db,
      allocationId,
      form.qty,
      form.dateCode || null,
      form.lotCode || null,
      form.originCountry || null
    );
    await confirmAllocationPicked(db, materializedAllocationId, form.qty, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    picking.value[allocationId] = false;
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
