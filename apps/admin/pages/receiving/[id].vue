<script setup lang="ts">
import type { ReceivingOrderDetail, ReceivingItemRow } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();

const order = ref<ReceivingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");

// Per-item inline date-code editing.
const editDateCode = ref<Record<string, string>>({});
const savingItem = ref<Record<string, boolean>>({});
const savedItem = ref<Record<string, boolean>>({});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    order.value = await flow.getReceivingOrder(orderId);
    const map: Record<string, string> = {};
    for (const inv of order.value.invoices) {
      for (const item of inv.items) map[item.id] = item.dateCode ?? "";
    }
    editDateCode.value = map;
    savedItem.value = {};
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function saveDateCode(item: ReceivingItemRow) {
  savingItem.value[item.id] = true;
  error.value = "";
  try {
    const v = (editDateCode.value[item.id] ?? "").trim();
    await flow.updateReceivingItemDateCode(item.id, v || null);
    savedItem.value[item.id] = true;
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingItem.value[item.id] = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>Receiving Order {{ order?.batchNo ?? "" }}</h1>
      <div class="head-actions">
        <button class="btn" disabled title="Format pending — available in a later update">Download delivery order list</button>
        <button class="btn" disabled title="Format pending — available in a later update">Download picking list</button>
        <NuxtLink to="/receiving" class="btn">Back</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">Status</div><div class="dd">{{ order.status }}</div></div>
        <div><div class="dt">Supplier</div><div class="dd">{{ order.supplier?.name ?? "—" }}</div></div>
        <div><div class="dt">Delivery Date</div><div class="dd">{{ order.deliveryDate ? new Date(order.deliveryDate).toLocaleDateString() : "—" }}</div></div>
        <div><div class="dt">Order Date Code</div><div class="dd">{{ order.dateCode ?? "—" }}</div></div>
        <div><div class="dt">Org / Sub-inventory</div><div class="dd">{{ order.orgId }} / {{ order.subInventoryCode }}</div></div>
      </div>

      <template v-for="inv in order.invoices" :key="inv.id">
        <h2 class="section-title">
          Invoice {{ inv.invoiceNo }}
          <span class="muted">— {{ inv.items.length }} items{{ inv.deliveryDate ? `, delivery ${new Date(inv.deliveryDate).toLocaleDateString()}` : "" }}</span>
        </h2>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Part No</th>
                <th>PO / Line</th>
                <th>Expected</th>
                <th>Received</th>
                <th>Put Away</th>
                <th>Allocated</th>
                <th>Ctn No</th>
                <th>Date Code</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in inv.items" :key="item.id">
                <td>{{ item.partNo }}<span v-if="item.wclItemNo" class="muted"> ({{ item.wclItemNo }})</span></td>
                <td>{{ item.poNo ?? "—" }}<span v-if="item.poLine"> / {{ item.poLine }}</span></td>
                <td>{{ item.lineQty }}</td>
                <td>{{ item.receivedQty }}</td>
                <td>{{ item.putAwayQty }}</td>
                <td>{{ item.allocatedQty }}</td>
                <td>{{ item.ctnNo ?? "—" }}</td>
                <td>
                  <input
                    v-model="editDateCode[item.id]"
                    class="dc-input"
                    placeholder="—"
                    @keyup.enter="saveDateCode(item)"
                  />
                </td>
                <td class="actions">
                  <button
                    class="btn btn-small btn-primary"
                    :disabled="savingItem[item.id]"
                    @click="saveDateCode(item)"
                  >
                    {{ savingItem[item.id] ? "Saving…" : "Save" }}
                  </button>
                  <span v-if="savedItem[item.id]" class="muted">Saved</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-if="order.invoices.length === 0" class="muted">No invoices on this order.</p>
    </template>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.dc-input {
  width: 90px;
  padding: 5px 7px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
</style>
