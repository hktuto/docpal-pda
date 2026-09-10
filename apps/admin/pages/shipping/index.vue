<script setup lang="ts">
import type { ShippingBoxRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<ShippingBoxRow[]>([]);
const loading = ref(false);
const error = ref("");
const search = ref("");
const selected = ref<Set<string>>(new Set());

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.boxId.toLowerCase().includes(q) ||
      r.orderNos.some((o) => o.toLowerCase().includes(q)) ||
      r.shipTos.some((s) => s.toLowerCase().includes(q))
  );
});

const columnDefs = computed<AdminColumnDef<ShippingBoxRow>[]>(() => [
  { key: "boxId", label: t("admin.pages.shipping.boxId") },
  {
    key: "orderNos",
    label: t("admin.pages.shipping.orders"),
    accessor: (r) => r.orderNos.join(", "),
  },
  {
    key: "shipTos",
    label: t("admin.pages.shipping.shipTo"),
    accessor: (r) => r.shipTos.join(", "),
  },
  { key: "destinationCountry", label: t("admin.pages.shipping.destination") },
  { key: "boxSize", label: t("admin.pages.shipping.size") },
  {
    key: "netGross",
    label: t("admin.pages.shipping.netGross"),
    accessor: (r) => r.netWeight ?? "",
  },
  { key: "packageCount", label: t("admin.pages.shipping.packages") },
  { key: "closedAt", label: t("admin.pages.shipping.closedAt") },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "shipping-list",
  columns: columnDefs,
  rows: filtered,
  getRowId: (r) => r.boxId,
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

const selectedIds = computed(() => [...selected.value]);

const shipping = ref(false);

async function markShipped() {
  const ids = selectedIds.value;
  if (ids.length === 0 || shipping.value) return;
  if (!window.confirm(t("admin.pages.shipping.markShippedConfirm", { n: ids.length }))) return;
  shipping.value = true;
  error.value = "";
  try {
    await flow.shipShippingBoxes(ids);
    await load();
  } catch (e: any) {
    // Partial failure: shipShippingBoxes attempts every id and lists the
    // per-box failures (e.g. 409 box_not_ready_to_ship) on `failed`.
    const failed: { id: string; message: string }[] = e?.failed ?? [];
    error.value =
      failed.length > 0
        ? t("admin.pages.shipping.markShippedFailed", {
            boxes: failed.map((f) => `${f.id} (${f.message})`).join(", "),
          })
        : e.message;
    await load();
  } finally {
    shipping.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listShippingBoxes();
    selected.value = new Set();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.shipping.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button
          class="btn"
          :disabled="selectedIds.length === 0 || shipping"
          @click="markShipped"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.shipping.markShippedSelected", { n: selectedIds.length })
              : $t("admin.pages.shipping.markShipped")
          }}
        </button>
        <button
          class="btn"
          :disabled="selectedIds.length === 0"
          :title="$t('admin.pages.shipping.downloadPendingSelected', { n: selectedIds.length })"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.shipping.downloadShipperSelected", { n: selectedIds.length })
              : $t("admin.pages.shipping.downloadShipper")
          }}
        </button>
      </div>
    </div>

    <div class="filters">
      <input v-model="search" :placeholder="$t('admin.pages.shipping.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      v-model:selected="selected"
      :table="table"
      selectable
      :row-id="(r: ShippingBoxRow) => r.boxId"
      :empty-text="$t('admin.pages.shipping.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-boxId="{ row }">
        <span class="clickable" @click="navigateTo(`/shipping/${row.boxId}`)">{{ row.boxId }}</span>
      </template>
      <template #cell-netGross="{ row }">{{ row.netWeight ?? "—" }} / {{ row.grossWeight ?? "—" }}</template>
      <template #cell-closedAt="{ row }">{{ new Date(row.closedAt).toLocaleDateString() }}</template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.filters input {
  flex: 1;
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
