<script setup lang="ts">
// Shipping list (寄出, spec 2026-11-10-packaging-shipping-steps-design.md):
// ORDER-keyed overview (GET /shipping-orders/by-order) — one row per picking
// order with its ready-to-ship box/cart counts (the clerk thinks in orders,
// not boxes). Read-only: the ship action lives on the picking-order detail
// page (per-order ship); rows link there + to each box's detail (copy
// summary for the delivery provider).
import type { ShippingOrderGroupRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<ShippingOrderGroupRow[]>([]);
const loading = ref(false);
const error = ref("");
const search = ref("");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(q) ||
      (r.customerCode ?? "").toLowerCase().includes(q) ||
      (r.shipTo ?? "").toLowerCase().includes(q) ||
      (r.poNo ?? "").toLowerCase().includes(q) ||
      r.boxIds.some((b) => b.toLowerCase().includes(q))
  );
});

const columnDefs = computed<AdminColumnDef<ShippingOrderGroupRow>[]>(() => [
  { key: "orderNo", label: t("admin.pages.shipping.orderNo") },
  { key: "customerCode", label: t("admin.pages.shipping.customer"), accessor: (r) => r.customerCode ?? "" },
  { key: "shipTo", label: t("admin.pages.shipping.shipTo"), accessor: (r) => r.shipTo ?? "" },
  { key: "poNo", label: t("admin.pages.shipping.poNo"), accessor: (r) => r.poNo ?? "" },
  { key: "boxCount", label: t("admin.pages.shipping.boxCount") },
  { key: "cartCount", label: t("admin.pages.shipping.cartCount"), accessor: (r) => r.cartCount ?? "" },
  { key: "packageCount", label: t("admin.pages.shipping.packages") },
  {
    key: "packaged",
    label: t("admin.pages.shipping.packaged"),
    accessor: (r) => (r.packaged ? 1 : 0),
  },
  { key: "closedAt", label: t("admin.pages.shipping.closedAt") },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "shipping-orders-list",
  columns: columnDefs,
  rows: filtered,
  getRowId: (r) => r.orderId,
});

// Pager uses a 1-based page; the table uses a 0-based pageIndex.
const page = computed({
  get: () => pagination.value.pageIndex + 1,
  set: (v: number) => {
    pagination.value = { ...pagination.value, pageIndex: v - 1 };
  },
});
const pageSize = computed({
  get: () => pagination.value.pageSize,
  set: (v: number) => {
    pagination.value = { pageIndex: 0, pageSize: v };
  },
});
const total = computed(() => filtered.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listShippingOrderGroups();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// Reload when boxes are shipped or orders change elsewhere.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["shipping_box.shipped", "picking_order.updated", "picking.packaged"], load);
</script>

<template>
  <div class="list-fill-page">
    <div class="page-head">
      <h1>{{ $t("admin.pages.shipping.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <div class="filters">
      <input v-model="search" :placeholder="$t('admin.pages.shipping.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />

    <DataTable
      fill
      :loading="loading"
      :table="table"
      :row-id="(r: ShippingOrderGroupRow) => r.orderId"
      :empty-text="$t('admin.pages.shipping.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-orderNo="{ row }">
        <span class="clickable" @click="navigateTo(`/picking-orders/${row.orderId}`)">{{ row.orderNo }}</span>
      </template>
      <template #cell-boxCount="{ row }">
        <span>{{ row.boxCount }}</span>
      </template>
      <template #cell-cartCount="{ row }">{{ row.cartCount ?? "—" }}</template>
      <template #cell-packaged="{ row }">{{ row.packaged ? "✓" : "—" }}</template>
      <template #cell-closedAt="{ row }">{{ formatDateTime(row.lastUpdateDate) }}</template>
      <template #footer>
        <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </template>
    </DataTable>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filters input {
  flex: 1;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
