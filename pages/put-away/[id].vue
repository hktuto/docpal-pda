<template>
  <div>
    <p v-if="pending" class="empty">Loading…</p>
    <p v-else-if="error" class="empty" style="color: var(--danger);">Error: {{ error }}</p>

    <template v-else-if="order">
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="detail-row">
          <span class="detail-label">RO No.</span>
          <span class="card__title">{{ order.refNo }}</span>
        </div>
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
      </div>

      <div v-if="!box" class="card" style="margin-bottom: 1.5rem;">
        <h2 style="margin-top: 0; margin-bottom: 1rem;">New shelf box</h2>
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <select v-model="selectedShelf" style="flex: 1; min-width: 10rem;" :disabled="creating">
            <option value="">Select a shelf</option>
            <option v-for="shelf in shelves" :key="shelf.code" :value="shelf.code">
              {{ shelf.zone ? `${shelf.code} — ${shelf.zone}` : shelf.code }}
            </option>
          </select>
          <button class="btn" @click="createBox" :disabled="creating || !selectedShelf">
            {{ creating ? "Creating…" : "Create box" }}
          </button>
        </div>
      </div>

      <div v-else class="card" style="margin-bottom: 1.5rem;">
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
          <span class="badge">{{ box.status }}</span>
        </div>

        <h3 style="margin: 1rem 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Items in box</h3>
        <p v-if="!box.items?.length" class="empty" style="padding: 0;">No items in this box yet.</p>
        <div
          v-for="item in box.items"
          :key="item.id"
          class="lot"
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
          <button class="btn" @click="closeBox" :disabled="closing || !box.items?.length">
            {{ closing ? "Closing…" : "Close box" }}
          </button>
        </div>
      </div>

      <h2>Available receiving-area lots</h2>
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
          <span class="detail-label">Date code</span>
          <input
            v-model="dateCodes[lot.receiving_invoice_item_id]"
            placeholder="Date code"
            style="flex: 1; min-width: 6rem;"
            :disabled="puttingAway[lot.receiving_invoice_item_id]"
          />
        </div>
        <div class="detail-row">
          <span class="detail-label">Lot code</span>
          <input
            v-model="lotCodes[lot.receiving_invoice_item_id]"
            placeholder="Lot code"
            style="flex: 1; min-width: 6rem;"
            :disabled="puttingAway[lot.receiving_invoice_item_id]"
          />
        </div>
        <div class="detail-row">
          <span class="detail-label">Origin</span>
          <input
            v-model="originCountries[lot.receiving_invoice_item_id]"
            placeholder="Origin country"
            style="flex: 1; min-width: 6rem;"
            :disabled="puttingAway[lot.receiving_invoice_item_id]"
          />
        </div>
        <div class="detail-row">
          <span class="detail-label">Available qty</span>
          <span>{{ lot.available_qty }}</span>
        </div>
        <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <input
            v-model.number="qtys[lot.receiving_invoice_item_id]"
            type="number"
            min="1"
            :max="lot.available_qty"
            placeholder="Qty"
            style="flex: 1; min-width: 4rem;"
            :disabled="puttingAway[lot.receiving_invoice_item_id]"
          />
          <button
            class="btn btn--small"
            @click="putAway(lot)"
            :disabled="puttingAway[lot.receiving_invoice_item_id] || !box || box.status !== 'open' || !canPutAway(lot)"
          >
            {{ puttingAway[lot.receiving_invoice_item_id] ? "Saving…" : "Put away" }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { and, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { getReceivingOrderDetail } from "~/db/receiving";
import {
  getPutAwayLots,
  createShelfBox,
  addItemToShelfBox,
  closeShelfBox,
} from "~/db/putAway";
import type { PutAwayLot } from "~/db/putAway";

definePageMeta({ title: "Put-away Detail" });

const route = useRoute();
const orderId = route.params.id as string;

const db = await useDb();
const currentUser = await useCurrentUser();

const pending = ref(true);
const error = ref<string | null>(null);
const order = ref<any>(null);
const lots = ref<PutAwayLot[]>([]);
const shelves = ref<typeof schema.shelves.$inferSelect[]>([]);
const selectedShelf = ref("");
const box = ref<any>(null);
const qtys = ref<Record<string, number>>({});
const dateCodes = ref<Record<string, string>>({});
const lotCodes = ref<Record<string, string>>({});
const originCountries = ref<Record<string, string>>({});
const creating = ref(false);
const puttingAway = ref<Record<string, boolean>>({});
const closing = ref(false);

async function load() {
  try {
    const [orderData, lotsData, shelvesData, existingBox] = await Promise.all([
      getReceivingOrderDetail(db, orderId),
      getPutAwayLots(db, orderId),
      db.query.shelves.findMany(),
      db.query.shelfBoxes.findFirst({
        where: and(
          eq(schema.shelfBoxes.receivingOrderId, orderId),
          eq(schema.shelfBoxes.status, "open")
        ),
        with: { items: { with: { part: true } } },
      }),
    ]);
    order.value = orderData;
    lots.value = lotsData;
    shelves.value = shelvesData;
    box.value = existingBox ?? null;
    for (const lot of lotsData) {
      dateCodes.value[lot.receiving_invoice_item_id] = lot.date_code ?? "";
      lotCodes.value[lot.receiving_invoice_item_id] = lot.lot_code ?? "";
      originCountries.value[lot.receiving_invoice_item_id] = lot.origin_country ?? "";
    }
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    pending.value = false;
  }
}

async function loadBox() {
  if (!box.value) return;
  try {
    const refreshed = await db.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, box.value.id),
      with: { items: { with: { part: true } } },
    });
    box.value = refreshed;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  }
}

function canPutAway(lot: PutAwayLot) {
  const qty = Number(qtys.value[lot.receiving_invoice_item_id]) || 0;
  return qty > 0 && Number.isInteger(qty) && qty <= lot.available_qty;
}

async function createBox() {
  if (!selectedShelf.value) return;
  creating.value = true;
  try {
    const created = await createShelfBox(db, orderId, selectedShelf.value);
    box.value = created;
    await loadBox();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    creating.value = false;
  }
}

async function putAway(lot: PutAwayLot) {
  if (!box.value) return;
  const receivingInvoiceItemId = lot.receiving_invoice_item_id;
  const qty = Number(qtys.value[receivingInvoiceItemId]) || 0;
  if (!Number.isInteger(qty) || qty <= 0) {
    error.value = "Qty must be a positive integer";
    return;
  }
  if (qty > lot.available_qty) {
    error.value = "Quantity exceeds available quantity";
    return;
  }
  puttingAway.value[receivingInvoiceItemId] = true;
  try {
    await addItemToShelfBox(
      db,
      box.value.id,
      receivingInvoiceItemId,
      qty,
      dateCodes.value[receivingInvoiceItemId] === "" ? null : dateCodes.value[receivingInvoiceItemId],
      lotCodes.value[receivingInvoiceItemId] === "" ? null : lotCodes.value[receivingInvoiceItemId],
      originCountries.value[receivingInvoiceItemId] === "" ? null : originCountries.value[receivingInvoiceItemId]
    );
    qtys.value[receivingInvoiceItemId] = 0;
    await Promise.all([load(), loadBox()]);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    puttingAway.value[receivingInvoiceItemId] = false;
  }
}

async function closeBox() {
  if (!box.value) return;
  closing.value = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await closeShelfBox(db, box.value.id, currentUser.id);
    await loadBox();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    closing.value = false;
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
</style>
