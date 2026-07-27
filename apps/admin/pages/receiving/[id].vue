<script setup lang="ts">
import type { ReceivingOrderDetail, ReceivingItemRow } from "~/utils/flowApi";

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();

const order = ref<ReceivingOrderDetail | null>(null);
const loading = ref(true);
const error = ref("");

// Order-level delivery-date editing (mirrors the picking-orders detail page).
const deliveryDate = ref("");
const savingDate = ref(false);
const dateMsg = ref("");

// Per-item inline date-code editing.
const editDateCode = ref<Record<string, string>>({});
const savingItem = ref<Record<string, boolean>>({});
const savedItem = ref<Record<string, boolean>>({});

// Client-side invoice filter: an invoice matches when its invoiceNo contains
// the keyword (all items shown) or any item's partNo/wclItemNo/poNo does.
const invoiceFilter = ref("");

const filteredInvoices = computed(() => {
  const inv = order.value?.invoices ?? [];
  const needle = invoiceFilter.value.trim().toLowerCase();
  if (!needle) return inv;
  // Invoice-no match shows the whole invoice; otherwise only matching items.
  const out: typeof inv = [];
  for (const i of inv) {
    if (i.invoiceNo.toLowerCase().includes(needle)) {
      out.push(i);
      continue;
    }
    const items = i.items.filter(
      (it) =>
        it.partNo.toLowerCase().includes(needle) ||
        (it.wclItemNo ?? "").toLowerCase().includes(needle) ||
        (it.poNo ?? "").toLowerCase().includes(needle)
    );
    if (items.length > 0) out.push({ ...i, items });
  }
  return out;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    order.value = await flow.getReceivingOrder(orderId);
    deliveryDate.value = order.value.deliveryDate ? order.value.deliveryDate.slice(0, 10) : "";
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

async function saveDeliveryDate() {
  savingDate.value = true;
  dateMsg.value = "";
  error.value = "";
  try {
    await flow.updateReceivingDeliveryDate(orderId, deliveryDate.value || null);
    await load();
    dateMsg.value = "saved";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingDate.value = false;
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
      <h1>{{ $t("admin.pages.receiving.detailTitle", { batchNo: order?.batchNo ?? "" }) }}</h1>
      <div class="head-actions">
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.receiving.downloadDeliveryOrderList") }}
        </button>
        <button class="btn" disabled :title="$t('admin.common.downloadPendingTitle')">
          {{ $t("admin.pages.receiving.downloadPickingList") }}
        </button>
        <NuxtLink to="/receiving" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <template v-else-if="order">
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.receiving.status") }}</div><div class="dd">{{ order.status }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.receiving.supplier") }}</div><div class="dd">{{ order.supplier?.name ?? "—" }}</div></div>
        <div>
          <div class="dt">{{ $t("admin.pages.receiving.deliveryDate") }}</div>
          <div class="dd date-edit">
            <input v-model="deliveryDate" type="date" />
            <button class="btn btn-small btn-primary" :disabled="savingDate" @click="saveDeliveryDate">
              {{ savingDate ? $t("admin.common.saving") : $t("admin.common.save") }}
            </button>
            <span v-if="dateMsg" class="muted">{{ $t("admin.pages.receiving.saved") }}</span>
          </div>
        </div>
        <div><div class="dt">{{ $t("admin.pages.receiving.orderDateCode") }}</div><div class="dd">{{ order.dateCode ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.receiving.orgSubInventory") }}</div><div class="dd">{{ order.orgId }} / {{ order.subInventoryCode }}</div></div>
      </div>

      <div class="search-bar">
        <input
          v-model="invoiceFilter"
          type="search"
          class="search-input"
          :placeholder="$t('admin.pages.receiving.invoiceFilterPlaceholder')"
        />
      </div>

      <template v-for="inv in filteredInvoices" :key="inv.id">
        <h2 class="section-title">
          {{ $t("admin.pages.receiving.invoiceTitle", { invoiceNo: inv.invoiceNo }) }}
          <span class="muted">
            — {{ $t("admin.pages.receiving.itemsCount", { count: inv.items.length })
            }}{{ inv.deliveryDate ? $t("admin.pages.receiving.deliverySuffix", { date: new Date(inv.deliveryDate).toLocaleDateString() }) : "" }}
          </span>
        </h2>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>{{ $t("admin.pages.receiving.partNo") }}</th>
                <th>{{ $t("admin.pages.receiving.poLine") }}</th>
                <th>{{ $t("admin.pages.receiving.expected") }}</th>
                <th>{{ $t("admin.pages.receiving.received") }}</th>
                <th>{{ $t("admin.pages.receiving.putAway") }}</th>
                <th>{{ $t("admin.pages.receiving.allocated") }}</th>
                <th>{{ $t("admin.pages.receiving.ctnNo") }}</th>
                <th>{{ $t("admin.pages.receiving.dateCode") }}</th>
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
                    {{ savingItem[item.id] ? $t("admin.common.saving") : $t("admin.common.save") }}
                  </button>
                  <span v-if="savedItem[item.id]" class="muted">{{ $t("admin.pages.receiving.saved") }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-if="order.invoices.length === 0" class="muted">{{ $t("admin.pages.receiving.noInvoices") }}</p>
      <p v-else-if="filteredInvoices.length === 0" class="muted">
        {{ $t("admin.pages.receiving.noInvoicesMatch") }}
      </p>
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
.date-edit {
  display: flex;
  align-items: center;
  gap: 8px;
}
.date-edit input {
  padding: 5px 7px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
</style>
