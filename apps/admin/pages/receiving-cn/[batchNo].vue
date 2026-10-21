<script setup lang="ts">
import type { CnOrderDetail, CnOrderItemRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

// CN receiving order detail (receiving_orders_cn + invoices/items/put-away
// task). 404 receiving_cn_order_not_found = the workflow hasn't synced the
// order yet — friendly empty state instead of a crash.

const route = useRoute();
const batchNo = route.params.batchNo as string;
const flow = useFlowApi();
const { t } = useI18n();

const detail = ref<CnOrderDetail | null>(null);
const loading = ref(true);
const notFound = ref(false);
const error = ref("");

const columnDefs = computed<AdminColumnDef<CnOrderItemRow>[]>(() => [
  { key: "invoiceNo", label: t("admin.pages.receivingCn.invoiceNo"), size: 140 },
  { key: "partNo", label: t("admin.pages.receivingCn.itemsTable.partNo"), size: 190 },
  { key: "wclItemNo", label: t("admin.pages.receivingCn.itemsTable.wclItemNo"), size: 140 },
  { key: "poNo", label: t("admin.pages.receivingCn.itemsTable.poNo"), size: 120 },
  { key: "lineQty", label: t("admin.pages.receivingCn.itemsTable.lineQty"), size: 90 },
  { key: "receivedQty", label: t("admin.pages.receivingCn.itemsTable.receivedQty"), size: 90 },
  { key: "putAwayQty", label: t("admin.pages.receivingCn.itemsTable.putAwayQty"), size: 90 },
  { key: "ctnNo", label: t("admin.pages.receivingCn.itemsTable.ctnNo"), size: 80 },
  { key: "dateCode", label: t("admin.pages.receivingCn.itemsTable.dateCode"), size: 90 },
  { key: "lotCode", label: t("admin.pages.receivingCn.itemsTable.lotCode"), size: 90 },
  { key: "coo", label: t("admin.pages.receivingCn.itemsTable.coo"), size: 70 },
  { key: "cow", label: t("admin.pages.receivingCn.itemsTable.cow"), size: 70 },
  { key: "subInventoryCode", label: t("admin.pages.receivingCn.itemsTable.subInventory"), size: 110 },
]);

const items = computed<CnOrderItemRow[]>(() => detail.value?.items ?? []);

const { table, resetColumnState } = useAdminTable<CnOrderItemRow>({
  tableId: "receiving-cn-order-items",
  columns: columnDefs,
  rows: items,
  getRowId: (r) => r.id,
  // One page holds the whole order — the detail has no pager.
  defaultPageSize: 1000,
});

onMounted(async () => {
  loading.value = true;
  error.value = "";
  notFound.value = false;
  try {
    detail.value = await flow.getCnOrder(batchNo);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (message.includes("receiving_cn_order_not_found")) {
      notFound.value = true;
    } else {
      error.value = message;
    }
  } finally {
    loading.value = false;
  }
});

function orderStatusClass(s: string): string {
  return {
    pending: "chip chip-muted",
    in_hand: "chip chip-info",
    clear: "chip chip-ok",
  }[s] ?? "chip";
}

function putAwayStatusClass(s: string): string {
  return {
    pending: "chip chip-info",
    completed: "chip chip-ok",
  }[s] ?? "chip";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receivingCn.detailTitle", { batchNo }) }}</h1>
      <div class="head-actions">
        <button class="btn" @click="navigateTo('/receiving-cn')">{{ $t("admin.common.back") }}</button>
      </div>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>

    <div v-else-if="notFound" class="card not-found">
      <h2>{{ $t("admin.pages.receivingCn.notFoundTitle") }}</h2>
      <p>{{ $t("admin.pages.receivingCn.notFoundBody") }}</p>
      <button class="btn" @click="navigateTo('/receiving-cn')">
        {{ $t("admin.common.back") }}
      </button>
    </div>

    <div v-else-if="error" class="error-banner">{{ error }}</div>

    <template v-else-if="detail">
      <div class="card head-card">
        <div class="head-grid">
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.status") }}:</span>
            <span :class="orderStatusClass(detail.order.status)">{{ $t(`status.receiving.${detail.order.status}`) }}</span>
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.putAway") }}:</span>
            <span v-if="detail.putAway" :class="putAwayStatusClass(detail.putAway.status)">
              {{ $t(`status.putAway.${detail.putAway.status}`) }}
            </span>
            <span v-else>—</span>
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.deliveryDate") }}:</span>
            {{ detail.order.deliveryDate ? formatDate(detail.order.deliveryDate) : "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.arrivedAt") }}:</span>
            {{ detail.order.arrivedAt ? formatDateTime(detail.order.arrivedAt) : "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.arrivedBy") }}:</span>
            {{ detail.order.arrivedBy ?? "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.itemsTable.dateCode") }}:</span>
            {{ detail.order.dateCode ?? "—" }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.pages.receivingCn.org") }}:</span>
            {{ detail.order.orgId }}
          </div>
          <div>
            <span class="dt">{{ $t("admin.fields.createdDate") }}:</span>
            {{ formatDateTime(detail.order.createdDate) }}
          </div>
        </div>
      </div>

      <div class="card">
        <h2>{{ $t("admin.pages.receivingCn.invoices") }}</h2>
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.pages.receivingCn.invoiceNo") }}</th>
              <th>{{ $t("admin.pages.receivingCn.itemsTable.totalQty") }}</th>
              <th>{{ $t("admin.pages.receivingCn.itemsTable.totalCtn") }}</th>
              <th>{{ $t("admin.pages.receivingCn.deliveryDate") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="inv in detail.invoices" :key="inv.id">
              <td>{{ inv.invoiceNo }}</td>
              <td>{{ inv.totalQty ?? "—" }}</td>
              <td>{{ inv.totalCtn ?? "—" }}</td>
              <td>{{ inv.deliveryDate ? formatDate(inv.deliveryDate) : "—" }}</td>
            </tr>
            <tr v-if="detail.invoices.length === 0">
              <td colspan="4" class="muted">{{ $t("admin.common.noRecords") }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>{{ $t("admin.pages.receivingCn.items") }} ({{ detail.items.length }})</h2>
        <DataTable
          :table="table"
          :empty-text="$t('admin.pages.receivingCn.noItems')"
          :on-reset-columns="resetColumnState"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.card {
  margin-bottom: 1rem;
}
.card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}
.head-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.5rem 1rem;
  font-size: 0.875rem;
}
.dt {
  font-weight: 600;
}
.not-found p {
  color: #52606d;
}
.chip {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  white-space: nowrap;
}
.chip-info {
  background: #dbeafe;
  color: #1d4ed8;
}
.chip-ok {
  background: #dcfce7;
  color: #15803d;
}
.chip-muted {
  background: #e5e7eb;
  color: #52606d;
}
</style>
